"""
Test script for order completion email functionality.
Updates all serial numbers of an order to COMPLETED status and triggers email.

Usage:
    python test_order_completion.py
    
Then enter the order number (external_id) when prompted.
"""

import asyncio
import sys
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session_factory, engine, Base
from app.models.enums import OrderStatus, SerialNumberStage
from app.models.order import Order
from app.models.order_serial_number import OrderSerialNumber
from app.models.audit_log import AuditLog, AuditAction
from app.services.order_completion_email import (
    mark_order_completed_if_all_serials_completed,
    send_order_completion_email,
)


async def test_order_completion(order_external_id: str):
    """Test order completion by marking all serials as completed."""
    
    async with async_session_factory() as session:
        print(f"\n📋 Siparişi aranıyor: {order_external_id}")
        
        # Find the order
        order_result = await session.execute(
            select(Order)
            .where(Order.external_id == order_external_id)
        )
        order = order_result.scalar_one_or_none()
        
        if not order:
            print(f"❌ Sipariş bulunamadı: {order_external_id}")
            return
        
        if order.is_deleted:
            print(f"❌ Sipariş silinmiş: {order_external_id}")
            return
        
        print(f"✅ Sipariş bulundu:")
        print(f"   ID: {order.id}")
        print(f"   Müşteri: {order.customer_name or 'N/A'}")
        print(f"   Durum: {order.status}")
        
        # Get all serial numbers for this order
        serial_result = await session.execute(
            select(OrderSerialNumber)
            .where(OrderSerialNumber.order_id == order.id)
            .order_by(OrderSerialNumber.serial_number.asc())
        )
        serials = serial_result.scalars().all()
        
        if not serials:
            print(f"❌ Bu siparişe ait seri numara yok!")
            return
        
        print(f"\n📦 {len(serials)} seri numara bulundu:")
        for sn in serials:
            print(f"   - {sn.serial_number} (şu anki aşama: {sn.current_stage})")
        
        # Update all serials to COMPLETED
        print(f"\n🔄 Tüm seri numaralar 'tamamlandı' olarak işaretleniyor...")
        for sn in serials:
            sn.current_stage = SerialNumberStage.COMPLETED.value
            sn.updated_at = datetime.utcnow()
            
            # Create audit log entry
            # Create audit log entry
            audit_entry = AuditLog(
                action=AuditAction.UPDATE.value,
                entity_type="OrderSerialNumber",
                entity_id=str(sn.id),
                # 'changes' yerine modeldeki alanları kullanıyoruz:
                old_value={"current_stage": sn.current_stage}, # Eski durumu kaydetmek loglama açısından faydalıdır
                new_value={"current_stage": SerialNumberStage.COMPLETED.value}, # Yeni durum
                performed_by=None,  # Scheduler/test process
            )
            session.add(audit_entry)
        
        await session.flush()
        print(f"✅ {len(serials)} seri numara güncellendi")
        
        # Check if order should be marked as completed and trigger email
        print(f"\n📧 Sipariş tamamlanma kontrolü yapılıyor...")
        notification = await mark_order_completed_if_all_serials_completed(
            session, 
            order.id
        )
        
        await session.commit()
        
        if notification:
            print(f"✅ Sipariş tamamlandı olarak işaretlendi!")
            print(f"   Dış ID: {notification.external_id}")
            print(f"   Müşteri: {notification.customer_name or 'N/A'}")
            print(f"   Seri numaraları: {', '.join(notification.serial_numbers)}")
            
            # Send email
            print(f"\n📨 Tamamlama e-postası gönderiliyor...")
            if send_order_completion_email(notification):
                print(f"✅ E-posta başarıyla gönderildi!")
            else:
                print(f"❌ E-posta gönderilemedi (yapılandırma kontrolü yapınız)")
        else:
            print(f"⚠️  Sipariş zaten tamamlanmış veya başka bir durum söz konusu")


async def main():
    """Main entry point."""
    print("=" * 60)
    print("Dynamic Production Scheduler - Sipariş Tamamlama Test")
    print("=" * 60)
    
    # Get order number from user
    order_id = input("\n📝 Sipariş numarasını girin (external_id): ").strip()
    
    if not order_id:
        print("❌ Sipariş numarası gerekli!")
        sys.exit(1)
    
    try:
        await test_order_completion(order_id)
        print("\n✨ Test tamamlandı!\n")
    except Exception as e:
        print(f"\n❌ Hata oluştu: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
