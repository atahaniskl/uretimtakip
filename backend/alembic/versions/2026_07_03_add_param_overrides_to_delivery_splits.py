"""add param_overrides to delivery_splits

Revision ID: 2026070301
Revises: 2026070103
Create Date: 2026-07-03

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "2026070301"
down_revision: Union[str, None] = "2026070103"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "delivery_splits",
        sa.Column(
            "param_overrides",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
            comment="Bu parcaya ozel uretim parametresi gecersiz kilmalari (or. {'assembly_days': 3.0}) — "
            "eksik anahtarlar orders.base_data'dan miras alinir",
        ),
    )


def downgrade() -> None:
    op.drop_column("delivery_splits", "param_overrides")
