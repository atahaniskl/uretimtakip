"""
Frontend paritesi için "altın değer" (golden) üreticisi.

NEDEN
-----
`frontend/src/lib/scheduleMath.ts`, backend `app/core/date_utils.py`'nin elle
yazılmış bir TypeScript port'udur. Bu duplikasyon KALDIRILAMAZ — kullanıcı formda
tarih değiştirirken anlık önizleme görmeli, her tuş vuruşunda backend'e gidilemez.

Kaldırılamayan duplikasyonun tek savunması, iki tarafın SESSİZCE sapmamasını
garanti etmektir. Bu script backend'in ürettiği sonuçları JSON'a yazar; frontend
tarafındaki vitest testi (scheduleMath.golden.test.ts) aynı girdiler için kendi
sonucunu üretip bu dosyayla karşılaştırır.

KULLANIM
--------
    cd backend && python tests/generate_frontend_golden.py

Çıktı: frontend/src/lib/__tests__/blockDays.golden.json

NE ZAMAN YENİDEN ÇALIŞTIRILMALI
-------------------------------
`date_utils._block_days` içindeki bir kural BİLİNÇLİ olarak değiştirildiğinde:
önce burayı çalıştır, sonra frontend testini çalıştır. Frontend testi kırmızıysa
scheduleMath.ts de aynı şekilde güncellenmeli — kırmızı test tam olarak bunu
hatırlatmak için vardır.

Frontend testi, JSON dosyasına DOKUNULMADAN kırmızıya dönerse: scheduleMath.ts
backend'den sapmış demektir (gerçek bug).
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.date_utils import _block_days  # noqa: E402

WORK_MINUTES = 480.0

# scheduleMath.ts'in blockDays fonksiyonunun kapsadığı tüm dallar burada
# temsil edilmeli. Yeni bir dal eklenirse (yeni bir duration_mode gibi)
# buraya da bir senaryo eklenmelidir.
PARAM_SENARYOLARI: list[dict] = [
    {},
    {"supply_days": 3, "delivery_days": 2},
    {"supply_days": 0, "delivery_days": 0},
    {"assembly_days": 2},
    {"assembly_days": 2, "duration_mode": "per_unit"},
    {"assembly_days": 2, "duration_mode": "flat"},
    {"assembly_days": 2, "assembly_flat_days": 7, "duration_mode": "flat"},
    {"assembly_days": 1.5, "assembly_flat_days": 2.5, "duration_mode": "flat"},
    {"production_days": 4, "assembly_days": 2, "duration_mode": "per_unit"},
    {"duration_mode": "per_unit", "epoxy_minutes": 60, "montaj_minutes": 90},
    {"duration_mode": "per_unit", "quality_minutes": 30, "montaj_kalite_minutes": 45},
    {"duration_mode": "per_unit", "conformal_minutes": 25},
    {"duration_mode": "flat", "production_flat_days": 4, "epoxy_minutes": 60},
    {"duration_mode": "flat", "production_flat_days": 3.5},
    {"duration_mode": "flat", "epoxy_minutes": 600},
    {"duration_mode": "per_unit", "test1_minutes": 120, "test2_minutes": 90, "final_test_minutes": 30},
    {"duration_mode": "flat", "test_flat_days": 3},
    {"duration_mode": "flat", "test_flat_days": 1.5},
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
    {
        "supply_days": 5,
        "assembly_days": 1.5,
        "assembly_flat_days": 2.5,
        "production_flat_days": 3.5,
        "test_flat_days": 1.5,
        "delivery_days": 2,
        "duration_mode": "flat",
    },
]

MIKTARLAR = [1, 2, 7, 10, 100]
ISCI_KUMELERI = [
    {"assembly": 1.0, "production": 1.0, "test": 1.0},
    {"assembly": 2.0, "production": 3.0, "test": 2.0},
    {"assembly": 0.5, "production": 1.5, "test": 2.5},
]
BLOKLAR = ["supply", "assembly", "production", "test", "delivery"]


def main() -> None:
    kayitlar = []
    for params in PARAM_SENARYOLARI:
        for qty in MIKTARLAR:
            for emp in ISCI_KUMELERI:
                for fason in (False, True):
                    # calculate_split_stage_ranges'in uyguladığı normalizasyon;
                    # frontend blockDays çağrılarında da aynısı yapılır.
                    normalize_qty = max(1, qty or 1)
                    kayitlar.append({
                        "params": params,
                        "qty": normalize_qty,
                        "emp": emp,
                        "workMinutes": WORK_MINUTES,
                        "isOutsourced": fason,
                        "expected": {
                            blok: _block_days(blok, params, normalize_qty, emp, WORK_MINUTES, fason)
                            for blok in BLOKLAR
                        },
                    })

    hedef = (
        Path(__file__).resolve().parents[2]
        / "frontend" / "src" / "lib" / "__tests__" / "blockDays.golden.json"
    )
    hedef.parent.mkdir(parents=True, exist_ok=True)
    hedef.write_text(
        json.dumps(
            {
                "_aciklama": (
                    "OTOMATİK ÜRETİLDİ — elle düzenlemeyin. "
                    "Kaynak: backend/tests/generate_frontend_golden.py "
                    "(backend app/core/date_utils.py::_block_days çıktısı). "
                    "Bu dosya, frontend scheduleMath.ts'in backend ile aynı sonucu "
                    "verdiğini doğrulayan parite testinin referansıdır."
                ),
                "workMinutes": WORK_MINUTES,
                "cases": kayitlar,
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    print(f"{len(kayitlar)} altın değer yazıldı -> {hedef}")


if __name__ == "__main__":
    main()
