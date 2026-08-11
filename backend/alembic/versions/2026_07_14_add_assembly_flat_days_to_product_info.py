"""add assembly_flat_days to product_info (+ backfill existing flat-mode data)

Revision ID: 2026071401
Revises: 2026070803
Create Date: 2026-07-14

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "2026071401"
down_revision: Union[str, None] = "2026070803"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("product_infos", sa.Column("assembly_flat_days", sa.Float(), nullable=True))
    op.create_check_constraint(
        "ck_product_infos_assembly_flat_days_non_negative",
        "product_infos",
        "assembly_flat_days IS NULL OR assembly_flat_days >= 0",
    )

    # Geriye-doldurma (backfill): assembly_days su ana kadar HEM "gun/adet" (Adet
    # modu) HEM "toplam gun" (Gun modu) anlaminda kullanildi (production/test'in
    # aksine, assembly'nin hic ayri bir flat alani olmadi). Yeni assembly_flat_days
    # bos baslayacagi icin, hesaplama kodu bu alana bakmaya baslamadan ONCE, Gun
    # modundaki (ya da duration_mode hic ayarlanmamis) mevcut kayitlarin
    # assembly_days degeri assembly_flat_days'e kopyalanir — aksi halde bu kayitlarin
    # Dizgi suresi kod degisikligiyle birlikte aniden yanlis hesaplanirdi.
    bind = op.get_bind()

    bind.execute(
        sa.text(
            """
            UPDATE product_infos
            SET assembly_flat_days = assembly_days
            WHERE (duration_mode IS NULL OR duration_mode = 'flat')
              AND assembly_days IS NOT NULL
              AND assembly_flat_days IS NULL
            """
        )
    )

    # Siparis genel duzeyi (orders.base_data, JSONB, nullable olabilir).
    bind.execute(
        sa.text(
            """
            UPDATE orders
            SET base_data = jsonb_set(base_data, '{assembly_flat_days}', base_data->'assembly_days', true)
            WHERE base_data IS NOT NULL
              AND base_data ? 'assembly_days'
              AND (base_data->>'duration_mode' IS NULL OR base_data->>'duration_mode' = 'flat')
              AND NOT (base_data ? 'assembly_flat_days')
            """
        )
    )

    # Parca-ozel gecersiz kilma (delivery_splits.param_overrides, JSONB, nullable).
    # param_overrides icinde duration_mode olmayabilir (o zaman siparis genel modu
    # gecerlidir) — bu durumda da assembly_days varsa kopyalanir (muhafazakar:
    # yalnizca acikca "per_unit" olarak override edilmisse HARIC tutulur).
    bind.execute(
        sa.text(
            """
            UPDATE delivery_splits
            SET param_overrides = jsonb_set(param_overrides, '{assembly_flat_days}', param_overrides->'assembly_days', true)
            WHERE param_overrides IS NOT NULL
              AND param_overrides ? 'assembly_days'
              AND (
                    NOT (param_overrides ? 'duration_mode')
                    OR param_overrides->>'duration_mode' IS NULL
                    OR param_overrides->>'duration_mode' = 'flat'
                  )
              AND NOT (param_overrides ? 'assembly_flat_days')
            """
        )
    )


def downgrade() -> None:
    op.drop_constraint("ck_product_infos_assembly_flat_days_non_negative", "product_infos", type_="check")
    op.drop_column("product_infos", "assembly_flat_days")
    # JSONB backfill geri alinmaz (additive veri, duration_mode migration'inin
    # downgrade'iyle ayni gerekce — kayip onemsiz, sutun zaten kaldiriliyor).
