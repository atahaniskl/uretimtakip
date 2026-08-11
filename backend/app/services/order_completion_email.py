"""
Order completion checks and mail notifications.
"""

import logging
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.enums import OrderStatus, SerialNumberStage
from app.models.order import Order
from app.models.order_serial_number import OrderSerialNumber

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class OrderCompletionNotification:
    order_id: UUID
    external_id: str
    customer_name: str | None
    serial_numbers: tuple[str, ...]


def _notification_recipients() -> list[str]:
    raw_recipients = settings.ORDER_COMPLETION_EMAIL_TO or settings.SMTP_EMAIL
    return [
        recipient.strip()
        for recipient in raw_recipients.split(",")
        if recipient.strip()
    ]


async def mark_order_completed_if_all_serials_completed(
    db: AsyncSession,
    order_id: UUID,
) -> OrderCompletionNotification | None:
    """
    Mark an order as completed once every serial number is completed.

    BOM: bir ana siparişin bileşenleri (alt ürünler, parent_order_id ile bağlı)
    de Gantt'ta bağımsız satır olarak kendi seri numaralarını taşıyabilir —
    ana sipariş yalnızca KENDİ seri numaralarına bakarak "Tamamlandı" işaretlenirse,
    bileşenler henüz üretimdeyken bile tamamlanma maili gidebilir. Bu yüzden
    aktif (silinmemiş) her bileşen de kontrol edilir — ama bir bileşene HİÇ seri
    numarası girilmemişse (kullanıcı hiç atamamışsa) o bileşen YOK SAYILIR (seri
    no takibi yapılmayan bileşenler yüzünden ana sipariş sonsuza dek
    "tamamlanamaz" hale gelmesin diye) — yalnızca seri no'su OLAN bileşenlerin
    TÜMÜNÜN tamamlanmış olması aranır.

    Returns notification data only on the first transition to COMPLETED. This
    makes the mail trigger idempotent without adding a separate notification
    table.
    """
    order_result = await db.execute(
        select(Order)
        .where(Order.id == order_id)
        .with_for_update()
    )
    order = order_result.scalar_one_or_none()
    if not order or order.is_deleted or order.status == OrderStatus.COMPLETED.value:
        return None
    if order.parent_order_id is not None:
        # BOM bileşen siparişleri kullanıcıya bağımsız sipariş gibi görünmez —
        # kendi tamamlanma bildirimini asla tetiklemez (ana sipariş A üzerinden takip edilir).
        return None

    result = await db.execute(
        select(OrderSerialNumber)
        .where(OrderSerialNumber.order_id == order_id)
        .order_by(OrderSerialNumber.created_at.asc(), OrderSerialNumber.id.asc())
    )
    serial_numbers = result.scalars().all()
    if not serial_numbers:
        return None

    if any(sn.current_stage != SerialNumberStage.COMPLETED.value for sn in serial_numbers):
        return None

    component_ids_result = await db.execute(
        select(Order.id).where(Order.parent_order_id == order_id, Order.is_deleted == False)  # noqa: E712
    )
    component_ids = [row[0] for row in component_ids_result.all()]
    if component_ids:
        component_serials_result = await db.execute(
            select(OrderSerialNumber.order_id, OrderSerialNumber.current_stage)
            .where(OrderSerialNumber.order_id.in_(component_ids))
        )
        component_stages_by_order: dict[UUID, list[str]] = {}
        for component_order_id, stage in component_serials_result.all():
            component_stages_by_order.setdefault(component_order_id, []).append(stage)
        for stages in component_stages_by_order.values():
            if any(stage != SerialNumberStage.COMPLETED.value for stage in stages):
                return None

    order.status = OrderStatus.COMPLETED.value
    await db.flush()

    return OrderCompletionNotification(
        order_id=order.id,
        external_id=order.external_id,
        customer_name=order.customer_name,
        serial_numbers=tuple(sn.serial_number for sn in serial_numbers),
    )


def send_order_completion_email(notification: OrderCompletionNotification) -> bool:
    """Send the configured order completion mail."""
    recipients = _notification_recipients()
    if not recipients:
        logger.warning("Order completion mail skipped: recipient is not configured")
        return False

    if not settings.SMTP_EMAIL or not settings.SMTP_PASSWORD:
        logger.warning("Order completion mail skipped: SMTP credentials are not configured")
        return False

    customer_line = (
        f"Musteri: {notification.customer_name}\n"
        if notification.customer_name
        else ""
    )
    body = (
        "Merhaba,\n\n"
        f"{notification.external_id} numarali siparis tamamlandi.\n"
        f"{customer_line}"
        f"Tamamlanan seri numarasi adedi: {len(notification.serial_numbers)}\n"
        f"Seri numaralari: {', '.join(notification.serial_numbers)}\n\n"
        "Bu mail Dynamic Production Scheduler tarafindan otomatik gonderilmistir."
    )

    msg = EmailMessage()
    msg["Subject"] = f"Siparis tamamlandi: {notification.external_id}"
    msg["From"] = settings.SMTP_EMAIL
    msg["To"] = ", ".join(recipients)
    msg.set_content(body)

    try:
        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT) as server:
            if settings.SMTP_USE_TLS:
                server.starttls()
            server.login(settings.SMTP_EMAIL, settings.SMTP_PASSWORD)
            server.send_message(msg)
    except Exception:
        logger.exception(
            "Order completion mail failed for order_id=%s",
            notification.order_id,
        )
        return False

    return True
