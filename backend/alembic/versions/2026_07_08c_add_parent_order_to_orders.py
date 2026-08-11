"""add parent_order_id/component_product_id to orders

Revision ID: 2026070803
Revises: 2026070802
Create Date: 2026-07-08

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "2026070803"
down_revision: Union[str, None] = "2026070802"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("orders", sa.Column("parent_order_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("orders", sa.Column("component_product_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_orders_parent_order_id", "orders", "orders", ["parent_order_id"], ["id"], ondelete="CASCADE"
    )
    op.create_foreign_key(
        "fk_orders_component_product_id", "orders", "product_infos", ["component_product_id"], ["id"]
    )
    op.create_index("ix_orders_parent_order_id", "orders", ["parent_order_id"])


def downgrade() -> None:
    op.drop_index("ix_orders_parent_order_id", table_name="orders")
    op.drop_constraint("fk_orders_component_product_id", "orders", type_="foreignkey")
    op.drop_constraint("fk_orders_parent_order_id", "orders", type_="foreignkey")
    op.drop_column("orders", "component_product_id")
    op.drop_column("orders", "parent_order_id")
