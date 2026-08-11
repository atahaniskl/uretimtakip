"""add split_id to step_employee_assignments

Revision ID: 2026062201
Revises: 2026061901
Create Date: 2026-06-22

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "2026062201"
down_revision: Union[str, None] = "2026061901"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "step_employee_assignments",
        sa.Column(
            "split_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
            comment="NULL = order-level default, set = per-split override",
        ),
    )
    op.create_foreign_key(
        "fk_step_emp_split",
        "step_employee_assignments",
        "delivery_splits",
        ["split_id"],
        ["id"],
    )

    # Drop old unique constraint on (order_id, step_key)
    op.drop_constraint("uq_order_step", "step_employee_assignments", type_="unique")

    # Partial unique indexes: one for order-level (split_id IS NULL),
    # one for split-level (split_id IS NOT NULL)
    op.create_index(
        "uq_step_emp_order",
        "step_employee_assignments",
        ["order_id", "step_key"],
        unique=True,
        postgresql_where=sa.text("split_id IS NULL"),
    )
    op.create_index(
        "uq_step_emp_split",
        "step_employee_assignments",
        ["order_id", "split_id", "step_key"],
        unique=True,
        postgresql_where=sa.text("split_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_step_emp_order", table_name="step_employee_assignments")
    op.drop_index("uq_step_emp_split", table_name="step_employee_assignments")
    op.create_unique_constraint("uq_order_step", "step_employee_assignments", ["order_id", "step_key"])
    op.drop_constraint("fk_step_emp_split", "step_employee_assignments", type_="foreignkey")
    op.drop_column("step_employee_assignments", "split_id")
