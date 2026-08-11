"""merge_agents_parallel_heads

Revision ID: 45cf7ba47c4f
Revises: 7f8a9b0c1d2e
Create Date: 2026-04-29 21:47:59.042028

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '45cf7ba47c4f'
down_revision: Union[str, None] = '7f8a9b0c1d2e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
