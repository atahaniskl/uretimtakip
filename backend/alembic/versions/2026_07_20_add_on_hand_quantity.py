"""add on_hand_quantity to delivery_splits

Revision ID: 2026072002
Revises: 2026072001
Create Date: 2026-07-20

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "2026072002"
down_revision: Union[str, None] = "2026072001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "delivery_splits",
        sa.Column("on_hand_quantity", sa.Float(), nullable=True, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("delivery_splits", "on_hand_quantity")
