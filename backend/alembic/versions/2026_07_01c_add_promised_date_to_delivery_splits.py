"""add promised_date to delivery_splits

Revision ID: 2026070103
Revises: 2026070102
Create Date: 2026-07-01

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "2026070103"
down_revision: Union[str, None] = "2026070102"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "delivery_splits",
        sa.Column(
            "promised_date",
            sa.DateTime(timezone=True),
            nullable=True,
            comment="Bu parcaya ozel, kullanici tarafindan elle girilen sabit soz verilen tarih — "
            "zaman cizelgesi/parametre/isci degisikliklerinden ETKILENMEZ",
        ),
    )


def downgrade() -> None:
    op.drop_column("delivery_splits", "promised_date")
