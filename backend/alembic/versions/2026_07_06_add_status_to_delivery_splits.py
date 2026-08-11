"""add status to delivery_splits

Revision ID: 2026070601
Revises: 2026070301
Create Date: 2026-07-06

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "2026070601"
down_revision: Union[str, None] = "2026070301"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "delivery_splits",
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="PENDING",
            comment="Order.status ile ayni kalip — manuel adim isaretlerinden bagimsiz, "
            "'Tedarik' gibi 0 isaretli adimla temsil edilen durumlari ayirt etmek icin taban deger",
        ),
    )


def downgrade() -> None:
    op.drop_column("delivery_splits", "status")
