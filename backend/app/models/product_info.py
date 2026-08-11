"""
Product info model.
Stores per-product planning parameters as master data.
"""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Float, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ProductInfo(Base):
    __tablename__ = "product_infos"
    __table_args__ = (
        CheckConstraint(
            "duration_mode IN ('per_unit', 'flat') OR duration_mode IS NULL",
            name="ck_product_infos_duration_mode",
        ),
        CheckConstraint(
            "production_flat_days IS NULL OR production_flat_days >= 0",
            name="ck_product_infos_production_flat_days_non_negative",
        ),
        CheckConstraint(
            "test_flat_days IS NULL OR test_flat_days >= 0",
            name="ck_product_infos_test_flat_days_non_negative",
        ),
        CheckConstraint(
            "assembly_flat_days IS NULL OR assembly_flat_days >= 0",
            name="ck_product_infos_assembly_flat_days_non_negative",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    product_name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        unique=True,
        index=True,
    )
    supply_days: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
    )
    assembly_days: Mapped[float] = mapped_column(
        Float,
        nullable=False,
    )
    delivery_days: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
    )
    # Efor ozelligi kaldirildi. Kolon eski kayitlar bozulmasin diye duruyor,
    # hicbir yerde okunmuyor; yeni kayitlara 0 yaziliyor.
    effort_weight: Mapped[float] = mapped_column(
        Float,
        nullable=False,
        default=0,
        server_default="0",
    )

    # URUN_SURE minute-based fields (nullable, only for imported products)
    quality_minutes: Mapped[float | None] = mapped_column(Float, nullable=True)
    epoxy_minutes: Mapped[float | None] = mapped_column(Float, nullable=True)
    conformal_minutes: Mapped[float | None] = mapped_column(Float, nullable=True)
    montaj_minutes: Mapped[float | None] = mapped_column(Float, nullable=True)
    montaj_kalite_minutes: Mapped[float | None] = mapped_column(Float, nullable=True)
    test1_minutes: Mapped[float | None] = mapped_column(Float, nullable=True)
    test2_minutes: Mapped[float | None] = mapped_column(Float, nullable=True)
    final_test_minutes: Mapped[float | None] = mapped_column(Float, nullable=True)

    # "per_unit" | "flat" | NULL (NULL = henuz belirtilmemis; siparis tarafinda oldugu
    # gibi flat gibi davranilir). Dizgi/uretim/test surelerinin adet basina mi yoksa
    # sabit toplam gun olarak mi yorumlanacagini belirler.
    duration_mode: Mapped[str | None] = mapped_column(String(20), nullable=True)
    production_flat_days: Mapped[float | None] = mapped_column(Float, nullable=True)
    test_flat_days: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Dizgi'nin Gün (flat) modundaki "toplam gün" değeri — assembly_days'ten AYRI
    # ve bağımsız (assembly_days her zaman "gün/adet" anlamındadır, moddan bağımsız).
    # production_flat_days/test_flat_days ile birebir aynı desen.
    assembly_flat_days: Mapped[float | None] = mapped_column(Float, nullable=True)

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

    sub_products = relationship(
        "ProductSubProduct",
        foreign_keys="ProductSubProduct.parent_product_id",
        back_populates="parent_product",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    used_in_products = relationship(
        "ProductSubProduct",
        foreign_keys="ProductSubProduct.sub_product_id",
        back_populates="sub_product",
        passive_deletes=True,
    )

    @property
    def uretim_dk(self) -> float:
        items = [self.epoxy_minutes, self.conformal_minutes, self.montaj_minutes]
        valid = [v for v in items if v is not None]
        return sum(valid) if valid else 0.0

    @property
    def kalite_dk(self) -> float:
        items = [self.quality_minutes, self.montaj_kalite_minutes]
        valid = [v for v in items if v is not None]
        return sum(valid) if valid else 0.0

    @property
    def test_dk(self) -> float:
        items = [self.test1_minutes, self.test2_minutes, self.final_test_minutes]
        valid = [v for v in items if v is not None]
        return sum(valid) if valid else 0.0

    def __repr__(self) -> str:
        return f"<ProductInfo(product_name={self.product_name})>"