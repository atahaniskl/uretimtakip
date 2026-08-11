"""
Order model — Orders (Master) Table.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import String, Boolean, Date, DateTime, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.enums import OrderStatus


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    external_id: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        index=True,
        comment="Hash or Excel-provided ID",
    )
    customer_name: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
    )
    responsible_personnel: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
    )
    order_date: Mapped[date | None] = mapped_column(
        Date,
        nullable=True,
    )
    promised_date: Mapped[date | None] = mapped_column(
        Date,
        nullable=True,
    )
    requirement_date: Mapped[date | None] = mapped_column(
        Date,
        nullable=True,
    )
    penalty_date: Mapped[date | None] = mapped_column(
        Date,
        nullable=True,
    )
    mapping_template_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("mapping_templates.id"),
        nullable=True,
    )
    parent_order_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("orders.id", ondelete="CASCADE"),
        nullable=True,
        comment="Set only for auto-derived component orders (BOM sub-products) — points to the main order",
    )
    component_product_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("product_infos.id"),
        nullable=True,
        comment="Which ProductInfo this component order represents (set only when parent_order_id is set)",
    )
    base_data: Mapped[dict] = mapped_column(
        JSONB,
        nullable=True,
        comment="Stores original extra columns from Excel",
    )
    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=OrderStatus.PENDING.value,
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
    mapping_template = relationship("MappingTemplate", back_populates="orders")
    creator = relationship("User", back_populates="orders")
    delivery_splits = relationship("DeliverySplit", back_populates="order", cascade="all, delete-orphan")
    delivery_notes = relationship("DeliveryNote", back_populates="order", cascade="all, delete-orphan")
    serial_numbers = relationship(
        "OrderSerialNumber",
        back_populates="order",
        cascade="all, delete-orphan",
        order_by="OrderSerialNumber.created_at",
    )
    step_assignments = relationship(
        "StepEmployeeAssignment",
        back_populates="order",
        cascade="all, delete-orphan",
    )
    parent_order = relationship("Order", remote_side=[id], back_populates="components")
    components = relationship(
        "Order",
        back_populates="parent_order",
        cascade="all, delete-orphan",
    )
    component_product = relationship("ProductInfo", foreign_keys=[component_product_id])

    def __repr__(self) -> str:
        return f"<Order(external_id={self.external_id}, status={self.status})>"
