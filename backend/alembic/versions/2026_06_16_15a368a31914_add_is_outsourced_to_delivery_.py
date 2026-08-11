"""add_is_outsourced_to_delivery_splits

Revision ID: 15a368a31914
Revises: 2026051701
Create Date: 2026-06-16

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '15a368a31914'
down_revision: Union[str, None] = '2026051701'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('delivery_splits',
        sa.Column('is_outsourced', sa.Boolean(), nullable=False, server_default=sa.text('false'))
    )


def downgrade() -> None:
    op.drop_column('delivery_splits', 'is_outsourced')
