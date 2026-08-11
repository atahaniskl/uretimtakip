"""empty message

Revision ID: 8789c1613c27
Revises: 2026050702, 8326aef7d197
Create Date: 2026-05-07 18:08:42.013300

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8789c1613c27'
down_revision: Union[str, None] = ('2026050702', '8326aef7d197')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
