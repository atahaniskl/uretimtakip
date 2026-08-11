"""add_audit_log_notes_table

Revision ID: 2026051301
Revises: 2026050801
Create Date: 2026-05-13 00:00:00.000000
"""

from typing import Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "2026051301"
down_revision: Union[str, None] = "2026050801"
branch_labels: Union[str, None] = None
depends_on: Union[str, None] = None


def upgrade() -> None:
    op.create_table(
        "audit_log_notes",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("audit_log_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["audit_log_id"], ["audit_logs.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_audit_log_notes_audit_log_id"), "audit_log_notes", ["audit_log_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_audit_log_notes_audit_log_id"), table_name="audit_log_notes")
    op.drop_table("audit_log_notes")
