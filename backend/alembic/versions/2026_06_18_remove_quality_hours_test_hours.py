"""remove quality_hours and test_hours from product_infos

Revision ID: 2026061802
Revises: 2026061801
Create Date: 2026-06-18

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "2026061802"
down_revision: Union[str, None] = "2026061801"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint("ck_product_infos_quality_hours_non_negative", "product_infos")
    op.drop_constraint("ck_product_infos_test_hours_non_negative", "product_infos")
    op.drop_column("product_infos", "quality_hours")
    op.drop_column("product_infos", "test_hours")


def downgrade() -> None:
    op.add_column("product_infos",
        sa.Column("quality_hours", sa.Integer(), nullable=False, server_default="0")
    )
    op.add_column("product_infos",
        sa.Column("test_hours", sa.Integer(), nullable=False, server_default="0")
    )
    op.alter_column("product_infos", "quality_hours", server_default=None)
    op.alter_column("product_infos", "test_hours", server_default=None)
    op.create_check_constraint(
        "ck_product_infos_quality_hours_non_negative",
        "product_infos",
        sa.text("quality_hours >= 0"),
    )
    op.create_check_constraint(
        "ck_product_infos_test_hours_non_negative",
        "product_infos",
        sa.text("test_hours >= 0"),
    )
