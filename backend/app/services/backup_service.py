"""
Database backup service.
Handles manual and automatic PostgreSQL backups stored in MinIO.
"""

import asyncio
import calendar
import logging
import os
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import select

from app.config import settings
from app.database import async_session_factory
from app.models.backup_policy import BackupPolicy
from app.services.minio_service import minio_service

logger = logging.getLogger(__name__)


class BackupService:
    """Manages DB backup/restore and periodic backup loop."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._loop_task: asyncio.Task | None = None
        self._restore_jobs: dict[str, dict[str, Any]] = {}

    async def _get_or_create_policy(self) -> BackupPolicy:
        """Load singleton backup policy row, creating default one if missing."""
        async with async_session_factory() as session:
            result = await session.execute(select(BackupPolicy).limit(1))
            policy = result.scalar_one_or_none()
            if policy is None:
                policy = BackupPolicy(id=1)
                session.add(policy)
                await session.commit()
                await session.refresh(policy)
            return policy

    async def get_policy(self) -> dict:
        """Return current backup policy as serializable dict."""
        policy = await self._get_or_create_policy()
        return {
            "automation_enabled": policy.automation_enabled,
            "daily_retention": policy.daily_retention,
            "weekly_retention": policy.weekly_retention,
            "monthly_retention": policy.monthly_retention,
            "manual_retention": policy.manual_retention,
            "daily_hour_utc": policy.daily_hour_utc,
            "weekly_weekday_utc": policy.weekly_weekday_utc,
            "weekly_hour_utc": policy.weekly_hour_utc,
            "monthly_day_utc": policy.monthly_day_utc,
            "monthly_hour_utc": policy.monthly_hour_utc,
            "max_hours_without_backup": policy.max_hours_without_backup,
            "updated_at": policy.updated_at.astimezone(timezone.utc).isoformat() if policy.updated_at else None,
        }

    async def update_policy(self, values: dict) -> dict:
        """Update backup policy fields from admin UI."""
        allowed_keys = {
            "automation_enabled",
            "daily_retention",
            "weekly_retention",
            "monthly_retention",
            "manual_retention",
            "daily_hour_utc",
            "weekly_weekday_utc",
            "weekly_hour_utc",
            "monthly_day_utc",
            "monthly_hour_utc",
            "max_hours_without_backup",
        }

        async with async_session_factory() as session:
            result = await session.execute(select(BackupPolicy).limit(1))
            policy = result.scalar_one_or_none()
            if policy is None:
                policy = BackupPolicy(id=1)
                session.add(policy)

            for key, value in values.items():
                if key in allowed_keys and value is not None:
                    setattr(policy, key, value)

            # Basic hard boundaries for stable scheduling.
            policy.daily_retention = max(1, min(policy.daily_retention, 90))
            policy.weekly_retention = max(1, min(policy.weekly_retention, 104))
            policy.monthly_retention = max(1, min(policy.monthly_retention, 120))
            policy.manual_retention = max(1, min(policy.manual_retention, 500))

            policy.daily_hour_utc = max(0, min(policy.daily_hour_utc, 23))
            policy.weekly_weekday_utc = max(0, min(policy.weekly_weekday_utc, 6))
            policy.weekly_hour_utc = max(0, min(policy.weekly_hour_utc, 23))
            policy.monthly_day_utc = max(1, min(policy.monthly_day_utc, 28))
            policy.monthly_hour_utc = max(0, min(policy.monthly_hour_utc, 23))
            policy.max_hours_without_backup = max(1, min(policy.max_hours_without_backup, 168))

            await session.commit()
            await session.refresh(policy)

            return {
                "automation_enabled": policy.automation_enabled,
                "daily_retention": policy.daily_retention,
                "weekly_retention": policy.weekly_retention,
                "monthly_retention": policy.monthly_retention,
                "manual_retention": policy.manual_retention,
                "daily_hour_utc": policy.daily_hour_utc,
                "weekly_weekday_utc": policy.weekly_weekday_utc,
                "weekly_hour_utc": policy.weekly_hour_utc,
                "monthly_day_utc": policy.monthly_day_utc,
                "monthly_hour_utc": policy.monthly_hour_utc,
                "max_hours_without_backup": policy.max_hours_without_backup,
                "updated_at": policy.updated_at.astimezone(timezone.utc).isoformat() if policy.updated_at else None,
            }

    def _db_conn_params(self) -> dict[str, str]:
        """Build PostgreSQL CLI connection params from settings."""
        raw_url = settings.DATABASE_URL.replace("+asyncpg", "")
        parsed = urlparse(raw_url)

        host = parsed.hostname or "postgres"
        port = str(parsed.port or settings.POSTGRES_PORT)
        dbname = (parsed.path or "").lstrip("/") or settings.POSTGRES_DB
        username = parsed.username or settings.POSTGRES_USER
        password = parsed.password or settings.POSTGRES_PASSWORD

        return {
            "host": host,
            "port": port,
            "dbname": dbname,
            "username": username,
            "password": password,
        }

    async def _run_command(
        self,
        command: list[str],
        env: dict[str, str] | None = None,
        timeout_seconds: int | None = None,
    ) -> bytes:
        """Execute a shell command asynchronously and return stdout on success."""
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )

        try:
            if timeout_seconds and timeout_seconds > 0:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=timeout_seconds,
                )
            else:
                stdout, stderr = await process.communicate()
        except asyncio.TimeoutError as exc:
            process.kill()
            await process.wait()
            raise RuntimeError(
                f"Command timed out after {timeout_seconds} seconds: {' '.join(command)}"
            ) from exc

        if process.returncode != 0:
            err_text = stderr.decode("utf-8", errors="ignore").strip()
            raise RuntimeError(err_text or f"Command failed: {' '.join(command)}")
        return stdout

    def _sanitize_restore_sql(self, dump_bytes: bytes) -> bytes:
        """Remove SQL settings not supported by older PostgreSQL servers."""
        text = dump_bytes.decode("utf-8", errors="ignore")
        filtered_lines: list[str] = []
        for line in text.splitlines():
            line_lc = line.strip().lower()
            if line_lc.startswith("set transaction_timeout"):
                continue
            filtered_lines.append(line)
        return ("\n".join(filtered_lines) + "\n").encode("utf-8")

    async def _terminate_active_db_sessions(self, conn: dict[str, str], env: dict[str, str]) -> None:
        """Terminate active sessions on target DB to reduce lock/wait issues during restore."""
        escaped_db = conn["dbname"].replace("'", "''")
        sql = (
            "SELECT pg_terminate_backend(pid) "
            "FROM pg_stat_activity "
            f"WHERE datname = '{escaped_db}' "
            "AND pid <> pg_backend_pid();"
        )
        command = [
            "psql",
            "-X",
            "-v",
            "ON_ERROR_STOP=1",
            "-w",
            "-h",
            conn["host"],
            "-p",
            conn["port"],
            "-U",
            conn["username"],
            "-d",
            "postgres",
            "-c",
            sql,
        ]
        await self._run_command(
            command=command,
            env=env,
            timeout_seconds=max(20, settings.BACKUP_RESTORE_TIMEOUT_SECONDS // 2),
        )

    async def create_backup(self, reason: str = "manual") -> dict:
        """Create a SQL backup via pg_dump and upload to MinIO."""
        async with self._lock:
            conn = self._db_conn_params()
            env = {**os.environ, "PGPASSWORD": conn["password"]}
            command = [
                "pg_dump",
                "--clean",
                "--if-exists",
                "--no-owner",
                "--no-privileges",
                "-w",
                "-h",
                conn["host"],
                "-p",
                conn["port"],
                "-U",
                conn["username"],
                "-d",
                conn["dbname"],
            ]

            dump_bytes = await self._run_command(command=command, env=env)

            now = datetime.now(timezone.utc)
            backup_name = f"{reason}_{now.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}.sql"
            object_name = await minio_service.upload_backup(dump_bytes, backup_name)

            backups = await minio_service.list_backups()
            policy = await self.get_policy()
            await self._enforce_retention(backups, policy)

            return {
                "object_name": object_name,
                "size": len(dump_bytes),
                "created_at": now.isoformat(),
                "reason": reason,
            }

    def _category_from_name(self, object_name: str) -> str:
        """Infer backup category from object name prefix."""
        base_name = object_name.split("/")[-1]
        if base_name.startswith("auto_daily_"):
            return "daily"
        if base_name.startswith("auto_weekly_"):
            return "weekly"
        if base_name.startswith("auto_monthly_"):
            return "monthly"
        if base_name.startswith("manual_"):
            return "manual"
        if base_name.startswith("auto_recovery_"):
            return "manual"
        return "legacy"

    async def _enforce_retention(self, backups: list[dict], policy: dict) -> None:
        """Delete old backups per category retention policy."""
        buckets: dict[str, list[dict]] = {
            "daily": [],
            "weekly": [],
            "monthly": [],
            "manual": [],
        }

        for item in backups:
            category = self._category_from_name(item["object_name"])
            if category in buckets:
                buckets[category].append(item)

        limits = {
            "daily": max(1, int(policy["daily_retention"])),
            "weekly": max(1, int(policy["weekly_retention"])),
            "monthly": max(1, int(policy["monthly_retention"])),
            "manual": max(1, int(policy["manual_retention"])),
        }

        for category, items in buckets.items():
            limit = limits[category]
            if len(items) <= limit:
                continue
            for old in items[limit:]:
                try:
                    await minio_service.delete_backup(old["object_name"])
                except Exception as exc:
                    logger.warning("Could not delete old %s backup %s: %s", category, old["object_name"], exc)

    async def list_backups(self) -> list[dict]:
        """List available backup files in MinIO."""
        backups = await minio_service.list_backups()
        result: list[dict] = []
        for item in backups:
            last_modified = item["last_modified"]
            result.append(
                {
                    "object_name": item["object_name"],
                    "size": item["size"],
                    "created_at": last_modified.astimezone(timezone.utc).isoformat() if last_modified else None,
                    "category": self._category_from_name(item["object_name"]),
                }
            )
        return result

    async def delete_backup_object(self, object_name: str) -> None:
        """Delete a backup object from storage."""
        await minio_service.delete_backup(object_name)

    async def get_backup_health(self) -> dict:
        """Return backup freshness status used by admin warnings."""
        backups = await self.list_backups()
        policy = await self.get_policy()

        now = datetime.now(timezone.utc)
        latest = backups[0] if backups else None
        latest_dt = datetime.fromisoformat(latest["created_at"]) if latest and latest["created_at"] else None

        if latest_dt is None:
            return {
                "status": "warning",
                "warning": True,
                "message": "Henüz hiç yedek bulunmuyor. Manuel yedek alın.",
                "last_backup_at": None,
                "hours_since_last_backup": None,
                "threshold_hours": policy["max_hours_without_backup"],
            }

        delta_hours = (now - latest_dt).total_seconds() / 3600
        threshold = float(policy["max_hours_without_backup"])
        warning = delta_hours >= threshold

        return {
            "status": "warning" if warning else "ok",
            "warning": warning,
            "message": (
                "Son 24 saatte otomatik yedek alınamadı. Manuel yedek alın."
                if warning
                else "Yedekleme durumu normal."
            ),
            "last_backup_at": latest["created_at"],
            "hours_since_last_backup": round(delta_hours, 2),
            "threshold_hours": policy["max_hours_without_backup"],
        }

    async def restore_backup(self, object_name: str) -> None:
        """Restore database from a MinIO backup object using psql."""
        async with self._lock:
            conn = self._db_conn_params()
            env = {**os.environ, "PGPASSWORD": conn["password"]}

            data = await minio_service.download_file(object_name)
            data = self._sanitize_restore_sql(data)

            fd, temp_path = tempfile.mkstemp(prefix="dps_restore_", suffix=".sql")
            try:
                with os.fdopen(fd, "wb") as temp_file:
                    temp_file.write(data)

                command = [
                    "psql",
                    "-X",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-w",
                    "-h",
                    conn["host"],
                    "-p",
                    conn["port"],
                    "-U",
                    conn["username"],
                    "-d",
                    conn["dbname"],
                    "-f",
                    temp_path,
                ]
                await self._run_command(
                    command=command,
                    env=env,
                    timeout_seconds=settings.BACKUP_RESTORE_TIMEOUT_SECONDS,
                )

                # Apply compatibility fixes when restoring older backups.
                await self._run_post_restore_schema_fixes(conn=conn, env=env)
            finally:
                try:
                    os.remove(temp_path)
                except OSError:
                    pass

    async def _run_post_restore_schema_fixes(self, conn: dict[str, str], env: dict[str, str]) -> None:
        """Ensure critical columns required by current app version exist after restore."""
        sql = """
        ALTER TABLE IF EXISTS users
        ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT TRUE;

        UPDATE users
        SET is_approved = TRUE
        WHERE is_approved IS NULL;

        ALTER TABLE IF EXISTS users
        ALTER COLUMN is_approved SET DEFAULT TRUE;

        ALTER TABLE IF EXISTS users
        ALTER COLUMN is_approved SET NOT NULL;
        """

        command = [
            "psql",
            "-X",
            "-v",
            "ON_ERROR_STOP=1",
            "-w",
            "-h",
            conn["host"],
            "-p",
            conn["port"],
            "-U",
            conn["username"],
            "-d",
            conn["dbname"],
            "-c",
            sql,
        ]

        await self._run_command(
            command=command,
            env=env,
            timeout_seconds=max(20, settings.BACKUP_RESTORE_TIMEOUT_SECONDS // 2),
        )

    def get_restore_job(self, job_id: str) -> dict | None:
        """Return restore job status by id."""
        return self._restore_jobs.get(job_id)

    async def start_restore_job(self, object_name: str, requested_by: str | None = None) -> dict:
        """Start restore in background and return queued job info."""
        job_id = uuid.uuid4().hex
        now = datetime.now(timezone.utc).isoformat()
        self._restore_jobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "object_name": object_name,
            "requested_by": requested_by,
            "created_at": now,
            "started_at": None,
            "finished_at": None,
            "error": None,
        }

        asyncio.create_task(self._run_restore_job(job_id))
        return self._restore_jobs[job_id]

    async def _run_restore_job(self, job_id: str) -> None:
        """Execute a queued restore job and persist status in memory."""
        job = self._restore_jobs.get(job_id)
        if not job:
            return

        job["status"] = "running"
        job["started_at"] = datetime.now(timezone.utc).isoformat()
        try:
            await self.restore_backup(object_name=job["object_name"])
            job["status"] = "completed"
            job["error"] = None
        except Exception as exc:
            job["status"] = "failed"
            job["error"] = str(exc)
            logger.exception("Restore job failed (%s): %s", job_id, exc)
        finally:
            job["finished_at"] = datetime.now(timezone.utc).isoformat()

    async def start_automation(self) -> None:
        """Start background periodic backup loop if enabled."""
        if not settings.BACKUP_AUTOMATION_ENABLED:
            return
        if self._loop_task and not self._loop_task.done():
            return
        self._loop_task = asyncio.create_task(self._automation_loop())

    async def stop_automation(self) -> None:
        """Stop periodic backup loop."""
        if self._loop_task and not self._loop_task.done():
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass

    async def _automation_loop(self) -> None:
        tick_seconds = 300
        logger.info("Backup automation started. Tick interval: %s seconds", tick_seconds)
        while True:
            try:
                await self._run_automation_tick()
                await asyncio.sleep(tick_seconds)
            except asyncio.CancelledError:
                logger.info("Backup automation stopped")
                raise
            except Exception as exc:
                logger.exception("Automatic backup failed: %s", exc)
                await asyncio.sleep(tick_seconds)

    async def _run_automation_tick(self) -> None:
        """Create scheduled backups when due and enforce recovery fallback."""
        policy = await self.get_policy()
        if not policy["automation_enabled"]:
            return

        now = datetime.now(timezone.utc)
        backups = await self.list_backups()

        async def has_category_since(category: str, since_dt: datetime) -> bool:
            for backup in backups:
                if backup.get("category") != category:
                    continue
                created = backup.get("created_at")
                if not created:
                    continue
                created_dt = datetime.fromisoformat(created)
                if created_dt >= since_dt:
                    return True
            return False

        # Daily schedule
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        daily_due = now >= day_start + timedelta(hours=int(policy["daily_hour_utc"]))
        if daily_due and not await has_category_since("daily", day_start):
            await self.create_backup(reason="auto_daily")
            logger.info("Automatic daily backup created")
            return

        # Weekly schedule
        week_start = day_start - timedelta(days=day_start.weekday())
        weekly_due_at = week_start + timedelta(days=int(policy["weekly_weekday_utc"]), hours=int(policy["weekly_hour_utc"]))
        if now >= weekly_due_at and not await has_category_since("weekly", week_start):
            await self.create_backup(reason="auto_weekly")
            logger.info("Automatic weekly backup created")
            return

        # Monthly schedule
        month_start = day_start.replace(day=1)
        month_day = min(int(policy["monthly_day_utc"]), calendar.monthrange(now.year, now.month)[1])
        monthly_due_at = month_start.replace(day=month_day) + timedelta(hours=int(policy["monthly_hour_utc"]))
        if now >= monthly_due_at and not await has_category_since("monthly", month_start):
            await self.create_backup(reason="auto_monthly")
            logger.info("Automatic monthly backup created")
            return

        # Safety net: if nothing was saved for too long, force a recovery backup.
        threshold_hours = float(policy["max_hours_without_backup"])
        latest_created = backups[0]["created_at"] if backups else None
        if latest_created is None:
            await self.create_backup(reason="auto_recovery")
            logger.warning("No backups found. Recovery backup created")
            return

        latest_dt = datetime.fromisoformat(latest_created)
        if (now - latest_dt).total_seconds() / 3600 >= threshold_hours:
            await self.create_backup(reason="auto_recovery")
            logger.warning("Backup freshness threshold exceeded. Recovery backup created")


backup_service = BackupService()
