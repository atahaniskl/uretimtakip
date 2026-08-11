"""empty message

Revision ID: b3c88d6e5eb9
Revises: 45cf7ba47c4f, 8d2f0a6c1b7e
Create Date: 2026-05-04 16:54:07.459302

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b3c88d6e5eb9'
down_revision: Union[str, None] = ('45cf7ba47c4f', '8d2f0a6c1b7e')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
