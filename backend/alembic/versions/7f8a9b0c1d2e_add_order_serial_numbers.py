"""add_order_serial_numbers

Revision ID: 7f8a9b0c1d2e
Revises: c24630404e72
Create Date: 2026-04-29 18:10:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "7f8a9b0c1d2e"
down_revision: Union[str, None] = "c24630404e72"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "order_serial_numbers",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("serial_number", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=20), server_default="PENDING", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_order_serial_numbers_order_id"), "order_serial_numbers", ["order_id"], unique=False)
    op.create_index(op.f("ix_order_serial_numbers_serial_number"), "order_serial_numbers", ["serial_number"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_order_serial_numbers_serial_number"), table_name="order_serial_numbers")
    op.drop_index(op.f("ix_order_serial_numbers_order_id"), table_name="order_serial_numbers")
    op.drop_table("order_serial_numbers")
