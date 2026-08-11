"""
Shared saved filters API for Gantt filter presets.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.database import get_db
from app.models.saved_filter import SavedFilter
from app.models.user import User
from app.schemas.saved_filter import SavedFilterCreate, SavedFilterRead

router = APIRouter(prefix="/saved-filters", tags=["Saved Filters"])


@router.get("/", response_model=list[SavedFilterRead], summary="List shared saved filters")
async def list_saved_filters(
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[SavedFilterRead]:
    result = await db.execute(
        select(SavedFilter, User.username)
        .join(User, SavedFilter.created_by == User.id)
        .order_by(SavedFilter.created_at.desc(), SavedFilter.name.asc())
    )

    rows = result.all()
    return [
        SavedFilterRead(
            id=saved_filter.id,
            name=saved_filter.name,
            criteria=saved_filter.criteria,
            created_by=saved_filter.created_by,
            created_by_username=username,
            created_at=saved_filter.created_at,
        )
        for saved_filter, username in rows
    ]


@router.post(
    "/",
    response_model=SavedFilterRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a shared saved filter",
)
async def create_saved_filter(
    body: SavedFilterCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SavedFilterRead:
    saved_filter = SavedFilter(
        name=body.name.strip(),
        criteria=body.criteria.model_dump(),
        created_by=current_user.id,
    )

    db.add(saved_filter)
    await db.flush()
    await db.refresh(saved_filter)

    return SavedFilterRead(
        id=saved_filter.id,
        name=saved_filter.name,
        criteria=saved_filter.criteria,
        created_by=saved_filter.created_by,
        created_by_username=current_user.username,
        created_at=saved_filter.created_at,
    )


@router.delete(
    "/{saved_filter_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a shared saved filter",
)
async def delete_saved_filter(
    saved_filter_id: UUID,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    result = await db.execute(select(SavedFilter).where(SavedFilter.id == saved_filter_id))
    saved_filter = result.scalar_one_or_none()

    if not saved_filter:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Saved filter not found",
        )

    await db.delete(saved_filter)
