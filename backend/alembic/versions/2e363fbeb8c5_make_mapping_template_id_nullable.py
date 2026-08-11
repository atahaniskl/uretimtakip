"""make_mapping_template_id_nullable

Revision ID: 2e363fbeb8c5
Revises: 2026061701
Create Date: 2026-06-17 14:02:05.478711

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "2e363fbeb8c5"
down_revision: Union[str, None] = "2026061701"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("orders", "mapping_template_id",
        existing_type=sa.UUID(),
        nullable=True)


def downgrade() -> None:
    op.alter_column("orders", "mapping_template_id",
        existing_type=sa.UUID(),
        nullable=False)
