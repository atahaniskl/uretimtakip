"""add_product_infos_table

Revision ID: 8d2f0a6c1b7e
Revises: fcbcbd98f5b3
Create Date: 2026-05-04 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "8d2f0a6c1b7e"
down_revision = "fcbcbd98f5b3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "product_infos",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("product_name", sa.String(length=255), nullable=False),
        sa.Column("supply_days", sa.Integer(), nullable=False),
        sa.Column("assembly_days", sa.Integer(), nullable=False),
        sa.Column("quality_days", sa.Integer(), nullable=False),
        sa.Column("test_days", sa.Integer(), nullable=False),
        sa.Column("delivery_days", sa.Integer(), nullable=False),
        sa.Column("effort_weight", sa.Float(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("supply_days >= 0", name="ck_product_infos_supply_days_non_negative"),
        sa.CheckConstraint("assembly_days >= 0", name="ck_product_infos_assembly_days_non_negative"),
        sa.CheckConstraint("quality_days >= 0", name="ck_product_infos_quality_days_non_negative"),
        sa.CheckConstraint("test_days >= 0", name="ck_product_infos_test_days_non_negative"),
        sa.CheckConstraint("delivery_days >= 0", name="ck_product_infos_delivery_days_non_negative"),
        sa.CheckConstraint("effort_weight >= 0", name="ck_product_infos_effort_weight_non_negative"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("product_name"),
    )
    op.create_index(op.f("ix_product_infos_product_name"), "product_infos", ["product_name"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_product_infos_product_name"), table_name="product_infos")
    op.drop_table("product_infos")