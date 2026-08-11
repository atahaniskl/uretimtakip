"""
Serial Numbers API — Track production stages by serial number per order.
"""

from uuid import UUID
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.user import User
from app.models.order import Order
from app.models.order_serial_number import OrderSerialNumber
from app.models.audit_log import AuditLog
from app.models.enums import SerialNumberStage, AuditAction
from app.api.deps import get_current_user, require_role
from app.models.user import UserRole
from app.services.order_completion_email import (
    mark_order_completed_if_all_serials_completed,
    send_order_completion_email,
)

router = APIRouter(
    prefix="/serial-numbers",
    tags=["serial-numbers"],
    dependencies=[Depends(get_current_user)],
)


class SerialNumberOut(BaseModel):
    """Serial number representation."""
    id: UUID
    order_id: UUID
    serial_number: str
    current_stage: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class SerialNumberStatusRow(BaseModel):
    """Serial number status with related order and product fields."""
    id: UUID
    order_id: UUID
    external_id: str
    customer_name: str | None = None
    product_model_no: str | None = None
    product_name: str | None = None
    serial_number: str
    current_stage: str
    created_at: datetime
    updated_at: datetime


class SerialNumberStatusListResponse(BaseModel):
    """Spreadsheet-style serial number status response."""
    rows: list[SerialNumberStatusRow]
    total: int


class SerialNumberStageUpdate(BaseModel):
    """Update serial number stage."""
    current_stage: str


class SerialNumbersListResponse(BaseModel):
    """List of serial numbers for an order."""
    order_id: UUID
    serial_numbers: list[SerialNumberOut]
    total: int


def _first_base_value(base_data: dict | None, keys: tuple[str, ...]) -> str | None:
    base = base_data or {}
    for key in keys:
        value = base.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def _build_product_model_no(order: Order) -> str | None:
    return _first_base_value(
        order.base_data,
        ("product_model_no", "product_model", "model_no", "model_number", "product_code", "urun_model_no", "urun_kodu"),
    )


def _build_product_name(order: Order) -> str | None:
    return _first_base_value(order.base_data, ("product_name", "name", "description", "urun", "ürün"))


@router.get(
    "/",
    response_model=SerialNumbersListResponse,
    summary="List serial numbers for an order",
)
async def list_serial_numbers(
    order_id: UUID = Query(..., description="Order ID"),
    include_completed: bool = Query(True, description="Include completed serial numbers"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SerialNumbersListResponse:
    """Get all serial numbers for a specific order."""
    # Verify order exists
    order_result = await db.execute(select(Order).where(Order.id == order_id))
    order = order_result.scalar_one_or_none()
    if not order:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Order not found",
        )

    # Fetch serial numbers
    query = select(OrderSerialNumber).where(OrderSerialNumber.order_id == order_id)
    if not include_completed:
        query = query.where(OrderSerialNumber.current_stage != SerialNumberStage.COMPLETED.value)
    
    query = query.order_by(OrderSerialNumber.created_at.asc())
    result = await db.execute(query)
    serial_numbers = result.scalars().all()

    return SerialNumbersListResponse(
        order_id=order_id,
        serial_numbers=[SerialNumberOut.model_validate(sn) for sn in serial_numbers],
        total=len(serial_numbers),
    )


@router.get(
    "/status-query",
    response_model=SerialNumberStatusListResponse,
    summary="List serial number statuses with order details",
)
async def list_serial_number_statuses(
    include_deleted: bool = Query(False, description="Include deleted orders"),
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> SerialNumberStatusListResponse:
    """Return serial number stages for the Durum Sorgulama table."""
    query = (
        select(OrderSerialNumber)
        .join(Order, Order.id == OrderSerialNumber.order_id)
        .options(selectinload(OrderSerialNumber.order))
    )
    if not include_deleted:
        query = query.where(Order.is_deleted == False)  # noqa: E712

    result = await db.execute(
        query.order_by(OrderSerialNumber.updated_at.desc(), OrderSerialNumber.created_at.desc())
    )
    serial_numbers = result.scalars().all()

    rows = [
        SerialNumberStatusRow(
            id=sn.id,
            order_id=sn.order_id,
            external_id=sn.order.external_id,
            customer_name=sn.order.customer_name,
            product_model_no=_build_product_model_no(sn.order),
            product_name=_build_product_name(sn.order),
            serial_number=sn.serial_number,
            current_stage=sn.current_stage,
            created_at=sn.created_at,
            updated_at=sn.updated_at,
        )
        for sn in serial_numbers
        if sn.order is not None
    ]

    return SerialNumberStatusListResponse(rows=rows, total=len(rows))


@router.get(
    "/{serial_number_id}",
    response_model=SerialNumberOut,
    summary="Get a specific serial number",
)
async def get_serial_number(
    serial_number_id: UUID,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> SerialNumberOut:
    """Get details of a specific serial number."""
    result = await db.execute(
        select(OrderSerialNumber).where(OrderSerialNumber.id == serial_number_id)
    )
    serial_number = result.scalar_one_or_none()
    if not serial_number:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Serial number not found",
        )

    return SerialNumberOut.model_validate(serial_number)


@router.patch(
    "/{serial_number_id}",
    response_model=SerialNumberOut,
    summary="Update serial number stage",
)
async def update_serial_number_stage(
    serial_number_id: UUID,
    body: SerialNumberStageUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> SerialNumberOut:
    """Update the current production stage of a serial number."""
    # Validate stage
    valid_stages = [stage.value for stage in SerialNumberStage]
    if body.current_stage not in valid_stages:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid stage. Must be one of: {', '.join(valid_stages)}",
        )

    # Get serial number
    result = await db.execute(
        select(OrderSerialNumber).where(OrderSerialNumber.id == serial_number_id)
    )
    serial_number = result.scalar_one_or_none()
    if not serial_number:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Serial number not found",
        )

    old_stage = serial_number.current_stage
    serial_number.current_stage = body.current_stage
    await db.flush()

    # Audit log
    audit = AuditLog(
        entity_type="serial_number",
        entity_id=serial_number.id,
        action=AuditAction.UPDATE.value,
        old_value={"current_stage": old_stage},
        new_value={"current_stage": body.current_stage},
        performed_by=current_user.id,
    )
    db.add(audit)
    notification = None
    if body.current_stage == SerialNumberStage.COMPLETED.value:
        notification = await mark_order_completed_if_all_serials_completed(
            db,
            serial_number.order_id,
        )

    await db.commit()
    await db.refresh(serial_number)
    if notification:
        send_order_completion_email(notification)

    return SerialNumberOut.model_validate(serial_number)


@router.patch(
    "/bulk/update-stage",
    response_model=dict,
    summary="Bulk update serial numbers stage",
)
async def bulk_update_serial_numbers_stage(
    order_id: UUID = Query(..., description="Order ID to update serial numbers for"),
    target_stage: str = Query(..., description="Target production stage"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> dict:
    """Bulk update all serial numbers of an order to a target stage."""
    # Validate stage
    valid_stages = [stage.value for stage in SerialNumberStage]
    if target_stage not in valid_stages:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid stage. Must be one of: {', '.join(valid_stages)}",
        )

    # Verify order exists
    order_result = await db.execute(select(Order).where(Order.id == order_id))
    order = order_result.scalar_one_or_none()
    if not order:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Order not found",
        )

    # Get all serial numbers for this order
    result = await db.execute(
        select(OrderSerialNumber).where(OrderSerialNumber.order_id == order_id)
    )
    serial_numbers = result.scalars().all()

    if not serial_numbers:
        return {
            "order_id": str(order_id),
            "updated_count": 0,
            "message": "No serial numbers found for this order",
        }

    # Update all serial numbers
    updated_count = 0
    for sn in serial_numbers:
        if sn.current_stage != target_stage:
            old_stage = sn.current_stage
            sn.current_stage = target_stage
            updated_count += 1

            # Audit log
            audit = AuditLog(
                entity_type="serial_number",
                entity_id=sn.id,
                action=AuditAction.UPDATE.value,
                old_value={"current_stage": old_stage},
                new_value={"current_stage": target_stage},
                performed_by=current_user.id,
            )
            db.add(audit)

    notification = None
    if target_stage == SerialNumberStage.COMPLETED.value:
        notification = await mark_order_completed_if_all_serials_completed(db, order_id)

    await db.commit()
    if notification:
        send_order_completion_email(notification)

    return {
        "order_id": str(order_id),
        "updated_count": updated_count,
        "target_stage": target_stage,
        "message": f"Updated {updated_count} serial numbers",
    }
