"""add_feedback_items_table

Revision ID: e21a7c59b8d4
Revises: d10f4b7f1a33
Create Date: 2026-04-24 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "e21a7c59b8d4"
down_revision = "d10f4b7f1a33"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "feedback_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("category", sa.String(length=20), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("screenshot_object_name", sa.String(length=512), nullable=True),
        sa.Column("screenshot_filename", sa.String(length=255), nullable=True),
        sa.Column("screenshot_content_type", sa.String(length=120), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("is_checked", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("checked_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("category IN ('REQUEST', 'SUGGESTION', 'COMPLAINT')", name="ck_feedback_items_category"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["checked_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_index(op.f("ix_feedback_items_category"), "feedback_items", ["category"], unique=False)
    op.create_index(op.f("ix_feedback_items_created_at"), "feedback_items", ["created_at"], unique=False)
    op.create_index(op.f("ix_feedback_items_created_by"), "feedback_items", ["created_by"], unique=False)
    op.create_index(op.f("ix_feedback_items_is_checked"), "feedback_items", ["is_checked"], unique=False)
    op.create_index(op.f("ix_feedback_items_checked_by"), "feedback_items", ["checked_by"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_feedback_items_checked_by"), table_name="feedback_items")
    op.drop_index(op.f("ix_feedback_items_is_checked"), table_name="feedback_items")
    op.drop_index(op.f("ix_feedback_items_created_by"), table_name="feedback_items")
    op.drop_index(op.f("ix_feedback_items_created_at"), table_name="feedback_items")
    op.drop_index(op.f("ix_feedback_items_category"), table_name="feedback_items")
    op.drop_table("feedback_items")
