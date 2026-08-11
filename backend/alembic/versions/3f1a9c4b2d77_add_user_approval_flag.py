"""add_user_approval_flag

Revision ID: 3f1a9c4b2d77
Revises: 217ca96871c6
Create Date: 2026-04-19 12:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "3f1a9c4b2d77"
down_revision = "217ca96871c6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("is_approved", sa.Boolean(), nullable=False, server_default=sa.true()),
    )


def downgrade() -> None:
    op.drop_column("users", "is_approved")
