"""
Order API endpoints.
"""

from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_role
from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.enums import AuditAction, OrderStatus
from app.models.order import Order
from app.models.order_serial_number import OrderSerialNumber
from app.models.enums import SerialNumberStage
from app.models.user import User, UserRole
from app.schemas.order import (
    OrderSerialNumberRead,
    OrderSerialNumbersBulkUpdate,
)

router = APIRouter(prefix="/orders", tags=["Orders"])


def _normalize_serial_numbers(values: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for value in values:
        serial_number = str(value).strip()
        if not serial_number or serial_number in seen:
            continue
        normalized.append(serial_number)
        seen.add(serial_number)
    return normalized


async def _get_active_order(db: AsyncSession, order_id: UUID) -> Order:
    result = await db.execute(
        select(Order).where(
            Order.id == order_id,
            Order.is_deleted == False,  # noqa: E712
        )
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Order not found",
        )
    return order


@router.get(
    "/{order_id}/serial-numbers",
    response_model=list[OrderSerialNumberRead],
    summary="List serial numbers for an order",
)
async def list_order_serial_numbers(
    order_id: UUID,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[OrderSerialNumberRead]:
    await _get_active_order(db, order_id)

    result = await db.execute(
        select(OrderSerialNumber)
        .where(OrderSerialNumber.order_id == order_id)
        .order_by(OrderSerialNumber.created_at.asc(), OrderSerialNumber.id.asc())
    )
    return [OrderSerialNumberRead.model_validate(item) for item in result.scalars().all()]


@router.post(
    "/{order_id}/serial-numbers/bulk",
    response_model=list[OrderSerialNumberRead],
    summary="Replace serial numbers for an order",
)
async def replace_order_serial_numbers(
    order_id: UUID,
    body: OrderSerialNumbersBulkUpdate | list[str] = Body(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> list[OrderSerialNumberRead]:
    order = await _get_active_order(db, order_id)

    raw_serial_numbers = body if isinstance(body, list) else body.serial_numbers
    serial_numbers = _normalize_serial_numbers(raw_serial_numbers)
    target_set = set(serial_numbers)

    existing_result = await db.execute(
        select(OrderSerialNumber)
        .where(OrderSerialNumber.order_id == order_id)
        .order_by(OrderSerialNumber.created_at.asc(), OrderSerialNumber.id.asc())
    )
    existing_items = existing_result.scalars().all()
    existing_by_number = {item.serial_number: item for item in existing_items}

    old_values = [
        {"serial_number": item.serial_number, "current_stage": item.current_stage}
        for item in existing_items
    ]

    # Bu endpoint eskiden TÜM mevcut seri numaralarını silip current_stage=SUPPLY
    # ile yeniden oluşturuyordu — RightPanel.tsx (saveSerialNumbers) mevcut +
    # yeni tüm etiketleri tek listede gönderdiği için, kullanıcı TEK bir yeni seri
    # numarası eklediğinde bile daha önce üretimde ilerlemiş TÜM diğer seri
    # numaralarının aşaması sessizce "Tedarik"e sıfırlanıyordu. Artık yalnızca
    # listeden ÇIKARILAN (kullanıcının etiketi sildiği) seri numaraları silinir;
    # listede KALANLARIN current_stage'ine dokunulmaz.
    to_delete = [item for item in existing_items if item.serial_number not in target_set]
    for item in to_delete:
        await db.delete(item)

    created_at_base = datetime.now(timezone.utc)
    new_items: list[OrderSerialNumber] = []
    offset = 0
    for serial_number in serial_numbers:
        if serial_number in existing_by_number:
            continue
        new_items.append(
            OrderSerialNumber(
                order_id=order_id,
                serial_number=serial_number,
                current_stage=SerialNumberStage.SUPPLY.value,
                created_at=created_at_base + timedelta(microseconds=offset),
            )
        )
        offset += 1
    db.add_all(new_items)

    db.add(
        AuditLog(
            entity_type="order",
            entity_id=order_id,
            action=AuditAction.UPDATE.value,
            old_value={"serial_numbers": old_values},
            new_value={
                "serial_numbers": [
                    {
                        "serial_number": value,
                        "current_stage": existing_by_number[value].current_stage
                        if value in existing_by_number
                        else SerialNumberStage.SUPPLY.value,
                    }
                    for value in serial_numbers
                ],
            },
            performed_by=current_user.id,
        )
    )

    await db.flush()

    # Sipariş zaten "Tamamlandı" işaretliyken yeni (henüz tamamlanmamış) bir seri
    # numarası eklenirse artık gerçekte tamamlanmamış demektir — ekranda "Tamamlandı"
    # yazıp seri numaralarının "Tedarik"te göründüğü tutarsız duruma düşülmesin
    # diye statü geri alınır.
    if order.status == OrderStatus.COMPLETED.value and new_items:
        order.status = OrderStatus.APPROVED.value

    for item in new_items:
        await db.refresh(item)

    result = await db.execute(
        select(OrderSerialNumber)
        .where(OrderSerialNumber.order_id == order_id)
        .order_by(OrderSerialNumber.created_at.asc(), OrderSerialNumber.id.asc())
    )
    return [OrderSerialNumberRead.model_validate(item) for item in result.scalars().all()]
