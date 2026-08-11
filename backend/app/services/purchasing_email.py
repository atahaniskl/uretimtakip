import logging
import smtplib
from email.message import EmailMessage

from app.config import settings

logger = logging.getLogger(__name__)

def send_purchasing_email(rows: list) -> bool:
    """Send an email notification for newly added purchasing rows."""
    raw_recipients = settings.PURCHASING_EMAIL_TO or settings.SMTP_EMAIL
    recipients = [r.strip() for r in raw_recipients.split(",") if r.strip()]

    if not recipients:
        logger.warning("Purchasing mail skipped: recipient is not configured")
        return False

    if not settings.SMTP_EMAIL or not settings.SMTP_PASSWORD:
        logger.warning("Purchasing mail skipped: SMTP credentials are not configured")
        return False

    body_lines = ["Merhaba,\n\nSatın alım tablosuna yeni veri(ler) eklendi:\n"]

    for i, row in enumerate(rows, start=1):
        body_lines.append(f"--- Kayıt {i} ---")
        body_lines.append(f"Satın Alma No: {row.purchaseNo}")
        body_lines.append(f"Tedarikçi: {row.supplier}")
        body_lines.append(f"Ürün: {row.product}")
        body_lines.append(f"Adet: {row.quantity}")
        body_lines.append(f"Müşteri: {row.customer}")
        body_lines.append(f"Birim Fiyat (USD): {row.unitPriceUsd}")
        body_lines.append(f"Toplam Fiyat (USD): {row.totalPriceUsd}")
        body_lines.append("")

    body_lines.append("Bu mail Dynamic Production Scheduler tarafından otomatik gönderilmiştir.")
    body = "\n".join(body_lines)

    msg = EmailMessage()
    msg["Subject"] = "Yeni Satın Alım Kaydı Eklendi"
    msg["From"] = settings.SMTP_EMAIL
    msg["To"] = ", ".join(recipients)
    msg.set_content(body)

    try:
        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT) as server:
            if settings.SMTP_USE_TLS:
                server.starttls()
            server.login(settings.SMTP_EMAIL, settings.SMTP_PASSWORD)
            server.send_message(msg)
        return True
    except Exception:
        logger.exception("Purchasing email failed to send")
        return False
