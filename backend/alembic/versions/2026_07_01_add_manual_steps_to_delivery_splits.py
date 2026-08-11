"""add manual_steps to delivery_splits

Revision ID: 2026070101
Revises: 2026062401
Create Date: 2026-07-01

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "2026070101"
down_revision: Union[str, None] = "2026062401"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "delivery_splits",
        sa.Column(
            "manual_steps",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
            comment="Per-split manual step tracking (supply/assembly/production/test/delivery)",
        ),
    )


def downgrade() -> None:
    op.drop_column("delivery_splits", "manual_steps")
