"""make_performed_by_nullable - Allow scheduler to create audit logs without user

Revision ID: 2026050702
Revises: 2026050701
Create Date: 2026-05-07 11:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "2026050702"
down_revision: Union[str, None] = "2026050701"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Alter performed_by column to be nullable
    op.alter_column(
        "audit_logs",
        "performed_by",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=True,
        existing_nullable=False,
    )


def downgrade() -> None:
    # Revert performed_by column to NOT NULL
    # First, set any NULL values to a placeholder or fail if they exist
    op.execute("DELETE FROM audit_logs WHERE performed_by IS NULL")
    
    op.alter_column(
        "audit_logs",
        "performed_by",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=False,
        existing_nullable=True,
    )
