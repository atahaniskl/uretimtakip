"""
Serial numbers attached to orders.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.enums import SerialNumberStage


class OrderSerialNumber(Base):
    __tablename__ = "order_serial_numbers"

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
    serial_number: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        index=True,
    )
    current_stage: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=SerialNumberStage.SUPPLY.value,
        server_default=SerialNumberStage.SUPPLY.value,
        comment="Current production stage: supply, assembly, quality, test, delivery, completed",
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

    order = relationship("Order", back_populates="serial_numbers")

    def __repr__(self) -> str:
        return f"<OrderSerialNumber(order_id={self.order_id}, serial_number={self.serial_number}, current_stage={self.current_stage})>"
