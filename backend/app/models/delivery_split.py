"""
DeliverySplit model — Delivery_Splits (Child) Table.
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, Float, DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.enums import OrderStatus


class DeliverySplit(Base):
    __tablename__ = "delivery_splits"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("orders.id"),
        nullable=False,
        index=True,
    )
    source_main_split_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("delivery_splits.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
        comment="Bu split bir BOM bilesen (component) siparisine aitse, hangi ANA "
        "siparis split'ini besledigini gosterir — parca-bazli component_ready_at "
        "esleme ve otomatik-yeniden-bolme icin. Ana siparisin kendi split'lerinde "
        "hep NULL.",
    )
    quantity: Mapped[float] = mapped_column(
        Float,
        nullable=False,
    )
    on_hand_quantity: Mapped[float | None] = mapped_column(
        Float,
        nullable=True,
        default=0.0,
        comment="Bilesen (component) siparisler icin: elde zaten mevcut olan stok miktari "
        "(absolute, en son girilen deger — kumulatif degil). quantity SABIT nominal ihtiyaci "
        "temsil etmeye devam eder; uretilecek/hesaba giren efektif miktar = quantity - on_hand_quantity.",
    )
    start_date: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )
    end_date: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )
    promised_date: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        comment="Bu parcaya ozel, kullanici tarafindan elle girilen sabit soz verilen tarih — "
        "zaman cizelgesi/parametre/isci degisikliklerinden ETKILENMEZ",
    )
    manual_edit: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        nullable=False,
        comment="True if changed via Gantt drag/drop",
    )
    is_outsourced: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        nullable=False,
        comment="True if outsourced (fason) production",
    )
    manual_steps: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment="Per-split manual step tracking (supply/assembly/production/test/delivery)",
    )
    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=OrderStatus.PENDING.value,
        comment="Orders.status ile ayni kalip — 0 isaretli adimla temsil edilen durumlar "
        "arasinda (or. 'Tedarik' vs hic baslamamis) ayrim yapabilmek icin taban deger",
    )
    stage_schedule: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment="User-confirmed custom schedule for the 5 tracked stages, overriding the computed suggestion",
    )
    param_overrides: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment="Bu parcaya ozel uretim parametresi gecersiz kilmalari (or. {'assembly_days': 3.0}) — "
        "eksik anahtarlar orders.base_data'dan miras alinir",
    )
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    is_deleted: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        nullable=False,
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    # Relationships
    order = relationship("Order", back_populates="delivery_splits")
    creator = relationship("User", back_populates="delivery_splits")

    def __repr__(self) -> str:
        return f"<DeliverySplit(order_id={self.order_id}, qty={self.quantity})>"
