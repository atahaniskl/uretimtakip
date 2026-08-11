"""merge_is_approved_and_effort_weight

Revision ID: fcbcbd98f5b3
Revises: 1c2bcb0e5b1a, f4c7a1d9b2e0
Create Date: 2026-04-29 13:48:11.706673

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'fcbcbd98f5b3'
down_revision: Union[str, None] = ('1c2bcb0e5b1a', 'f4c7a1d9b2e0')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
