"""add step_employee_assignments table

Revision ID: 2026061901
Revises: 2026061802
Create Date: 2026-06-19

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "2026061901"
down_revision: Union[str, None] = "2026061802"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "step_employee_assignments",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("step_key", sa.String(50), nullable=False),
        sa.Column("employee_count", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"], ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("order_id", "step_key", name="uq_order_step"),
    )


def downgrade() -> None:
    op.drop_table("step_employee_assignments")
