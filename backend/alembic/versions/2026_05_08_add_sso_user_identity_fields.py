"""add_sso_user_identity_fields

Revision ID: 2026050801
Revises: 8789c1613c27
Create Date: 2026-05-08 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "2026050801"
down_revision: Union[str, None] = "8789c1613c27"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("email", sa.String(length=255), nullable=True))
    op.add_column(
        "users",
        sa.Column("authentik_subject", sa.String(length=255), nullable=True),
    )
    op.create_index(
        "ix_users_email_unique",
        "users",
        ["email"],
        unique=True,
        postgresql_where=sa.text("email IS NOT NULL"),
    )
    op.create_index(
        "ix_users_authentik_subject_unique",
        "users",
        ["authentik_subject"],
        unique=True,
        postgresql_where=sa.text("authentik_subject IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_users_authentik_subject_unique", table_name="users")
    op.drop_index("ix_users_email_unique", table_name="users")
    op.drop_column("users", "authentik_subject")
    op.drop_column("users", "email")
