"""
StepEmployeeAssignment model — employee count per order/split per production step.
"""

import uuid

from sqlalchemy import Float, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class StepEmployeeAssignment(Base):
    __tablename__ = "step_employee_assignments"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orders.id"), nullable=False
    )
    split_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("delivery_splits.id"), nullable=True,
        comment="NULL = order-level default, set = per-split override"
    )
    step_key: Mapped[str] = mapped_column(
        String(50), nullable=False, comment="assembly | production | test"
    )
    employee_count: Mapped[float] = mapped_column(
        Float, nullable=False, default=1.0
    )

    order = relationship("Order", back_populates="step_assignments")
    split = relationship("DeliverySplit")

    def __repr__(self) -> str:
        return (
            f"<StepEmployeeAssignment(order_id={self.order_id}, "
            f"split_id={self.split_id}, "
            f"step_key={self.step_key}, employees={self.employee_count})>"
        )
