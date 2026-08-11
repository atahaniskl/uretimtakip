"""
ProductSubProduct model — self-referencing product recipe (BOM-lite) link.
Records that `quantity` units of `sub_product` are required to build `parent_product`.
"""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ProductSubProduct(Base):
    __tablename__ = "product_sub_products"
    __table_args__ = (
        CheckConstraint("quantity >= 1", name="ck_product_sub_products_quantity_positive"),
        CheckConstraint(
            "parent_product_id != sub_product_id",
            name="ck_product_sub_products_no_self_reference",
        ),
        UniqueConstraint(
            "parent_product_id", "sub_product_id", name="uq_product_sub_products_parent_sub"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    parent_product_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("product_infos.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    sub_product_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("product_infos.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    quantity: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=1,
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

    parent_product = relationship(
        "ProductInfo",
        foreign_keys=[parent_product_id],
        back_populates="sub_products",
    )
    sub_product = relationship(
        "ProductInfo",
        foreign_keys=[sub_product_id],
        back_populates="used_in_products",
    )

    @property
    def product_id(self) -> uuid.UUID:
        return self.sub_product_id

    @property
    def product_name(self) -> str:
        return self.sub_product.product_name if self.sub_product else ""

    def __repr__(self) -> str:
        return (
            f"<ProductSubProduct(parent={self.parent_product_id}, "
            f"sub={self.sub_product_id}, quantity={self.quantity})>"
        )
