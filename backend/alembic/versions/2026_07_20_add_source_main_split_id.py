"""add source_main_split_id to delivery_splits

Revision ID: 2026072001
Revises: 2026071401
Create Date: 2026-07-20

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "2026072001"
down_revision: Union[str, None] = "2026071401"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "delivery_splits",
        sa.Column("source_main_split_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_delivery_splits_source_main_split_id",
        "delivery_splits",
        "delivery_splits",
        ["source_main_split_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_delivery_splits_source_main_split_id",
        "delivery_splits",
        ["source_main_split_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_delivery_splits_source_main_split_id", table_name="delivery_splits")
    op.drop_constraint("fk_delivery_splits_source_main_split_id", "delivery_splits", type_="foreignkey")
    op.drop_column("delivery_splits", "source_main_split_id")
