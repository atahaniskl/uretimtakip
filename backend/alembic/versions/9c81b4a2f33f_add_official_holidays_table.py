"""add_official_holidays_table

Revision ID: 9c81b4a2f33f
Revises: 3f1a9c4b2d77
Create Date: 2026-04-22 10:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "9c81b4a2f33f"
down_revision = "3f1a9c4b2d77"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "official_holidays",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("holiday_date", sa.Date(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("holiday_date"),
    )
    op.create_index(op.f("ix_official_holidays_holiday_date"), "official_holidays", ["holiday_date"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_official_holidays_holiday_date"), table_name="official_holidays")
    op.drop_table("official_holidays")
