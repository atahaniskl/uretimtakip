"""
Shared saved filter model for Gantt filtering presets.
"""

import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class SavedFilter(Base):
    __tablename__ = "saved_filters"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    name: Mapped[str] = mapped_column(
        String(120),
        nullable=False,
        index=True,
    )
    criteria: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        comment='Example: {"task_filter_field": "all", "task_filter_query": "", "customer_filter": ""}',
    )
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    creator = relationship("User", back_populates="saved_filters")

    def __repr__(self) -> str:
        return f"<SavedFilter(name={self.name})>"
