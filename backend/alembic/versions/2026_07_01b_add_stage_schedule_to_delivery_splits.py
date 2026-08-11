"""add stage_schedule to delivery_splits

Revision ID: 2026070102
Revises: 2026070101
Create Date: 2026-07-01

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "2026070102"
down_revision: Union[str, None] = "2026070101"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "delivery_splits",
        sa.Column(
            "stage_schedule",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
            comment="User-confirmed custom schedule for the 5 tracked stages (supply/assembly/production/test/delivery), overriding the computed suggestion",
        ),
    )


def downgrade() -> None:
    op.drop_column("delivery_splits", "stage_schedule")
