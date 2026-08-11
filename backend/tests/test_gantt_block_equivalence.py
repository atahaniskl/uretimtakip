"""
FAZ 2.1'İN GÜVENCESİ — gantt.py'deki kopyalanmış süre hesabı ile kanonik
`date_utils._block_days` aynı sonucu veriyor mu?

DURUM
-----
`gantt.py::get_gantt_tasks` (satır ~941-1090) blok sürelerini KENDİ İÇİNDE elle
hesaplıyor: supply_d, assembly_stage_days, production_stage_days,
test_stage_days, delivery_d. Bu, `date_utils._block_days`'in ikinci bir
kopyasıdır. Kopyanın tek gerçek kullanımı satır 1093'teki "hiç aşama var mı?"
kontrolüdür; gerçek tarih hesabı zaten satır 1131'de `calculate_split_stage_ranges`
ile yapılır.

BU TESTİN AMACI
---------------
Faz 2.1'de o 150 satır silinip yerine doğrudan kanonik fonksiyon konacak.
Bu test SİLMEDEN ÖNCE yazıldı ve iki implementasyonun bugün aynı sonucu
verdiğini kanıtlıyor. Silme işleminden sonra da yeşil kalmalı — kalırsa
refactor davranışı değiştirmemiş demektir.

Test kırmızıya dönerse: iki implementasyon SAPMIŞ demektir; bu, ekranda
gösterilen aşama çubuklarıyla kaydedilen tarihlerin uyuşmadığı gerçek bir
bug'ın habercisidir.

ÖMÜR
----
Bu dosya geçici bir iskeledir. Faz 2.1 tamamlanıp gantt.py'deki kopya
silindiğinde BU DOSYA DA SİLİNMELİDİR — karşılaştıracak ikinci implementasyon
kalmayacaktır.
"""

import math

import pytest

from app.core.date_utils import _block_days

WORK_MINUTES = 480.0


def gantt_inline_block_days(
    params: dict,
    qty: float,
    emp: dict[str, float],
    work_minutes: float,
    is_outsourced: bool,
) -> dict[str, int | float | None]:
    """gantt.py::get_gantt_tasks satır 941-1090'daki hesabın BİREBİR kopyası.

    Kasıtlı olarak orijinaldeki değişken adları, sıralama ve ifade biçimi
    korunmuştur — amaç okunabilirlik değil, karşılaştırılan şeyin gerçekten
    gantt.py'deki mantık olduğundan emin olmaktır. Buradaki herhangi bir
    "iyileştirme" testin değerini yok eder.
    """
    s_assembly = emp.get("assembly", 1.0)
    s_production = emp.get("production", 1.0)
    s_test = emp.get("test", 1.0)

    supply_d = params.get("supply_days")
    if not supply_d or supply_d <= 0:
        supply_d = 1

    assembly_d = params.get("production_days") or params.get("assembly_days")
    epoxy_m = params.get("epoxy_minutes")
    conformal_m = params.get("conformal_minutes")
    montaj_m = params.get("montaj_minutes")
    kalite_m = params.get("quality_minutes")
    montaj_kalite_m = params.get("montaj_kalite_minutes")
    test1_m = params.get("test1_minutes")
    test2_m = params.get("test2_minutes")
    final_test_m = params.get("final_test_minutes")

    delivery_d = params.get("delivery_days")
    if not delivery_d or delivery_d <= 0:
        delivery_d = 1

    flat_mode = params.get("duration_mode") != "per_unit"
    production_flat_d = params.get("production_flat_days")
    test_flat_d = params.get("test_flat_days")
    assembly_flat_d = params.get("assembly_flat_days")

    if is_outsourced:
        assembly_stage_days = max(1, round(assembly_d if assembly_d and assembly_d > 0 else 1))
    else:
        assembly_equivalent_days = (
            max(1, math.ceil(assembly_d * qty / s_assembly)) if assembly_d and assembly_d > 0 else None
        )
        if flat_mode:
            assembly_stage_days = max(
                1,
                round(
                    assembly_flat_d
                    if assembly_flat_d and assembly_flat_d > 0
                    else (assembly_equivalent_days or 1)
                ),
            )
        else:
            assembly_stage_days = assembly_equivalent_days

    production_total_m = sum(filter(None, [kalite_m, epoxy_m, conformal_m, montaj_m, montaj_kalite_m]))
    test_total_m = sum(filter(None, [test1_m, test2_m, final_test_m]))
    production_equivalent_days = (
        max(1, math.ceil(production_total_m * qty / (work_minutes * s_production)))
        if production_total_m
        else None
    )
    test_equivalent_days = (
        max(1, math.ceil(test_total_m * qty / (work_minutes * s_test))) if test_total_m else None
    )
    if flat_mode:
        production_stage_days = max(
            1,
            round(
                production_flat_d
                if production_flat_d and production_flat_d > 0
                else (production_equivalent_days or 1)
            ),
        )
        test_stage_days = max(
            1, round(test_flat_d if test_flat_d and test_flat_d > 0 else (test_equivalent_days or 1))
        )
    else:
        production_stage_days = production_equivalent_days
        test_stage_days = test_equivalent_days

    return {
        "supply": supply_d,
        "assembly": assembly_stage_days,
        "production": production_stage_days,
        "test": test_stage_days,
        "delivery": delivery_d,
    }


def canonical_block_days(
    params: dict,
    qty: float,
    emp: dict[str, float],
    work_minutes: float,
    is_outsourced: bool,
) -> dict[str, int | float | None]:
    """Kanonik kaynak: date_utils._block_days, beş blok için."""
    return {
        key: _block_days(key, params, qty, emp, work_minutes, is_outsourced)
        for key in ("supply", "assembly", "production", "test", "delivery")
    }


# --- Karşılaştırma matrisi ----------------------------------------------------

PARAM_SENARYOLARI = [
    pytest.param({}, id="bos-parametreler"),
    pytest.param({"supply_days": 3, "delivery_days": 2}, id="sadece-tedarik-teslimat"),
    pytest.param({"assembly_days": 2}, id="dizgi-gun-basi-mod-belirtilmemis"),
    pytest.param({"assembly_days": 2, "duration_mode": "per_unit"}, id="dizgi-per-unit"),
    pytest.param({"assembly_days": 2, "duration_mode": "flat"}, id="dizgi-flat-alan-bos"),
    pytest.param(
        {"assembly_days": 2, "assembly_flat_days": 7, "duration_mode": "flat"}, id="dizgi-flat-dolu"
    ),
    pytest.param(
        {"duration_mode": "per_unit", "epoxy_minutes": 60, "montaj_minutes": 90}, id="uretim-per-unit"
    ),
    pytest.param(
        {"duration_mode": "per_unit", "quality_minutes": 30, "montaj_kalite_minutes": 45},
        id="uretim-kalite-alanlari",
    ),
    pytest.param(
        {"duration_mode": "flat", "production_flat_days": 4, "epoxy_minutes": 60},
        id="uretim-flat-dolu",
    ),
    pytest.param(
        {"duration_mode": "flat", "epoxy_minutes": 600}, id="uretim-flat-alan-bos-dakika-var"
    ),
    pytest.param(
        {"duration_mode": "per_unit", "test1_minutes": 120, "test2_minutes": 90, "final_test_minutes": 30},
        id="test-per-unit",
    ),
    pytest.param({"duration_mode": "flat", "test_flat_days": 3}, id="test-flat-dolu"),
    pytest.param(
        {
            "supply_days": 5,
            "assembly_days": 1.5,
            "delivery_days": 2,
            "duration_mode": "per_unit",
            "epoxy_minutes": 45,
            "conformal_minutes": 15,
            "montaj_minutes": 60,
            "quality_minutes": 20,
            "montaj_kalite_minutes": 25,
            "test1_minutes": 80,
            "test2_minutes": 40,
            "final_test_minutes": 20,
        },
        id="tum-alanlar-per-unit",
    ),
    pytest.param(
        {
            "supply_days": 5,
            "assembly_days": 1.5,
            "assembly_flat_days": 2.5,
            "production_flat_days": 3.5,
            "test_flat_days": 1.5,
            "delivery_days": 2,
            "duration_mode": "flat",
        },
        id="ondalik-degerler-flat-bankaci-yuvarlamasi",
    ),
    pytest.param(
        {"production_days": 4, "assembly_days": 2, "duration_mode": "per_unit"},
        id="production-days-assembly-days-onceligi",
    ),
    pytest.param({"supply_days": 0, "delivery_days": 0}, id="sifir-degerler"),
    pytest.param({"supply_days": None, "delivery_days": None}, id="none-degerler"),
]

MIKTARLAR = [1, 2, 7, 10, 100]
ISCI_KUMELERI = [
    {"assembly": 1.0, "production": 1.0, "test": 1.0},
    {"assembly": 2.0, "production": 3.0, "test": 2.0},
    {"assembly": 0.5, "production": 1.5, "test": 2.5},
]


@pytest.mark.parametrize("params", PARAM_SENARYOLARI)
@pytest.mark.parametrize("qty", MIKTARLAR)
@pytest.mark.parametrize("emp", ISCI_KUMELERI, ids=["isci-1-1-1", "isci-2-3-2", "isci-kesirli"])
@pytest.mark.parametrize("fason", [False, True], ids=["ic-uretim", "fason"])
def test_gantt_inline_hesap_kanonik_ile_ayni(params, qty, emp, fason):
    """gantt.py'deki kopya ile date_utils._block_days beş blokta da aynı
    sonucu vermeli. 18 parametre senaryosu x 5 miktar x 3 işçi kümesi x 2
    fason durumu = 540 kombinasyon."""
    inline = gantt_inline_block_days(params, qty, emp, WORK_MINUTES, fason)
    kanonik = canonical_block_days(params, qty, emp, WORK_MINUTES, fason)

    assert inline == kanonik, (
        f"SAPMA TESPİT EDİLDİ\n"
        f"  params={params}\n  qty={qty} emp={emp} fason={fason}\n"
        f"  gantt.py inline : {inline}\n"
        f"  date_utils      : {kanonik}"
    )


def test_qty_normalizasyonu_farki_bilinen_tek_sapmadir():
    """TEK BİLİNEN FARK — ve gerçek bir sapma değil.

    `_block_days` kendi içinde qty normalizasyonu YAPMAZ; çağıranı
    (`calculate_split_stage_ranges`) `qty = max(1, quantity or 1)` uygular.
    gantt.py de aynısını çağrıdan önce yapar (satır 925:
    `qty = max(1, effective_split_quantity(ds) or 1)`).

    Yani her iki taraf da _block_days'e normalize edilmiş qty geçirir; bu test
    o ön koşulun altında karşılaştırma yaptığımızı belgeler."""
    emp = {"assembly": 1.0, "production": 1.0, "test": 1.0}
    params = {"assembly_days": 2, "duration_mode": "per_unit"}

    normalize_edilmis = max(1, 0 or 1)
    assert normalize_edilmis == 1
    assert gantt_inline_block_days(params, normalize_edilmis, emp, WORK_MINUTES, False) == \
        canonical_block_days(params, normalize_edilmis, emp, WORK_MINUTES, False)
