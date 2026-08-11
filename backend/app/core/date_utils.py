from __future__ import annotations

import math
from datetime import date, datetime, timedelta


def is_workday(d: date, holidays: set[date]) -> bool:
    return d.weekday() < 5 and d not in holidays


def subtract_workdays(end: datetime, workdays: int, holidays: set[date]) -> datetime:
    if workdays <= 0:
        return end
    remaining = workdays
    current = end
    while remaining > 0:
        current -= timedelta(days=1)
        if is_workday(current.date(), holidays):
            remaining -= 1
    return current


def add_workdays(start: datetime, workdays: int, holidays: set[date]) -> datetime:
    if workdays <= 0:
        return start
    remaining = workdays
    current = start
    while remaining > 0:
        if is_workday(current.date(), holidays):
            remaining -= 1
        current += timedelta(days=1)
    return current


_FASON_KEYS = ("is_outsourced", "outsourced", "fason", "fason_mu", "fason_mi")
_FASON_TRUE_TOKENS = {"1", "true", "t", "yes", "y", "evet", "e", "fason", "dis", "dış", "outsource", "outsourced"}
_FASON_FALSE_TOKENS = {"0", "false", "f", "no", "n", "hayir", "hayır", "h", "ic", "iç", "inhouse", "internal", "kendi"}
_FASON_MODE_KEYS = ("production_mode", "production_type", "uretim_tipi", "uretim_turu", "uretim_sekli")
_FASON_MODE_TRUE_TOKENS = ("fason", "outsource", "external", "dis", "dış", "subcontract")
_FASON_MODE_FALSE_TOKENS = ("ic", "iç", "kendi", "internal", "inhouse", "machine")


def is_outsourced_from_base_data(base_data: dict | None) -> bool | None:
    """Tolerant "is this order outsourced (fason)" detector for order base_data —
    single source of truth shared by gantt.py (main Gantt view), order_details.py
    (order-details preview modal/timeline editor), and app_settings.py (employee
    capacity calc), so all three surfaces agree on the same order's outsourcing
    status. Returns None when base_data gives no signal either way (caller decides
    the default, usually False).
    """
    base = base_data or {}

    for key in _FASON_KEYS:
        raw = base.get(key)
        if raw is None:
            continue
        if isinstance(raw, bool):
            return raw
        val = str(raw).strip().lower()
        if val in _FASON_TRUE_TOKENS:
            return True
        if val in _FASON_FALSE_TOKENS:
            return False

    # Fallback: textual production mode field
    for key in _FASON_MODE_KEYS:
        raw = base.get(key)
        if raw is None:
            continue
        val = str(raw).strip().lower()
        if not val:
            continue
        if any(token in val for token in _FASON_MODE_TRUE_TOKENS):
            return True
        if any(token in val for token in _FASON_MODE_FALSE_TOKENS):
            return False

    return None


# Aşamaların "toplam iş günü" alanları. Bu alanlara BİR PARÇA İÇİN yazılan değer,
# ürünün süre modundan bağımsız olarak o parçanın süresini belirler.
FLAT_DAYS_KEYS = ("assembly_flat_days", "production_flat_days", "test_flat_days")

# effective_product_params'ın sonuca eklediği ayrılmış anahtar — hangi toplam-gün
# alanlarının kullanıcı tarafından bu parçaya özel yazıldığını taşır. Ayrılmış
# (alt çizgiyle başlayan) isim, base_data'daki `_manual_steps` ile aynı desen.
EXPLICIT_FLAT_KEYS_FIELD = "_explicit_flat_keys"


def effective_product_params(order_base_data: dict | None, split_overrides: dict | None) -> dict:
    """Sipariş-geneli üretim parametrelerini (`orders.base_data`), bu parçaya özel
    geçersiz kılmalarla (`DeliverySplit.param_overrides`) birleştirir — override'da
    olmayan anahtarlar sipariş değerinden miras alınır. Tek paylaşılan kaynak:
    order_details.py/gantt.py/app_settings.py'deki her per-split hesaplama noktası
    bunu kullanır, aksi halde parçalar arasında (fason-etiket tutarsızlığında
    olduğu gibi) sessiz bir sapma riski oluşur.

    Ayrıca sonuca `EXPLICIT_FLAT_KEYS_FIELD` eklenir: kullanıcının BU PARÇAYA
    açıkça yazdığı toplam-gün alanlarının listesi. Birleştirme sonrası bir değerin
    sipariş genelinden mi (ürün ana verisinden otomatik dolan) yoksa kullanıcının
    elinden mi geldiği anlaşılamaz; oysa `_block_days` bu ayrımı yapmak zorunda —
    kullanıcının yazdığı gün sayısı süre modundan BAĞIMSIZ olarak kesindir."""
    merged = {**(order_base_data or {}), **(split_overrides or {})}
    explicit = [
        key
        for key in FLAT_DAYS_KEYS
        if isinstance((split_overrides or {}).get(key), (int, float))
        and (split_overrides or {}).get(key) > 0
    ]
    merged[EXPLICIT_FLAT_KEYS_FIELD] = explicit
    return merged


def effective_split_quantity(split) -> float:
    """Bir DeliverySplit'in TARIH/SURE hesabina giren efektif miktarini dondurur:
    quantity (Teslimat Adedi — sabit nominal ihtiyac) eksi on_hand_quantity (bilesen
    siparisler icin elde mevcut stok, absolute/uzerine-yazilan). Ana siparis
    split'lerinde on_hand_quantity hep 0/None oldugundan sonuc quantity'ye esittir.
    Yalnizca hesaba giren yerlerde kullanilmali — GORUNTULEME/echo amacli quantity
    okumalari (Teslimat Adedi etiketi vb.) buna dokunmaz."""
    return max((split.quantity or 0.0) - (split.on_hand_quantity or 0.0), 0.0)


def build_product_params(base_data: dict | None) -> dict:
    """
    Extract production params from an order's (or component order's) base_data.
    Reads all stage fields (supply_days, assembly_days, minute-based fields, delivery_days)
    trying several field-name aliases (Excel imports use varying Turkish/English column names).
    Returns a dict; values may be None. Shared by gantt.py and order_details.py so both
    agree on the same alias/normalization rules — a single source of truth.
    """
    base = base_data or {}

    # ---- Tedarik süresi (supply lead-time, iş günü) ----
    supply_days: float | None = None
    for key in (
        "supply_days",
        "tedarik_suresi",
        "tedarik_süresi",
        "tedarik_gunu",
        "tedarik_günü",
        "lead_time",
        "lead_time_days",
        "tedarik",
    ):
        raw = base.get(key)
        if raw is not None:
            try:
                supply_days = float(str(raw))
            except (ValueError, TypeError):
                pass
            break

    # ---- Üretim / Assembly süresi (production/assembly, iş günü) ----
    production_days: float | None = None
    for key in (
        "production_days",
        "assembly_days",
        "uretim_suresi",
        "üretim_süresi",
        "uretim_gunu",
        "üretim_günü",
        "production_time",
        "assembly",
        "uretim",
        "üretim",
    ):
        raw = base.get(key)
        if raw is not None:
            try:
                production_days = float(str(raw))
            except (ValueError, TypeError):
                pass
            break

    # ---- Minute-based production stage fields (dk/adet) ----
    def _get_float(key: str) -> float | None:
        raw = base.get(key)
        if raw is not None:
            try:
                return float(str(raw))
            except (ValueError, TypeError):
                pass
        return None

    epoxy_minutes = _get_float("epoxy_minutes")
    conformal_minutes = _get_float("conformal_minutes")
    montaj_minutes = _get_float("montaj_minutes")
    quality_minutes = _get_float("quality_minutes")
    montaj_kalite_minutes = _get_float("montaj_kalite_minutes")
    test1_minutes = _get_float("test1_minutes")
    test2_minutes = _get_float("test2_minutes")
    final_test_minutes = _get_float("final_test_minutes")

    # ---- Fason (dış dizgi) süresi (iş günü, düz) ----
    outsource_days: float | None = None
    for key in ("outsource_days", "fason_days", "fason_suresi", "fason_süresi", "fason_gunu", "fason_günü"):
        raw = base.get(key)
        if raw is not None:
            try:
                outsource_days = float(str(raw))
            except (ValueError, TypeError):
                pass
            break

    delivery_days: float | None = None
    for key in ("delivery_days", "teslimat_suresi", "delivery_time", "teslimat"):
        raw = base.get(key)
        if raw is not None:
            try:
                delivery_days = float(str(raw))
            except (ValueError, TypeError):
                pass
            break

    # ---- Adet/Gün modu (tek anahtar, dizgi+üretim+test'i birden etkiler) ----
    duration_mode = base.get("duration_mode")
    production_flat_days = _get_float("production_flat_days")
    test_flat_days = _get_float("test_flat_days")
    assembly_flat_days = _get_float("assembly_flat_days")

    return {
        "supply_days": supply_days,
        "production_days": production_days,
        "outsource_days": outsource_days,
        "epoxy_minutes": epoxy_minutes,
        "conformal_minutes": conformal_minutes,
        "montaj_minutes": montaj_minutes,
        "quality_minutes": quality_minutes,
        "montaj_kalite_minutes": montaj_kalite_minutes,
        "test1_minutes": test1_minutes,
        "test2_minutes": test2_minutes,
        "final_test_minutes": final_test_minutes,
        "delivery_days": delivery_days,
        "duration_mode": duration_mode,
        "production_flat_days": production_flat_days,
        "test_flat_days": test_flat_days,
        "assembly_flat_days": assembly_flat_days,
        # effective_product_params'tan geldiyse aynen taşınır — bazı çağıranlar
        # birleştirilmiş params'ı doğrudan _block_days'e verirken bazıları önce
        # buradan geçiriyor; iki yol da aynı bilgiyi taşımalı.
        EXPLICIT_FLAT_KEYS_FIELD: list(base.get(EXPLICIT_FLAT_KEYS_FIELD) or ()),
    }


BLOCK_KEYS = ["supply", "assembly", "production", "test", "delivery"]

_PRODUCTION_MINUTE_FIELDS = [
    "quality_minutes",
    "epoxy_minutes",
    "conformal_minutes",
    "montaj_minutes",
    "montaj_kalite_minutes",
]

_TEST_MINUTE_FIELDS = [
    "test1_minutes",
    "test2_minutes",
    "final_test_minutes",
]


def _block_days(
    key: str,
    product_params: dict,
    qty: float,
    emp: dict[str, float],
    work_minutes: float,
    is_outsourced: bool = False,
) -> int | float | None:
    a_emp = emp.get("assembly", 1.0)
    p_emp = emp.get("production", 1.0)
    t_emp = emp.get("test", 1.0)
    # SÜRE MODU YOK. Dizgi/Üretim/Test'in varsayılan süresi HER ZAMAN adet başına
    # veriden hesaplanır (Dizgi: gün/adet × adet, Üretim/Test: dakika/adet × adet).
    # Eski "İş Günü (flat)" modu kaldırıldı: aynı sayı bir üründe "toplam gün", bir
    # başkasında "adet başına gün" anlamına geldiği için ekranla hesap sürekli
    # çelişiyordu. `duration_mode` ve ürün ana verisindeki *_flat_days alanları artık
    # ZAMANLAMAYI ETKİLEMEZ.
    #
    # Tek istisna, kullanıcının BU PARÇAYA açıkça yazdığı toplam-gün değeridir
    # (EXPLICIT_FLAT_KEYS_FIELD): sipariş özelinde "bu parçanın Dizgi'si 12 iş günü
    # sürecek" denebilir ve o değer kesindir — adetle çarpılmaz, işçi sayısına
    # bölünmez. Atanan işçiler yine de o süre boyunca meşgul sayılır.
    explicit_flat = set(product_params.get(EXPLICIT_FLAT_KEYS_FIELD) or ())

    def _resolve_flat(flat_key: str) -> int | None:
        """Kullanıcının bu parçaya yazdığı gün sayısı — yoksa None (adet başına hesap)."""
        flat_days = product_params.get(flat_key)
        if flat_key in explicit_flat and flat_days and flat_days > 0:
            return max(1, round(flat_days))
        return None

    if key == "supply":
        # Tedarik de Teslimat gibi en az 1 gün var sayılır (girilmemiş/0 olsa bile) —
        # aksi halde Gün modunda boş bırakılan bu alan yüzünden Tedarik bloğu hiç
        # oluşmaz (bkz. delivery'deki aynı gerekçe).
        supply_d = product_params.get("supply_days")
        return supply_d if supply_d and supply_d > 0 else 1
    if key == "assembly":
        assembly_d = product_params.get("production_days") or product_params.get("assembly_days")
        if is_outsourced:
            # Fason (dış dizgi): iş dışarıda yapılır, iş yükü hesaplanmaz — kullanıcının
            # Dizgi alanına girdiği gün sayısı DOĞRUDAN kullanılır (adetle çarpılmaz,
            # işçi sayısına bölünmez), moddan (flat/per_unit) BAĞIMSIZ; sadece takip
            # amaçlıdır. Eskiden ayrı bir outsource_days alanı gerekiyordu — artık aynı
            # Dizgi alanı (assembly_days) fason parçalarda da kullanılıyor. Boş
            # bırakılırsa (Gün modunda bar oluşmasın diye) en az 1 gün var sayılır.
            days = assembly_d if assembly_d and assembly_d > 0 else 1
            return max(1, round(days))
        # assembly_d artık HER ZAMAN "gün/adet" (Adet Başına) anlamına gelir — Gün
        # modundaki "toplam gün" ayrı bir alanda (assembly_flat_days) tutulur,
        # production_flat_days/test_flat_days ile aynı desen.
        equivalent = max(1, math.ceil(assembly_d * qty / a_emp)) if assembly_d and assembly_d > 0 else None
        resolved = _resolve_flat("assembly_flat_days")
        # Adet başına verisi hiç yoksa aşama YOK SAYILMAZ, en az 1 iş günü var
        # sayılır — Tedarik/Teslimat ile aynı taban. Aksi halde verisi eksik bir
        # üründe blok tamamen düşer (bkz. calculate_split_stage_ranges'teki
        # "if not days: continue") ve adım Gantt'tan sessizce kaybolur.
        return resolved if resolved is not None else (equivalent or 1)
    if key == "production":
        total_minutes = sum(
            product_params.get(f, 0) or 0
            for f in _PRODUCTION_MINUTE_FIELDS
        )
        equivalent = max(1, math.ceil(total_minutes * qty / (work_minutes * p_emp))) if total_minutes > 0 else None
        resolved = _resolve_flat("production_flat_days")
        # Adet başına verisi hiç yoksa aşama YOK SAYILMAZ, en az 1 iş günü var
        # sayılır — Tedarik/Teslimat ile aynı taban. Aksi halde verisi eksik bir
        # üründe blok tamamen düşer (bkz. calculate_split_stage_ranges'teki
        # "if not days: continue") ve adım Gantt'tan sessizce kaybolur.
        return resolved if resolved is not None else (equivalent or 1)
    if key == "test":
        total_minutes = sum(
            product_params.get(f, 0) or 0
            for f in _TEST_MINUTE_FIELDS
        )
        equivalent = max(1, math.ceil(total_minutes * qty / (work_minutes * t_emp))) if total_minutes > 0 else None
        resolved = _resolve_flat("test_flat_days")
        # Adet başına verisi hiç yoksa aşama YOK SAYILMAZ, en az 1 iş günü var
        # sayılır — Tedarik/Teslimat ile aynı taban. Aksi halde verisi eksik bir
        # üründe blok tamamen düşer (bkz. calculate_split_stage_ranges'teki
        # "if not days: continue") ve adım Gantt'tan sessizce kaybolur.
        return resolved if resolved is not None else (equivalent or 1)
    if key == "delivery":
        # Teslimat adımı her zaman en az 1 gün olarak var sayılır (girilmemiş/0 olsa
        # bile) — aksi halde bu blok tamamen düşer ve "Özet" takvim gibi yalnızca
        # Teslimat aşamasına göre filtreleyen görünümlerde sipariş tamamen kaybolur.
        delivery_d = product_params.get("delivery_days")
        return delivery_d if delivery_d and delivery_d > 0 else 1
    return None


def calculate_split_stage_ranges(
    end_date: datetime,
    quantity: float,
    product_params: dict,
    emp: dict[str, float],
    work_minutes: float,
    holidays: set[date],
    is_outsourced: bool = False,
    component_ready_at: datetime | None = None,
    include_delivery: bool = True,
    start_date: datetime | None = None,
) -> list[dict]:
    qty = max(1, quantity or 1)
    cur_end = end_date

    if component_ready_at is not None:
        # get_components_ready_at, bileşen split'lerinin HAM end_date'inin (MAX)
        # üzerinden gelir — bileşenlerde Teslimat adımı zaten hiç yok (include_delivery
        # False), yani bu tarih artık gerçek bir teslimat değil, sadece geriye-doğru
        # hesabın anchor'ı. Hafta sonuna/tatile denk geldiğinde (ör. Pazar), o
        # bileşenin GERÇEK son iş günü aslında bundan önceki Cuma'dır — ama Pazar'ın
        # kendisi hâlâ "işte" sayılırsa ana montajın Tedarik/Üretim'i gereksiz yere
        # o hafta sonu boyunca beklermiş gibi 2 gün fazladan uzar. Aşağıdaki blokların
        # kendi başlangıç tarihini bulmak için yaptığı AYNI geriye-doğru iş günü
        # yuvarlaması burada component_ready_at'e de uygulanır.
        while not is_workday(component_ready_at.date(), holidays):
            component_ready_at -= timedelta(days=1)
    blocks: list[dict] = []

    for block_key in reversed(BLOCK_KEYS):
        if block_key == "delivery" and not include_delivery:
            continue
        # BOM ana siparişi: Dizgi, bileşenlerin kendi dizgisiyle yapılmış sayılır ve
        # blok listesinden TAMAMEN çıkarılır — "delivery" atlamasıyla AYNI yerde
        # (döngü İÇİNDE, days tüketilmeden ÖNCE) kontrol edilmesi şart. Eskiden bu
        # kontrol döngüden SONRA (yalnızca `blocks` listesini filtreleyerek) yapılıyordu
        # — Dizgi'nin kendi süresi (ör. 1 iş günü + üstüne binen hafta sonu) yine de
        # cur_end'den düşülmüş oluyordu, bu da Tedarik'in (ve varsa start_date'in)
        # olması gerekenden birkaç gün ERKEN hesaplanmasına yol açıyordu — JS
        # tarafındaki (scheduleMath.ts computeSuggestedBlocks) "Teslimat'ı atla"
        # deseniyle birebir aynı sınıf hata.
        if block_key == "assembly" and component_ready_at is not None:
            continue
        # DİKKAT: burada cur_end'i en yakın iş gününe önceden yuvarlayan bir adım
        # OLMAMALI. subtract_workdays(cur_end, ...) zaten İLK ADIMDA bir gün geriye
        # gidip ONDAN SONRA iş günü olup olmadığını kontrol ediyor (bkz. yukarıdaki
        # fonksiyon tanımı) — yani cur_end bizzat hafta sonu/tatile denk gelse bile
        # doğru sonucu üretir. Buraya (subtract_workdays'den ÖNCE) ayrı bir
        # "en yakın iş gününe yuvarla" döngüsü eklenirse, cur_end zaten hafta
        # sonuna denk geldiğinde bir önceki iş günü İKİ KEZ atlanmış olur — bu,
        # end_date'i hafta sonuna denk gelen split'lerin start_date'inin canlı
        # veride 1 iş günü ERKEN hesaplanmasına yol açan gerçek bir bug'dı (bkz.
        # ilgili inceleme — örn. end_date=Cumartesi olan bir bileşen split'inde
        # start_date sessizce 1 gün erken çıkıyordu). subtract_workdays'in kendi
        # decrement-first mantığı zaten bunu doğru ele aldığı için bu adım
        # kaldırıldı, tekrar eklenmemeli.
        days = _block_days(block_key, product_params, qty, emp, work_minutes, is_outsourced)
        if not days or days <= 0:
            continue
        block_end = cur_end
        cur_end = subtract_workdays(cur_end, int(days), holidays)
        block_start = cur_end
        blocks.append({
            "key": block_key,
            "start": block_start,
            "end": block_end,
        })

    blocks.reverse()

    if component_ready_at is not None:
        # BOM ana siparisi: Dizgi yukarıdaki döngüde zaten hiç hesaplanmadı (blocks'ta
        # yok). Dizgi sonrasi ilk blogun (normalde Uretim) baslangici, normal geriye-
        # dogru hesaplanan baslangic ile bilesenlerin bitis tarihinden GEC olani alir;
        # bilesenler daha gec bitiyorsa Uretim/Test/Teslimat ileri (add_workdays ile)
        # kaydirilir.
        post_assembly_keys = [k for k in BLOCK_KEYS if k not in ("supply", "assembly")]
        next_block = next((b for b in blocks if b["key"] in post_assembly_keys), None)
        if next_block is not None and component_ready_at > next_block["start"]:
            shift_start = component_ready_at
            while not is_workday(shift_start.date(), holidays):
                shift_start += timedelta(days=1)
            for key in post_assembly_keys:
                block = next((b for b in blocks if b["key"] == key), None)
                if block is None:
                    continue
                days = _block_days(key, product_params, qty, emp, work_minutes, is_outsourced)
                if not days or days <= 0:
                    continue
                block["start"] = shift_start
                block["end"] = add_workdays(shift_start, int(days), holidays)
                shift_start = block["end"]

        # Tedarik (supply): B/C bilesenleri kendi TUM hatlarinda (Tedarik->Dizgi->
        # Uretim->Test) calisirken A PARALEL olarak Tedarik yapar (bkz. plan). Bu
        # yuzden Tedarik, yukaridaki (artik bilesenle ilgisiz kalmis) eski geriye-
        # dogru konumunda BIRAKILAMAZ — bilesenlerin de basladigi ayni noktadan
        # (start_date) baslar VE bilesenlerin bitisine (component_ready_at) kadar
        # surer — yani bileşenlerin TUM adimlarinin baslangicindan sonuna kadar
        # gorsel olarak devam eder (kendi kisa yapilandirilmis suresiyle SINIRLI
        # DEGILDIR, o sure sadece bir alt sinir olusturur). start_date saglanmadiysa
        # (cagiran taraf vermediyse, ör. eski cagrilar) eski geriye-dogru davranis
        # korunur.
        if start_date is not None:
            supply_block = next((b for b in blocks if b["key"] == "supply"), None)
            if supply_block is not None:
                supply_days = _block_days("supply", product_params, qty, emp, work_minutes, is_outsourced)
                if supply_days and supply_days > 0:
                    supply_start = start_date
                    while not is_workday(supply_start.date(), holidays):
                        supply_start += timedelta(days=1)
                    natural_end = add_workdays(supply_start, int(supply_days), holidays)
                    supply_block["start"] = supply_start
                    supply_block["end"] = max(natural_end, component_ready_at)

    return blocks


def calculate_component_end_date(
    start_date: datetime,
    quantity: float,
    product_params: dict,
    emp: dict[str, float],
    work_minutes: float,
    holidays: set[date],
) -> datetime:
    """BOM bileşen siparişleri (alt ürünler) için ileri yönlü hesap — Teslimat bloğu
    yok (bileşen müşteriye teslim edilmez, ana ürünün içine girer), Dizgi ATLANMAZ
    (bileşenin kendi normal dizgisi çalışır). Sonuç, bileşenin Test bitiş tarihidir."""
    qty = max(1, quantity or 1)
    cur = start_date

    for block_key in ("supply", "assembly", "production", "test"):
        while not is_workday(cur.date(), holidays):
            cur += timedelta(days=1)
        days = _block_days(block_key, product_params, qty, emp, work_minutes, is_outsourced=False)
        if not days or days <= 0:
            continue
        cur = add_workdays(cur, int(days), holidays)

    return cur


def calculate_split_start_date(
    end_date: datetime,
    quantity: float,
    product_params: dict,
    emp: dict[str, float],
    work_minutes: float,
    holidays: set[date],
    is_outsourced: bool = False,
    component_ready_at: datetime | None = None,
    include_delivery: bool = True,
    components_start_at: datetime | None = None,
) -> datetime:
    """`calculate_split_stage_ranges`'in üzerine ince bir katman — BOM ana
    siparişlerinde (component_ready_at doluysa) Dizgi'nin atlanması ve sonraki
    bloklarin bilesenlere gore kaymasi kuralinin BURADA AYRI bir kopyasi
    TUTULMAMASI icin tek kaynaga (calculate_split_stage_ranges) delege eder —
    aksi halde iki paralel implementasyon birbirinden sapar (bkz. gantt.py'deki
    ayni gerekce). component_ready_at verilmezse eski davranisla birebir aynidir.

    `include_delivery`: BOM bileşen (component) split'leri için ÇAĞIRAN TARAF
    MUTLAKA False geçmeli — bileşenler müşteriye teslim edilmez, Teslimat adımı
    hiç yoktur (bkz. calculate_component_end_date/_derive_component_orders ile
    aynı kural). Varsayılan True (ana sipariş split'leri için) — bu parametre
    eklenmeden önce TÜM çağıranlar (holidays.py, app_settings.py, order_details.py,
    gantt.py) component split'ler için de sessizce include_delivery=True
    kullanıyordu; bu, component'in start_date'ini olması gerekenden ~1 gün daha
    ERKEN hesaplayıp (fazladan bir hayalet Teslimat günü eklenerek) split'in
    start_date'ini sessizce BOZUYORDU (canlı veriden doğrulandı — bkz. ilgili
    inceleme)."""
    blocks = calculate_split_stage_ranges(
        end_date, quantity, product_params, emp, work_minutes, holidays,
        is_outsourced, component_ready_at=component_ready_at, include_delivery=include_delivery,
    )
    if not blocks:
        return end_date
    own_start = min(b["start"] for b in blocks)

    # BOM ana siparisi: bilesenler kendi hatlarinda calisirken ana urun PARALEL
    # olarak Tedarik yapar (bkz. calculate_split_stage_ranges'deki supply blogu).
    # O paralellik start_date'ten component_ready_at'e kadar cizilir — ama
    # start_date'i BU fonksiyon uretiyor ve yalnizca ana urunun KENDI zincirini
    # geriye sayiyordu. Sonuc kisir dongu oluyordu: uzatma erken bir baslangic
    # bekliyor, baslangic ise bilesenlere hic bakmadan hesaplaniyordu; Tedarik
    # kendi kisa suresi kadar (ör. 1 gun) kalip bilesenlerin uretim penceresini
    # hic kapsamiyordu.
    #
    # Baslangic icin MIN (en erken baslayan bilesen) aliniyor, bitis icin MAX
    # (component_ready_at, en gec biten bilesen). MAX alinsaydi ana siparisin
    # baslangici kendi alt parcasinin baslangicindan SONRA olur, Gantt'ta ana
    # satir cocuklarini kapsamaz ve "devam eden is" hesaplari o araligi kacirirdi.
    if components_start_at is not None and component_ready_at is not None:
        return min(own_start, components_start_at)
    return own_start
