"""add product_sub_products table

Revision ID: 2026070801
Revises: 2026070601
Create Date: 2026-07-08

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "2026070801"
down_revision: Union[str, None] = "2026070601"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "product_sub_products",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("parent_product_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sub_product_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["parent_product_id"], ["product_infos.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["sub_product_id"], ["product_infos.id"], ondelete="RESTRICT"),
        sa.CheckConstraint("quantity >= 1", name="ck_product_sub_products_quantity_positive"),
        sa.CheckConstraint(
            "parent_product_id != sub_product_id", name="ck_product_sub_products_no_self_reference"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("parent_product_id", "sub_product_id", name="uq_product_sub_products_parent_sub"),
    )
    op.create_index(
        "ix_product_sub_products_parent_product_id", "product_sub_products", ["parent_product_id"]
    )
    op.create_index(
        "ix_product_sub_products_sub_product_id", "product_sub_products", ["sub_product_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_product_sub_products_sub_product_id", table_name="product_sub_products")
    op.drop_index("ix_product_sub_products_parent_product_id", table_name="product_sub_products")
    op.drop_table("product_sub_products")
