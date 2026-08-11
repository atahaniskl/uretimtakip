"""
System backup endpoints (ADMIN only).
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_role
from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.enums import AuditAction
from app.models.user import User, UserRole
from app.services.backup_service import backup_service

router = APIRouter(prefix="/backups", tags=["Backups"])


class BackupItem(BaseModel):
    object_name: str
    size: int
    created_at: str | None = None
    category: str = "legacy"


class BackupCreateResponse(BaseModel):
    message: str
    backup: BackupItem


class BackupRestoreRequest(BaseModel):
    object_name: str = Field(..., min_length=5)
    acknowledge_risk: bool = False


class MessageResponse(BaseModel):
    message: str


class RestoreJobResponse(BaseModel):
    job_id: str
    status: str
    object_name: str
    requested_by: str | None = None
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None


class BackupPolicyResponse(BaseModel):
    automation_enabled: bool
    daily_retention: int
    weekly_retention: int
    monthly_retention: int
    manual_retention: int
    daily_hour_utc: int
    weekly_weekday_utc: int
    weekly_hour_utc: int
    monthly_day_utc: int
    monthly_hour_utc: int
    max_hours_without_backup: int
    updated_at: str | None = None


class BackupPolicyUpdateRequest(BaseModel):
    automation_enabled: bool | None = None
    daily_retention: int | None = Field(None, ge=1, le=90)
    weekly_retention: int | None = Field(None, ge=1, le=104)
    monthly_retention: int | None = Field(None, ge=1, le=120)
    manual_retention: int | None = Field(None, ge=1, le=500)
    daily_hour_utc: int | None = Field(None, ge=0, le=23)
    weekly_weekday_utc: int | None = Field(None, ge=0, le=6)
    weekly_hour_utc: int | None = Field(None, ge=0, le=23)
    monthly_day_utc: int | None = Field(None, ge=1, le=28)
    monthly_hour_utc: int | None = Field(None, ge=0, le=23)
    max_hours_without_backup: int | None = Field(None, ge=1, le=168)


class BackupHealthResponse(BaseModel):
    status: str
    warning: bool
    message: str
    last_backup_at: str | None = None
    hours_since_last_backup: float | None = None
    threshold_hours: int


@router.get(
    "/",
    response_model=list[BackupItem],
    summary="List available backups (Admin only)",
)
async def list_backups(
    _current_user: User = Depends(require_role(UserRole.ADMIN)),
) -> list[BackupItem]:
    backups = await backup_service.list_backups()
    return [BackupItem(**b) for b in backups]


@router.get(
    "/policy",
    response_model=BackupPolicyResponse,
    summary="Get backup policy (Admin only)",
)
async def get_backup_policy(
    _current_user: User = Depends(require_role(UserRole.ADMIN)),
) -> BackupPolicyResponse:
    policy = await backup_service.get_policy()
    return BackupPolicyResponse(**policy)


@router.put(
    "/policy",
    response_model=BackupPolicyResponse,
    summary="Update backup policy (Admin only)",
)
async def update_backup_policy(
    body: BackupPolicyUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
) -> BackupPolicyResponse:
    updated = await backup_service.update_policy(body.model_dump(exclude_none=True))

    db.add(
        AuditLog(
            entity_type="system_backup",
            entity_id=uuid.uuid4(),
            action=AuditAction.UPDATE.value,
            old_value=None,
            new_value={"policy_updated": True, **body.model_dump(exclude_none=True)},
            performed_by=current_user.id,
        )
    )

    return BackupPolicyResponse(**updated)


@router.get(
    "/health",
    response_model=BackupHealthResponse,
    summary="Get backup health status (Admin only)",
)
async def get_backup_health(
    _current_user: User = Depends(require_role(UserRole.ADMIN)),
) -> BackupHealthResponse:
    health = await backup_service.get_backup_health()
    return BackupHealthResponse(**health)


@router.post(
    "/create",
    response_model=BackupCreateResponse,
    summary="Create a database backup now (Admin only)",
)
async def create_backup_now(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
) -> BackupCreateResponse:
    try:
        backup = await backup_service.create_backup(reason="manual")
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Backup creation failed: {exc}",
        ) from exc

    db.add(
        AuditLog(
            entity_type="system_backup",
            entity_id=uuid.uuid4(),
            action=AuditAction.BACKUP.value,
            old_value=None,
            new_value={"object_name": backup["object_name"], "size": backup["size"]},
            performed_by=current_user.id,
        )
    )

    return BackupCreateResponse(
        message="Yedekleme tamamlandı",
        backup=BackupItem(
            object_name=backup["object_name"],
            size=backup["size"],
            created_at=backup["created_at"],
        ),
    )


@router.delete(
    "/",
    response_model=MessageResponse,
    summary="Delete a backup file (Admin only)",
)
async def delete_backup(
    object_name: str = Query(..., min_length=5),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
) -> MessageResponse:
    if not object_name.startswith("backups/"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid backup object path",
        )

    try:
        await backup_service.delete_backup_object(object_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Backup delete failed: {exc}",
        ) from exc

    db.add(
        AuditLog(
            entity_type="system_backup",
            entity_id=uuid.uuid4(),
            action=AuditAction.DELETE.value,
            old_value={"object_name": object_name},
            new_value={"deleted": True},
            performed_by=current_user.id,
        )
    )

    return MessageResponse(message="Yedek silindi")


@router.post(
    "/restore",
    response_model=RestoreJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Queue database restore from backup (Admin only)",
)
async def restore_backup(
    body: BackupRestoreRequest,
    current_user: User = Depends(require_role(UserRole.ADMIN)),
) -> RestoreJobResponse:
    if not body.acknowledge_risk:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Risk acknowledgement is required before restore.",
        )

    backups = await backup_service.list_backups()
    exists = any(item["object_name"] == body.object_name for item in backups)
    if not exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Selected backup was not found.",
        )

    job = await backup_service.start_restore_job(
        object_name=body.object_name,
        requested_by=str(current_user.id),
    )

    return RestoreJobResponse(**job)


@router.get(
    "/restore-jobs/{job_id}",
    response_model=RestoreJobResponse,
    summary="Get restore job status (Admin only)",
)
async def get_restore_job(
    job_id: str,
    _current_user: User = Depends(require_role(UserRole.ADMIN)),
) -> RestoreJobResponse:
    job = backup_service.get_restore_job(job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Restore job not found")
    return RestoreJobResponse(**job)
