"""kullanicinin yazdigi is gunu kuralindan etkilenecek parcalari deploy sirasinda raporla

Revision ID: 2026080502
Revises: 2026080501
Create Date: 2026-08-05

NE YAPAR: VERIYI DEGISTIRMEZ. Yalnizca deploy sirasinda (alembic upgrade head)
etkilenen parcalari alembic gunlugune basar.

NEDEN VERI DEGISIKLIGI YOK
--------------------------
Zaman cizelgesi veritabaninda SAKLANMIYOR; her okumada uretim parametrelerinden
yeniden hesaplaniyor (date_utils._block_days). Dolayisiyla tasinacak bir "cizelge"
tablosu yok — kod deploy edildigi anda yeni kural gecerli oluyor.

HANGI KURAL DEGISTI
-------------------
Once: urun "Adet Basina" (per_unit) modundaysa, kullanicinin bir parcaya yazdigi
      "toplam is gunu" degeri (delivery_splits.param_overrides) SESSIZCE YOK
      SAYILIYORDU — sure her zaman adet basina veriden hesaplaniyordu.
Sonra: kullanicinin yazdigi deger, urunun sure modundan BAGIMSIZ olarak gecerli.

Yani asagida listelenen parcalar, kullanicinin bir sure yazip da uygulanmadigi
kayitlardir; bu deploy ile o degerler nihayet uygulanir. Liste BOSSA hicbir
parcanin suresi degismez.

Onemli: `param_overrides` (parcaya ozel, kullanicinin yazdigi) ile `orders.base_data`
(urun ana verisinden otomatik dolan) AYRIMI bilincli — yalnizca ilki "kullanici
yazdi" sayilir, bu yuzden sorgu yalnizca param_overrides'a bakar.
"""

import logging
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "2026080502"
down_revision: Union[str, None] = "2026080501"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

logger = logging.getLogger("alembic.runtime.migration")

AFFECTED_SQL = sa.text(
    """
    SELECT o.external_id,
           s.id::text AS split_id,
           s.param_overrides::text AS overrides,
           (s.stage_schedule IS NOT NULL) AS ozel_program
    FROM delivery_splits s
    JOIN orders o ON o.id = s.order_id
    WHERE NOT s.is_deleted
      AND NOT o.is_deleted
      AND COALESCE(
            s.param_overrides ->> 'duration_mode',
            o.base_data ->> 'duration_mode'
          ) = 'per_unit'
      AND (
            (s.param_overrides ? 'assembly_flat_days'
             AND (s.param_overrides ->> 'assembly_flat_days')::numeric > 0)
         OR (s.param_overrides ? 'production_flat_days'
             AND (s.param_overrides ->> 'production_flat_days')::numeric > 0)
         OR (s.param_overrides ? 'test_flat_days'
             AND (s.param_overrides ->> 'test_flat_days')::numeric > 0)
      )
    ORDER BY o.external_id
    """
)


def upgrade() -> None:
    rows = op.get_bind().execute(AFFECTED_SQL).fetchall()

    if not rows:
        logger.info(
            "[is-gunu kurali] Etkilenen parca YOK — hicbir siparisin suresi degismeyecek."
        )
        return

    logger.warning(
        "[is-gunu kurali] %d parca etkilenecek. Bu parcalarda kullanici bir 'toplam is gunu' "
        "yazmisti ama urun Adet Basina modunda oldugu icin deger yok sayiliyordu; "
        "bu surumden itibaren yazilan deger gecerli olacak:",
        len(rows),
    )
    for row in rows:
        # stage_schedule (Ozel Program) olan parcalar zaten sabitlenmis tarihleri
        # kullanir; onlarin gorunen cizelgesi bu kuraldan ETKILENMEZ, yalnizca
        # "Sistem Onerisi"ne donulurse yeni kural devreye girer.
        note = " (Ozel Program var — gorunen cizelge simdilik degismez)" if row.ozel_program else ""
        logger.warning("  - Siparis %s / parca %s : %s%s", row.external_id, row.split_id, row.overrides, note)


def downgrade() -> None:
    """Geri alinacak bir veri degisikligi yok — bu migration yalnizca rapor uretir."""
    pass
