"""
MappingTemplates CRUD API.
MappingTemplates API.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.user import User, UserRole
from app.models.mapping_template import MappingTemplate
from app.models.order import Order
from app.models.delivery_split import DeliverySplit
from app.schemas.mapping_template import (
    MappingTemplateCreate,
    MappingTemplateUpdate,
    MappingTemplateRead,
)
from app.api.deps import get_current_user, require_role

router = APIRouter(prefix="/mapping-templates", tags=["Mapping Templates"])


def _validate_unique_id_config(
    unique_id_strategy: str,
    unique_id_config: dict | None,
    column_map: dict,
) -> None:
    """Shared CREATE/PATCH validation: unique_id_config'in strategy'yle ve
    column_map'in GÜNCEL (nihai) haliyle tutarlı olduğunu doğrular. PATCH
    öncesinde bu yalnızca create'de çalışıyordu — bir template'i column_map
    veya unique_id_config'ini AYRI AYRI (diğerini tekrar göndermeden) PATCH
    ederek, unique_id_config'in artık column_map'te olmayan bir alanı işaret
    ettiği sessizce bozuk bir duruma sokmak mümkündü (her satırda "ID column
    boş" hatasıyla parse'ın tamamen başarısız olmasına yol açar)."""
    if unique_id_strategy == "COLUMN":
        if not unique_id_config or "column" not in unique_id_config:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail='COLUMN strategy requires unique_id_config with "column" key',
            )
        target_col = unique_id_config["column"]
        if target_col not in column_map.values():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"unique_id_config column '{target_col}' must be a mapped system field in column_map",
            )
    elif unique_id_strategy == "HASH":
        if not unique_id_config or "columns" not in unique_id_config:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail='HASH strategy requires unique_id_config with "columns" list',
            )
        for col in unique_id_config["columns"]:
            if col not in column_map.values():
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"Hash column '{col}' must be a mapped system field in column_map",
                )
    else:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unknown unique_id_strategy: {unique_id_strategy}",
        )


@router.get(
    "/",
    response_model=list[MappingTemplateRead],
    summary="List all mapping templates",
)
async def list_mapping_templates(
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[MappingTemplateRead]:
    """Return all mapping templates. Requires authentication."""
    result = await db.execute(
        select(MappingTemplate).order_by(MappingTemplate.name)
    )
    templates = result.scalars().all()
    return [MappingTemplateRead.model_validate(t) for t in templates]


@router.get(
    "/{template_id}",
    response_model=MappingTemplateRead,
    summary="Get a mapping template by ID",
)
async def get_mapping_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> MappingTemplateRead:
    """Return a single mapping template by ID."""
    result = await db.execute(
        select(MappingTemplate).where(MappingTemplate.id == template_id)
    )
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Mapping template not found",
        )
    return MappingTemplateRead.model_validate(template)


@router.post(
    "/",
    response_model=MappingTemplateRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new mapping template",
)
async def create_mapping_template(
    body: MappingTemplateCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> MappingTemplateRead:
    """Create a new mapping template. Requires ADMIN or PLANNER role."""
    # Validate column_map is not empty
    if not body.column_map:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="column_map cannot be empty",
        )

    # Validate unique_id_config matches strategy
    _validate_unique_id_config(body.unique_id_strategy, body.unique_id_config, body.column_map)

    template = MappingTemplate(
        name=body.name,
        column_map=body.column_map,
        unique_id_strategy=body.unique_id_strategy,
        unique_id_config=body.unique_id_config,
        created_by=current_user.id,
    )
    db.add(template)
    await db.flush()
    await db.refresh(template)

    return MappingTemplateRead.model_validate(template)


@router.patch(
    "/{template_id}",
    response_model=MappingTemplateRead,
    summary="Update a mapping template",
)
async def update_mapping_template(
    template_id: UUID,
    body: MappingTemplateUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> MappingTemplateRead:
    """Update a mapping template. Requires ADMIN or PLANNER role."""
    result = await db.execute(
        select(MappingTemplate).where(MappingTemplate.id == template_id)
    )
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Mapping template not found",
        )

    if body.name is not None:
        template.name = body.name
    if body.column_map is not None and not body.column_map:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="column_map cannot be empty",
        )

    # Üçünden (column_map/unique_id_strategy/unique_id_config) EN AZ BİRİ bu
    # istekte gerçekten değiştiriliyorsa, nihai (PATCH sonrası geçerli olacak)
    # halini MEVCUT şablon değerleriyle birleştirip doğrula — aksi halde ikisinden
    # yalnızca biri gönderildiğinde (ör. sadece column_map değiştirilip
    # unique_id_config aynı bırakıldığında) tutarlılık hiç kontrol edilmemiş
    # olurdu. Üçü de dokunulmadıysa (ör. salt isim değişikliği) doğrulamayı hiç
    # ÇALIŞTIRMIYORUZ — create endpoint'inden GEÇMEDEN (ör. gantt.py'deki
    # "System Default" bootstrap'ı gibi) oluşturulmuş, zaten standart-dışı
    # (unique_id_config=None) mevcut şablonların isim gibi ilgisiz alanlarının
    # düzenlenmesini de kilitlemesin diye.
    if body.column_map is not None or body.unique_id_strategy is not None or body.unique_id_config is not None:
        effective_column_map = body.column_map if body.column_map is not None else template.column_map
        effective_strategy = body.unique_id_strategy if body.unique_id_strategy is not None else template.unique_id_strategy
        effective_config = body.unique_id_config if body.unique_id_config is not None else template.unique_id_config
        _validate_unique_id_config(effective_strategy, effective_config, effective_column_map)

    if body.column_map is not None:
        template.column_map = body.column_map
    if body.unique_id_strategy is not None:
        template.unique_id_strategy = body.unique_id_strategy
    if body.unique_id_config is not None:
        template.unique_id_config = body.unique_id_config

    await db.flush()
    await db.refresh(template)

    return MappingTemplateRead.model_validate(template)


@router.delete(
    "/{template_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a mapping template",
)
async def delete_mapping_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> None:
    """Delete a mapping template. Requires ADMIN or PLANNER role."""
    result = await db.execute(
        select(MappingTemplate).where(MappingTemplate.id == template_id)
    )
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Mapping template not found",
        )

    active_delivery_ref = await db.execute(
        select(DeliverySplit.id)
        .join(Order, DeliverySplit.order_id == Order.id)
        .where(
            Order.mapping_template_id == template_id,
            Order.is_deleted == False,  # noqa: E712
            DeliverySplit.is_deleted == False,  # noqa: E712
        )
        .limit(1)
    )
    if active_delivery_ref.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Bu şablona bağlı aktif teslimatlar olduğu için silinemez.",
        )

    deletable_orders_result = await db.execute(
        select(Order).where(
            Order.mapping_template_id == template_id,
        ).options(selectinload(Order.delivery_splits))
    )
    deletable_orders = deletable_orders_result.scalars().all()
    for order in deletable_orders:
        await db.delete(order)

    await db.delete(template)
