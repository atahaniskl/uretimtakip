"""
Request/Suggestion/Complaint item model.
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class FeedbackItem(Base):
    __tablename__ = "feedback_items"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    category: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        index=True,
        comment="REQUEST, SUGGESTION, COMPLAINT",
    )
    description: Mapped[str] = mapped_column(
        Text,
        nullable=False,
    )
    screenshot_object_name: Mapped[str | None] = mapped_column(
        String(512),
        nullable=True,
    )
    screenshot_filename: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
    )
    screenshot_content_type: Mapped[str | None] = mapped_column(
        String(120),
        nullable=True,
    )
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        index=True,
    )
    is_checked: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default="false",
        index=True,
    )
    checked_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=True,
        index=True,
    )
    checked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    creator = relationship("User", foreign_keys=[created_by], back_populates="feedback_items")

    def __repr__(self) -> str:
        return f"<FeedbackItem(category={self.category}, checked={self.is_checked})>"