"""add_urun_sure_fields_to_product_info

Revision ID: 2026061701
Revises: 15a368a31914
Create Date: 2026-06-17

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "2026061701"
down_revision: Union[str, None] = "15a368a31914"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add product_code column
    op.add_column("product_infos",
        sa.Column("product_code", sa.String(length=255), nullable=True)
    )
    op.create_index(op.f("ix_product_infos_product_code"), "product_infos", ["product_code"], unique=False)

    # Change assembly_days from Integer to Float
    op.drop_constraint("ck_product_infos_assembly_days_non_negative", "product_infos")
    op.alter_column("product_infos", "assembly_days",
        existing_type=sa.Integer(),
        type_=sa.Float(),
        existing_nullable=False,
    )
    op.create_check_constraint(
        "ck_product_infos_assembly_days_non_negative",
        "product_infos",
        sa.text("assembly_days >= 0"),
    )

    # Add URUN_SURE minute-based columns
    op.add_column("product_infos",
        sa.Column("quality_minutes", sa.Float(), nullable=True)
    )
    op.add_column("product_infos",
        sa.Column("epoxy_minutes", sa.Float(), nullable=True)
    )
    op.add_column("product_infos",
        sa.Column("conformal_minutes", sa.Float(), nullable=True)
    )
    op.add_column("product_infos",
        sa.Column("montaj_minutes", sa.Float(), nullable=True)
    )
    op.add_column("product_infos",
        sa.Column("montaj_kalite_minutes", sa.Float(), nullable=True)
    )
    op.add_column("product_infos",
        sa.Column("test1_minutes", sa.Float(), nullable=True)
    )
    op.add_column("product_infos",
        sa.Column("test2_minutes", sa.Float(), nullable=True)
    )
    op.add_column("product_infos",
        sa.Column("final_test_minutes", sa.Float(), nullable=True)
    )


def downgrade() -> None:
    # Remove URUN_SURE minute-based columns
    op.drop_column("product_infos", "final_test_minutes")
    op.drop_column("product_infos", "test2_minutes")
    op.drop_column("product_infos", "test1_minutes")
    op.drop_column("product_infos", "montaj_kalite_minutes")
    op.drop_column("product_infos", "montaj_minutes")
    op.drop_column("product_infos", "conformal_minutes")
    op.drop_column("product_infos", "epoxy_minutes")
    op.drop_column("product_infos", "quality_minutes")

    # Revert assembly_days from Float to Integer
    op.drop_constraint("ck_product_infos_assembly_days_non_negative", "product_infos")
    op.alter_column("product_infos", "assembly_days",
        existing_type=sa.Float(),
        type_=sa.Integer(),
        existing_nullable=False,
    )
    op.create_check_constraint(
        "ck_product_infos_assembly_days_non_negative",
        "product_infos",
        sa.text("assembly_days >= 0"),
    )

    # Remove product_code column and index
    op.drop_index(op.f("ix_product_infos_product_code"), table_name="product_infos")
    op.drop_column("product_infos", "product_code")
