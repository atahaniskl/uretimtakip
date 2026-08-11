"""
User model — Users Table.
"""

import uuid
import enum

from sqlalchemy import String, Enum as SAEnum
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class UserRole(str, enum.Enum):
    """User role enum: ADMIN, PLANNER, VIEWER."""
    ADMIN = "ADMIN"
    PLANNER = "PLANNER"
    VIEWER = "VIEWER"


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    username: Mapped[str] = mapped_column(
        String(100),
        unique=True,
        nullable=False,
        index=True,
    )
    email: Mapped[str | None] = mapped_column(
        String(255),
        unique=True,
        nullable=True,
        index=True,
    )
    authentik_subject: Mapped[str | None] = mapped_column(
        String(255),
        unique=True,
        nullable=True,
        index=True,
    )
    hashed_password: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
    )
    role: Mapped[UserRole] = mapped_column(
        SAEnum(UserRole, name="user_role", create_constraint=True),
        nullable=False,
        default=UserRole.VIEWER,
    )
    is_approved: Mapped[bool] = mapped_column(
        nullable=False,
        default=True,
    )

    # Relationships
    mapping_templates = relationship("MappingTemplate", back_populates="creator")
    orders = relationship("Order", back_populates="creator")
    delivery_splits = relationship("DeliverySplit", back_populates="creator")
    delivery_notes = relationship("DeliveryNote", back_populates="creator")
    audit_log_notes = relationship("AuditLogNote", back_populates="creator")
    audit_logs = relationship("AuditLog", back_populates="performer")
    saved_filters = relationship("SavedFilter", back_populates="creator")
    feedback_items = relationship("FeedbackItem", foreign_keys="FeedbackItem.created_by", back_populates="creator")

    def __repr__(self) -> str:
        return f"<User(username={self.username}, role={self.role})>"
