"""change employee_count from Integer to Float

Revision ID: 2026062401
Revises: 2026062201
Create Date: 2026-06-24

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "2026062401"
down_revision: Union[str, None] = "2026062201"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "step_employee_assignments",
        "employee_count",
        type_=sa.Float(),
        existing_type=sa.Integer(),
        existing_server_default=sa.text("1"),
        postgresql_using="employee_count::double precision",
    )


def downgrade() -> None:
    op.alter_column(
        "step_employee_assignments",
        "employee_count",
        type_=sa.Integer(),
        existing_type=sa.Float(),
        existing_server_default=sa.text("1"),
        postgresql_using="employee_count::integer",
    )
