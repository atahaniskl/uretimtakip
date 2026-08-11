"""rename test_days/quality_days to test_hours/quality_hours in product_infos

Revision ID: 2026051701
Revises: 2026051301
Create Date: 2026-05-17 00:00:00.000000

"""

from typing import Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "2026051701"
down_revision: Union[str, None] = "2026051301"
branch_labels: Union[str, None] = None
depends_on: Union[str, None] = None


def upgrade() -> None:
    # Drop old check constraints
    op.drop_constraint("ck_product_infos_quality_days_non_negative", "product_infos")
    op.drop_constraint("ck_product_infos_test_days_non_negative", "product_infos")

    # Rename columns
    op.alter_column("product_infos", "quality_days", new_column_name="quality_hours")
    op.alter_column("product_infos", "test_days", new_column_name="test_hours")

    # Add new check constraints
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


def downgrade() -> None:
    # Drop new check constraints
    op.drop_constraint("ck_product_infos_quality_hours_non_negative", "product_infos")
    op.drop_constraint("ck_product_infos_test_hours_non_negative", "product_infos")

    # Rename columns back
    op.alter_column("product_infos", "quality_hours", new_column_name="quality_days")
    op.alter_column("product_infos", "test_hours", new_column_name="test_days")

    # Restore old check constraints
    op.create_check_constraint(
        "ck_product_infos_quality_days_non_negative",
        "product_infos",
        sa.text("quality_days >= 0"),
    )
    op.create_check_constraint(
        "ck_product_infos_test_days_non_negative",
        "product_infos",
        sa.text("test_days >= 0"),
    )
