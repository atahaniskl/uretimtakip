"""add_delivery_notes_table

Revision ID: 1c2bcb0e5b1a
Revises: d10f4b7f1a33
Create Date: 2026-04-23 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "1c2bcb0e5b1a"
down_revision = "d10f4b7f1a33"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "delivery_notes",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_delivery_notes_order_id"), "delivery_notes", ["order_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_delivery_notes_order_id"), table_name="delivery_notes")
    op.drop_table("delivery_notes")
