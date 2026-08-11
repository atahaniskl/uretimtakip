"""empty message

Revision ID: 8326aef7d197
Revises: 2026050701, b3c88d6e5eb9
Create Date: 2026-05-07 17:25:13.438927

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8326aef7d197'
down_revision: Union[str, None] = ('2026050701', 'b3c88d6e5eb9')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
