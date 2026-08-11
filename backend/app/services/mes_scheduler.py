"""
Background scheduler that polls a dummy MES endpoint and updates serial number stages.
"""
import asyncio
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.database import async_session_factory
from app.config import settings
from app.models.order_serial_number import OrderSerialNumber
from app.models.enums import SerialNumberStage, AuditAction
from app.models.audit_log import AuditLog
from app.services.order_completion_email import (
    mark_order_completed_if_all_serials_completed,
    send_order_completion_email,
)


def _first_base_value(base_data: dict | None, keys: tuple[str, ...]) -> str | None:
    base = base_data or {}
    for key in keys:
        value = base.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


class MesScheduler:
    def __init__(self, interval_seconds: int = 60, dummy_url: Optional[str] = None):
        self.interval = interval_seconds
        self._task: asyncio.Task | None = None
        self._running = False
        self.dummy_url = dummy_url or settings.MES_STATUS_URL

    async def start(self):
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _loop(self):
        while self._running:
            try:
                updated = await self._run_once()
                # Use print for now; main app logging can capture stdout
                print(f"Scheduler çalıştı, {updated} seri numarası güncellendi")
            except Exception as e:
                print(f"Scheduler hata: {e}")
            await asyncio.sleep(self.interval)

    async def _run_once(self) -> int:
        updated_count = 0
        checked_count = 0
        completed_order_ids = set()
        async with async_session_factory() as session:
            try:
                import httpx
            except ImportError:
                print("Scheduler hata: httpx paketi bulunamadı")
                return 0

            # Load serial numbers not completed, eagerly loading their Order relationship
            stmt = (
                select(OrderSerialNumber)
                .options(selectinload(OrderSerialNumber.order))
                .where(OrderSerialNumber.current_stage != SerialNumberStage.COMPLETED.value)
                .order_by(OrderSerialNumber.created_at.asc())
            )
            result = await session.execute(stmt)
            serials = result.scalars().all()

            async with httpx.AsyncClient(timeout=10.0) as client:
                for sn in serials:
                    base_data = getattr(getattr(sn, "order", None), "base_data", None)
                    product_code = _first_base_value(
                        base_data,
                        ("product_model_no", "product_model", "model_no", "model_number", "product_code", "product_name"),
                    )

                    params = {
                        "product_model_no": product_code,
                        "product_code": product_code,
                        "serial_number": sn.serial_number,
                    }
                    try:
                        resp = await client.get(self.dummy_url, params=params)
                        resp.raise_for_status()
                        data = resp.json()
                        new_stage = data.get("status")
                        valid_stages = {stage.value for stage in SerialNumberStage}
                        if new_stage in valid_stages:
                            sn.updated_at = datetime.now(timezone.utc)
                            checked_count += 1
                        if new_stage in valid_stages and new_stage != sn.current_stage:
                            old_stage = sn.current_stage
                            sn.current_stage = new_stage
                            session.add(
                                AuditLog(
                                    entity_type="serial_number",
                                    entity_id=sn.id,
                                    action=AuditAction.UPDATE.value,
                                    old_value={"current_stage": old_stage},
                                    new_value={"current_stage": new_stage},
                                    performed_by=None,
                                )
                            )
                            if new_stage == SerialNumberStage.COMPLETED.value:
                                completed_order_ids.add(sn.order_id)
                            updated_count += 1
                    except Exception:
                        # ignore errors per-serial to keep loop robust
                        continue

            if checked_count:
                notifications = []
                for order_id in completed_order_ids:
                    notification = await mark_order_completed_if_all_serials_completed(
                        session,
                        order_id,
                    )
                    if notification:
                        notifications.append(notification)

                await session.commit()
                for notification in notifications:
                    send_order_completion_email(notification)

        return updated_count


# Module-level singleton used by app.main
mes_scheduler = MesScheduler(interval_seconds=settings.MES_POLL_INTERVAL_SECONDS)
