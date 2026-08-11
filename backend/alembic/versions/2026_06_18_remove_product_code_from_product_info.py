"""remove_product_code_from_product_info

Revision ID: 2026061801
Revises: 2e363fbeb8c5
Create Date: 2026-06-18

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "2026061801"
down_revision: Union[str, None] = "2e363fbeb8c5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index(op.f("ix_product_infos_product_code"), table_name="product_infos")
    op.drop_column("product_infos", "product_code")


def downgrade() -> None:
    op.add_column("product_infos",
        sa.Column("product_code", sa.String(length=255), nullable=True)
    )
    op.create_index(op.f("ix_product_infos_product_code"), "product_infos", ["product_code"], unique=False)
