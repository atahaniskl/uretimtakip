"""
MappingTemplate model — MappingTemplates Table.
"""

import uuid

from sqlalchemy import String, ForeignKey
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.enums import UniqueIdStrategy


class MappingTemplate(Base):
    __tablename__ = "mapping_templates"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
    )
    column_map: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        comment='Format: {"excel_col": "system_field"}',
    )
    unique_id_strategy: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=UniqueIdStrategy.COLUMN.value,
    )
    unique_id_config: Mapped[dict] = mapped_column(
        JSONB,
        nullable=True,
    )
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )

    # Relationships
    creator = relationship("User", back_populates="mapping_templates")
    orders = relationship("Order", back_populates="mapping_template")

    def __repr__(self) -> str:
        return f"<MappingTemplate(name={self.name})>"
