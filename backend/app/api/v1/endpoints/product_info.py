"""
Product info endpoints.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, require_role
from app.database import get_db
from app.models.product_info import ProductInfo
from app.models.product_sub_product import ProductSubProduct
from app.models.user import User, UserRole
from app.schemas.product_info import (
    ProductInfoCreate,
    ProductInfoRead,
    ProductInfoUpdate,
    SubProductInput,
)

router = APIRouter(prefix="/product-info", tags=["Product Info"])

_SUB_PRODUCTS_OPTIONS = selectinload(ProductInfo.sub_products).selectinload(
    ProductSubProduct.sub_product
)


async def _get_product_or_404(db: AsyncSession, product_id: UUID) -> ProductInfo:
    result = await db.execute(
        select(ProductInfo)
        .options(_SUB_PRODUCTS_OPTIONS)
        .where(ProductInfo.id == product_id)
        .execution_options(populate_existing=True)
    )
    product = result.scalar_one_or_none()
    if not product:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Product not found",
        )
    return product


async def _sync_sub_products(
    db: AsyncSession,
    product: ProductInfo,
    items: list[SubProductInput],
) -> None:
    requested_ids = [item.product_id for item in items]

    if len(requested_ids) != len(set(requested_ids)):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ayni alt urun birden fazla kez eklenemez.",
        )

    if product.id in requested_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Bir urun kendisinin alt urunu olamaz.",
        )

    if requested_ids:
        found_result = await db.execute(
            select(ProductInfo.id).where(ProductInfo.id.in_(requested_ids))
        )
        found_ids = {row[0] for row in found_result.all()}
        missing = set(requested_ids) - found_ids
        if missing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Alt urun bulunamadi: {', '.join(str(m) for m in missing)}",
            )

    await db.execute(
        delete(ProductSubProduct).where(ProductSubProduct.parent_product_id == product.id)
    )
    for item in items:
        db.add(
            ProductSubProduct(
                parent_product_id=product.id,
                sub_product_id=item.product_id,
                quantity=item.quantity,
            )
        )
    await db.flush()


@router.get(
    "/",
    response_model=list[ProductInfoRead],
    summary="List product info master records",
)
async def list_product_info(
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[ProductInfoRead]:
    result = await db.execute(
        select(ProductInfo)
        .options(_SUB_PRODUCTS_OPTIONS)
        .order_by(func.lower(ProductInfo.product_name))
    )
    rows = result.scalars().all()
    return [ProductInfoRead.model_validate(row) for row in rows]


@router.post(
    "/",
    response_model=ProductInfoRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a product info record",
)
async def create_product_info(
    body: ProductInfoCreate,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> ProductInfoRead:
    cleaned_name = body.product_name.strip()
    existing_result = await db.execute(
        select(ProductInfo).where(func.lower(ProductInfo.product_name) == cleaned_name.lower())
    )
    if existing_result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Product already exists",
        )

    product = ProductInfo(
        product_name=cleaned_name,
        supply_days=body.supply_days,
        assembly_days=body.assembly_days,
        delivery_days=body.delivery_days,
        # Efor kaldirildi; kolon NOT NULL oldugu icin sabit 0 yaziliyor.
        effort_weight=0,
        epoxy_minutes=body.epoxy_minutes,
        conformal_minutes=body.conformal_minutes,
        montaj_minutes=body.montaj_minutes,
        quality_minutes=body.quality_minutes,
        montaj_kalite_minutes=body.montaj_kalite_minutes,
        test1_minutes=body.test1_minutes,
        test2_minutes=body.test2_minutes,
        final_test_minutes=body.final_test_minutes,
        duration_mode=body.duration_mode,
        production_flat_days=body.production_flat_days,
        test_flat_days=body.test_flat_days,
        assembly_flat_days=body.assembly_flat_days,
    )
    db.add(product)
    await db.flush()
    await _sync_sub_products(db, product, body.sub_products)
    product = await _get_product_or_404(db, product.id)
    return ProductInfoRead.model_validate(product)


@router.patch(
    "/{product_id}",
    response_model=ProductInfoRead,
    summary="Update a product info record",
)
async def update_product_info(
    product_id: UUID,
    body: ProductInfoUpdate,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> ProductInfoRead:
    product = await _get_product_or_404(db, product_id)

    if body.product_name is not None:
        cleaned_name = body.product_name.strip()
        duplicate_result = await db.execute(
            select(ProductInfo).where(
                func.lower(ProductInfo.product_name) == cleaned_name.lower(),
                ProductInfo.id != product_id,
            )
        )
        if duplicate_result.scalar_one_or_none():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Product already exists",
            )
        product.product_name = cleaned_name

    if body.supply_days is not None:
        product.supply_days = body.supply_days
    if body.assembly_days is not None:
        product.assembly_days = body.assembly_days
    if body.delivery_days is not None:
        product.delivery_days = body.delivery_days
    if body.epoxy_minutes is not None:
        product.epoxy_minutes = body.epoxy_minutes
        product.epoxy_minutes = body.epoxy_minutes
    if body.conformal_minutes is not None:
        product.conformal_minutes = body.conformal_minutes
    if body.montaj_minutes is not None:
        product.montaj_minutes = body.montaj_minutes
    if body.quality_minutes is not None:
        product.quality_minutes = body.quality_minutes
    if body.montaj_kalite_minutes is not None:
        product.montaj_kalite_minutes = body.montaj_kalite_minutes
    if body.test1_minutes is not None:
        product.test1_minutes = body.test1_minutes
    if body.test2_minutes is not None:
        product.test2_minutes = body.test2_minutes
    if body.final_test_minutes is not None:
        product.final_test_minutes = body.final_test_minutes
    if body.duration_mode is not None:
        product.duration_mode = body.duration_mode
    if body.production_flat_days is not None:
        product.production_flat_days = body.production_flat_days
    if body.test_flat_days is not None:
        product.test_flat_days = body.test_flat_days
    if body.assembly_flat_days is not None:
        product.assembly_flat_days = body.assembly_flat_days

    if body.sub_products is not None:
        await _sync_sub_products(db, product, body.sub_products)

    await db.flush()
    product = await _get_product_or_404(db, product_id)
    return ProductInfoRead.model_validate(product)


@router.delete(
    "/{product_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a product info record",
)
async def delete_product_info(
    product_id: UUID,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> None:
    result = await db.execute(select(ProductInfo).where(ProductInfo.id == product_id))
    product = result.scalar_one_or_none()
    if not product:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Product not found",
        )

    usage_result = await db.execute(
        select(ProductSubProduct.id)
        .where(ProductSubProduct.sub_product_id == product_id)
        .limit(1)
    )
    if usage_result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Bu urun baska urunlerin alt urunu olarak kullaniliyor, once ilgili urun tariflerinden cikarin.",
        )

    await db.delete(product)
    await db.flush()