"""sure modu kaldirilmadan onceki asama surelerini siparis-ozeli deger olarak dondur

Revision ID: 2026080503
Revises: 2026080502
Create Date: 2026-08-07

NEDEN
-----
Bu surumle birlikte "sure modu" (Adet Basina / Is Gunu) kaldirildi; Dizgi/Uretim/Test
HER ZAMAN adet basina hesaplaniyor (bkz. date_utils._block_days). Eski varsayilan ise
"Is Gunu" idi, yani cogu siparis sabit toplam gun kullaniyordu. Kod deploy edilir
edilmez bu siparislerin sureleri degisirdi — ornegin siparisinin kendi kopyasinda
assembly_days=12 tasiyan 40 adetlik bir parcanin Dizgi'si 1 gunden 480 gune ciderdi.

Bu migration, DEGISECEK OLAN her parcanin ESKI suresini `param_overrides` icine
"kullanicinin yazdigi deger" olarak yazar. Yeni motor bu degeri kesin kabul ettigi
icin (EXPLICIT_FLAT_KEYS_FIELD kurali) mevcut siparislerin cizelgesi OYNAMAZ.
Kullanici isterse sonradan duzenleme ekranindan bu degeri degistirebilir ya da
silip adet basina hesaba geri donebilir.

TASARIM NOTLARI
---------------
* Kurallar bu dosyaya ELLE KOPYALANDI, app kodundan import EDILMEDI. Migration
  calistiginda yeni kod zaten deploy edilmis olur; app'ten import etseydik "eski
  sure"yi degil yeni sureyi hesaplardik. Migration'lar zamanda sabit olmali.
* Yalnizca GERCEKTEN DEGISEN asamalar yazilir. Hepsini yazmak her siparisi
  gereksizce "kullanici elle ayarladi" durumuna sokar ve adet degisince surenin
  yeniden hesaplanmasini kalici olarak engellerdi.
* Fason (dis dizgi) parcalarda Dizgi zaten moddan bagimsiz hesaplaniyordu; o dal
  degismedigi icin Dizgi'ye dokunulmaz.
"""

import json
import logging
import math
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "2026080503"
down_revision: Union[str, None] = "2026080502"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

logger = logging.getLogger("alembic.runtime.migration")

FLAT_KEY = {"assembly": "assembly_flat_days", "production": "production_flat_days", "test": "test_flat_days"}
PRODUCTION_MINUTES = ("quality_minutes", "epoxy_minutes", "conformal_minutes", "montaj_minutes", "montaj_kalite_minutes")
TEST_MINUTES = ("test1_minutes", "test2_minutes", "final_test_minutes")

_FASON_KEYS = ("is_outsourced", "outsourced", "fason", "fason_mu", "fason_mi")
_FASON_TRUE = {"1", "true", "t", "yes", "y", "evet", "e", "fason", "dis", "dış", "outsource", "outsourced"}


def _f(value) -> float | None:
    """base_data degerleri string de olabiliyor ('12') — tolere edilir."""
    if value is None:
        return None
    try:
        return float(str(value))
    except (TypeError, ValueError):
        return None


def _outsourced(params: dict, split_flag: bool) -> bool:
    if split_flag:
        return True
    for key in _FASON_KEYS:
        raw = params.get(key)
        if raw is None:
            continue
        if isinstance(raw, bool):
            return raw
        if str(raw).strip().lower() in _FASON_TRUE:
            return True
    return False


def _equivalents(params: dict, qty: float, emp: dict, work_minutes: float) -> dict:
    """Adet basina veriden hesaplanan gun sayilari (iki kuralda da ayni)."""
    assembly_d = _f(params.get("production_days")) or _f(params.get("assembly_days"))
    out = {}
    out["assembly"] = (
        max(1, math.ceil(assembly_d * qty / (emp["assembly"] or 1))) if assembly_d and assembly_d > 0 else None
    )
    for stage, fields in (("production", PRODUCTION_MINUTES), ("test", TEST_MINUTES)):
        total = sum(_f(params.get(f)) or 0 for f in fields)
        out[stage] = (
            max(1, math.ceil(total * qty / (work_minutes * (emp[stage] or 1)))) if total > 0 else None
        )
    return out


def _old_days(stage, params, explicit, equivalents):
    """v1.15.8 kurali: mod 'flat' ise toplam gun, 'per_unit' ise esdeger."""
    flat_mode = params.get("duration_mode") != "per_unit"
    flat = _f(params.get(FLAT_KEY[stage]))
    has_flat = bool(flat and flat > 0)
    if FLAT_KEY[stage] in explicit and has_flat:
        return max(1, round(flat))
    if flat_mode:
        return max(1, round(flat if has_flat else (equivalents[stage] or 1)))
    return equivalents[stage]


def _new_days(stage, params, explicit, equivalents):
    """Yeni kural: kullanici yazdiysa o, yoksa adet basina esdeger (en az 1)."""
    flat = _f(params.get(FLAT_KEY[stage]))
    if FLAT_KEY[stage] in explicit and flat and flat > 0:
        return max(1, round(flat))
    return equivalents[stage] or 1


def upgrade() -> None:
    bind = op.get_bind()

    work_hours = bind.execute(
        sa.text("SELECT value FROM app_settings WHERE key = 'work_hours_per_day'")
    ).scalar()
    try:
        work_minutes = float(work_hours) * 60
    except (TypeError, ValueError):
        work_minutes = 480.0

    emp_rows = bind.execute(
        sa.text("SELECT order_id::text, split_id::text, step_key, employee_count FROM step_employee_assignments")
    ).fetchall()
    emp_by_split, emp_by_order = {}, {}
    for row in emp_rows:
        target = emp_by_split.setdefault(row.split_id, {}) if row.split_id else emp_by_order.setdefault(row.order_id, {})
        target[row.step_key] = float(row.employee_count or 1)

    splits = bind.execute(
        sa.text(
            """
            SELECT s.id::text AS split_id, s.order_id::text AS order_id, o.external_id,
                   s.quantity, s.on_hand_quantity, s.is_outsourced,
                   s.param_overrides, o.base_data
            FROM delivery_splits s
            JOIN orders o ON o.id = s.order_id
            WHERE NOT s.is_deleted AND NOT o.is_deleted
            """
        )
    ).fetchall()

    dondurulan = 0
    for row in splits:
        base = row.base_data or {}
        overrides = dict(row.param_overrides or {})
        params = {**base, **overrides}
        explicit = {
            k for k in FLAT_KEY.values()
            if isinstance(overrides.get(k), (int, float)) and overrides.get(k) > 0
        }
        qty = max(float(row.quantity or 0) - float(row.on_hand_quantity or 0), 0.0)
        emp_raw = emp_by_split.get(row.split_id) or emp_by_order.get(row.order_id) or {}
        emp = {k: emp_raw.get(k, 1.0) for k in ("assembly", "production", "test")}
        equivalents = _equivalents(params, qty, emp, work_minutes)
        is_fason = _outsourced(params, bool(row.is_outsourced))

        degisen = {}
        for stage in ("assembly", "production", "test"):
            # Fason parcalarda Dizgi zaten moddan bagimsizdi — dal degismedi.
            if stage == "assembly" and is_fason:
                continue
            eski = _old_days(stage, params, explicit, equivalents)
            yeni = _new_days(stage, params, explicit, equivalents)
            if eski is not None and eski != yeni:
                degisen[FLAT_KEY[stage]] = float(eski)

        if not degisen:
            continue
        overrides.update(degisen)
        bind.execute(
            sa.text("UPDATE delivery_splits SET param_overrides = CAST(:ov AS jsonb) WHERE id = CAST(:id AS uuid)"),
            {"ov": json.dumps(overrides), "id": row.split_id},
        )
        dondurulan += 1
        logger.info("  dondurmak: %s / %s -> %s", row.external_id, row.split_id[:8], degisen)

    logger.warning(
        "[sure modu] %d parcanin asama suresi eski degerinde donduruldu (toplam %d aktif parca). "
        "Bu parcalarin cizelgesi deploy ile DEGISMEZ.",
        dondurulan, len(splits),
    )


def downgrade() -> None:
    """Geri alinamaz: hangi degerin bu migration tarafindan yazildigi, kullanicinin
    kendi yazdigindan ayirt edilemez. Yanlislikla kullanici degerlerini silmemek icin
    bilincli olarak dokunulmuyor."""
    pass
