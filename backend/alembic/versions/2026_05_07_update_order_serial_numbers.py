"""update_order_serial_numbers - add current_stage and updated_at

Revision ID: 2026050701
Revises: 7f8a9b0c1d2e
Create Date: 2026-05-07 10:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "2026050701"
down_revision: Union[str, None] = "7f8a9b0c1d2e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add current_stage column
    op.add_column(
        "order_serial_numbers",
        sa.Column(
            "current_stage",
            sa.String(length=20),
            server_default="supply",
            nullable=False,
            comment="Current production stage: supply, assembly, quality, test, delivery, completed",
        ),
    )

    # Add updated_at column with timestamp
    op.add_column(
        "order_serial_numbers",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    # Drop old status column if it exists
    try:
        op.drop_column("order_serial_numbers", "status")
    except Exception:
        # If column doesn't exist, that's okay
        pass


def downgrade() -> None:
    # Restore old status column
    op.add_column(
        "order_serial_numbers",
        sa.Column(
            "status",
            sa.String(length=20),
            server_default="PENDING",
            nullable=False,
        ),
    )

    # Drop new columns
    op.drop_column("order_serial_numbers", "updated_at")
    op.drop_column("order_serial_numbers", "current_stage")
