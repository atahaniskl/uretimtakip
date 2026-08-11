"""
Request/Suggestion/Complaint endpoints.
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_role
from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.enums import AuditAction
from app.models.feedback_item import FeedbackItem
from app.models.user import User, UserRole
from app.schemas.feedback_item import FeedbackItemCreateResponse, FeedbackItemRead
from app.services.minio_service import minio_service

router = APIRouter(prefix="/feedback-items", tags=["Feedback Items"])

ALLOWED_IMAGE_TYPES = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
}
MAX_IMAGE_SIZE = 5 * 1024 * 1024


def _to_read_model(item: FeedbackItem, created_by_username: str | None, checked_by_username: str | None) -> FeedbackItemRead:
    return FeedbackItemRead(
        id=item.id,
        category=item.category,
        description=item.description,
        screenshot_filename=item.screenshot_filename,
        has_screenshot=bool(item.screenshot_object_name),
        created_by=item.created_by,
        created_by_username=created_by_username,
        created_at=item.created_at,
        is_checked=item.is_checked,
        checked_by=item.checked_by,
        checked_by_username=checked_by_username,
        checked_at=item.checked_at,
    )


@router.get("/", response_model=list[FeedbackItemRead], summary="List request/suggestion/complaint items")
async def list_feedback_items(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER, UserRole.VIEWER)),
) -> list[FeedbackItemRead]:
    creator_alias = User.__table__.alias("creator")
    checker_alias = User.__table__.alias("checker")

    query = (
        select(
            FeedbackItem,
            creator_alias.c.username.label("created_by_username"),
            checker_alias.c.username.label("checked_by_username"),
        )
        .join(creator_alias, creator_alias.c.id == FeedbackItem.created_by)
        .outerjoin(checker_alias, checker_alias.c.id == FeedbackItem.checked_by)
    )

    # Everyone sees all items (removed planner privacy filter)

    query = query.order_by(FeedbackItem.is_checked.asc(), FeedbackItem.created_at.desc())

    result = await db.execute(query)
    rows = result.all()
    return [_to_read_model(item, created_name, checked_name) for item, created_name, checked_name in rows]


@router.post(
    "/",
    response_model=FeedbackItemCreateResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create request/suggestion/complaint item",
)
async def create_feedback_item(
    category: str = Form(...),
    description: str = Form(...),
    screenshot: UploadFile | None = File(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER, UserRole.VIEWER)),
) -> FeedbackItemCreateResponse:
    normalized_category = category.strip().upper()
    if normalized_category not in {"REQUEST", "SUGGESTION", "COMPLAINT"}:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid category",
        )

    cleaned_description = description.strip()
    if len(cleaned_description) < 3:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Description must be at least 3 characters",
        )

    screenshot_object_name: str | None = None
    screenshot_filename: str | None = None
    screenshot_content_type: str | None = None

    if screenshot:
        content_type = (screenshot.content_type or "").lower().strip()
        if content_type not in ALLOWED_IMAGE_TYPES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Only PNG, JPG or WEBP images are allowed",
            )

        file_data = await screenshot.read()
        if len(file_data) > MAX_IMAGE_SIZE:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Image size exceeds 5MB limit",
            )

        uploaded_object_name = await minio_service.upload_file(
            file_data=file_data,
            original_filename=screenshot.filename or "feedback-image",
            content_type=content_type,
        )

        screenshot_object_name = uploaded_object_name
        screenshot_filename = screenshot.filename or "screenshot"
        screenshot_content_type = content_type

    item = FeedbackItem(
        category=normalized_category,
        description=cleaned_description,
        screenshot_object_name=screenshot_object_name,
        screenshot_filename=screenshot_filename,
        screenshot_content_type=screenshot_content_type,
        created_by=current_user.id,
    )

    db.add(item)
    await db.flush()
    await db.refresh(item)

    db.add(
        AuditLog(
            entity_type="feedback_item",
            entity_id=item.id,
            action=AuditAction.CREATE.value,
            old_value=None,
            new_value={
                "category": item.category,
                "has_screenshot": bool(item.screenshot_object_name),
            },
            performed_by=current_user.id,
        )
    )

    return FeedbackItemCreateResponse(
        message="Kayit olusturuldu",
        item=_to_read_model(item, current_user.username, None),
    )


@router.patch(
    "/{item_id}/check",
    response_model=FeedbackItemRead,
    summary="Toggle feedback item check status (Admin only)",
)
async def set_feedback_item_check(
    item_id: UUID,
    is_checked: bool = Form(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
) -> FeedbackItemRead:
    result = await db.execute(select(FeedbackItem).where(FeedbackItem.id == item_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Kayit bulunamadi")

    item.is_checked = bool(is_checked)
    if item.is_checked:
        item.checked_by = current_user.id
        item.checked_at = datetime.now(timezone.utc)
    else:
        item.checked_by = None
        item.checked_at = None

    await db.flush()
    await db.refresh(item)

    db.add(
        AuditLog(
            entity_type="feedback_item",
            entity_id=item.id,
            action=AuditAction.UPDATE.value,
            old_value=None,
            new_value={"is_checked": item.is_checked},
            performed_by=current_user.id,
        )
    )

    return _to_read_model(item, None, current_user.username if item.is_checked else None)


@router.get(
    "/{item_id}/screenshot",
    summary="Get screenshot content for a feedback item",
)
async def get_feedback_item_screenshot(
    item_id: UUID,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER, UserRole.VIEWER)),
) -> Response:
    result = await db.execute(select(FeedbackItem).where(FeedbackItem.id == item_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Kayit bulunamadi")
    if not item.screenshot_object_name:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ekran goruntusu bulunamadi")

    try:
        content = await minio_service.download_file(item.screenshot_object_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    return Response(
        content=content,
        media_type=item.screenshot_content_type or "application/octet-stream",
        headers={
            "Content-Disposition": f'inline; filename="{item.screenshot_filename or "screenshot"}"',
            "Cache-Control": "private, max-age=60",
        },
    )