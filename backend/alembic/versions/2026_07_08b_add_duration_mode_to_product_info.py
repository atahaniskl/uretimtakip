"""add duration_mode to product_info

Revision ID: 2026070802
Revises: 2026070801
Create Date: 2026-07-08

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "2026070802"
down_revision: Union[str, None] = "2026070801"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("product_infos", sa.Column("duration_mode", sa.String(20), nullable=True))
    op.add_column("product_infos", sa.Column("production_flat_days", sa.Float(), nullable=True))
    op.add_column("product_infos", sa.Column("test_flat_days", sa.Float(), nullable=True))
    op.create_check_constraint(
        "ck_product_infos_duration_mode",
        "product_infos",
        "duration_mode IN ('per_unit', 'flat') OR duration_mode IS NULL",
    )
    op.create_check_constraint(
        "ck_product_infos_production_flat_days_non_negative",
        "product_infos",
        "production_flat_days IS NULL OR production_flat_days >= 0",
    )
    op.create_check_constraint(
        "ck_product_infos_test_flat_days_non_negative",
        "product_infos",
        "test_flat_days IS NULL OR test_flat_days >= 0",
    )


def downgrade() -> None:
    op.drop_constraint("ck_product_infos_test_flat_days_non_negative", "product_infos", type_="check")
    op.drop_constraint("ck_product_infos_production_flat_days_non_negative", "product_infos", type_="check")
    op.drop_constraint("ck_product_infos_duration_mode", "product_infos", type_="check")
    op.drop_column("product_infos", "test_flat_days")
    op.drop_column("product_infos", "production_flat_days")
    op.drop_column("product_infos", "duration_mode")
