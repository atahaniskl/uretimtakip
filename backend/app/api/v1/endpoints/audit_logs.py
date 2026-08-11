"""
AuditLog API — View audit trail (ADMIN only).
"""

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel
from sqlalchemy import select, func, desc, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.user import User, UserRole
from app.models.audit_log import AuditLog
from app.models.audit_log_note import AuditLogNote
from app.models.order import Order
from app.models.delivery_split import DeliverySplit
from app.api.deps import require_role

router = APIRouter(prefix="/audit-logs", tags=["Audit Logs"])


# --- Schemas ---

class AuditLogRead(BaseModel):
    id: str
    entity_type: str
    entity_id: str
    action: str
    old_value: dict | None
    new_value: dict | None
    performed_by: str
    performer_username: str | None = None
    timestamp: str

    model_config = {"from_attributes": True}


class AuditLogListResponse(BaseModel):
    logs: list[AuditLogRead]
    total: int
    page: int
    page_size: int


class OrderHistoryChange(BaseModel):
    field: str
    old_value: str
    new_value: str


class OrderHistoryRead(BaseModel):
    id: str
    entity_type: str
    entity_id: str
    action: str
    performed_by: str
    performer_username: str | None = None
    timestamp: str
    order_external_id: str | None = None
    order_customer_name: str | None = None
    description: str = ""
    changes: list[OrderHistoryChange] = []
    old_value: dict | None = None
    new_value: dict | None = None
    note_count: int = 0


class OrderHistoryListResponse(BaseModel):
    logs: list[OrderHistoryRead]
    total: int
    page: int
    page_size: int


# --- Helpers ---

FIELD_LABELS: dict[str, str] = {
    # --- Siparis alanlari (old/new_value -> order_fields) ---
    "customer_name": "Müşteri Adı",
    "responsible_personnel": "Sorumlu Personel",
    "order_date": "Sipariş Tarihi",
    "promised_date": "Vadeli Tarih",
    "requirement_date": "İhtiyaç Tarihi",
    "penalty_date": "Ceza Tarihi",
    "quantity": "Miktar",
    "start_date": "Başlangıç Tarihi",
    "end_date": "Bitiş Tarihi",
    # --- base_data: urun / uretim parametreleri ---
    # Bunlar etiketsiz birakilmisti; _compute_changes_for_order base_data'yi
    # HAM ANAHTAR adiyla ekliyordu, yani kullanici gecmiste "assembly_days" ya da
    # "montaj_kalite_minutes" gibi teknik alan adlari goruyordu.
    "product_name": "Ürün",
    "text": "Ürün",
    "external_id": "Sipariş No",
    "supply_days": "Tedarik (gün)",
    "assembly_days": "Dizgi (gün/adet)",
    "assembly_flat_days": "Dizgi (toplam gün)",
    "production_days": "Üretim (gün)",
    "production_flat_days": "Üretim (toplam gün)",
    "test_flat_days": "Test (toplam gün)",
    "delivery_days": "Teslimat (gün)",
    "outsource_days": "Fason Süresi (gün)",
    "is_outsourced": "Fason Üretim",
    "duration_mode": "Süre Modu",
    # Efor ozelligi kaldirildi; etiket sadece eski gecmis kayitlari okunur tutmak icin duruyor.
    "effort_weight": "Efor Katsayısı",
    "quality_minutes": "Kalite (dk/adet)",
    "epoxy_minutes": "Epoxy (dk/adet)",
    "conformal_minutes": "Conformal (dk/adet)",
    "montaj_minutes": "Montaj (dk/adet)",
    "montaj_kalite_minutes": "M.Kalite (dk/adet)",
    "test1_minutes": "Test1 (dk/adet)",
    "test2_minutes": "Test2 (dk/adet)",
    "final_test_minutes": "F.Test (dk/adet)",
    "on_hand_quantity": "Elde Mevcut",
    "sub_product_on_hand": "Alt Ürün Elde Mevcut",
    "status": "Durum",
    "manual_edit": "Elle Düzenlendi",
    "delivery_date": "Teslim Tarihi",
    "split_quantity": "Parça Adedi",
    "note": "Not",
    # Gercek kayitlarda gorulen, etiketsiz kaldigi icin ham anahtar adiyla
    # basilan alanlar (gecmis verisi taranarak tespit edildi).
    "serial_numbers": "Seri Numaraları",
    "split_status": "Parça Durumu",
    "split_promised_date": "Parça Vade Tarihi",
    "on_hand_reduction": "Elde Mevcut Düşümü",
    "restored_from_split_delete": "Silinen Parçadan Geri Alındı",
    "reason": "Gerekçe",
    "component_ready_at": "Bileşen Hazır Olma",
    "product_code": "Ürün Kodu",
    "is_deleted": "Silinmiş",
    "auto_delivery_suppressed": "Otomatik Teslimat Kapalı",
    "order_responsible": "Sipariş Sorumlusu",
    "current_start_date": "Mevcut Başlangıç",
    "would_be_start_date": "Olması Gereken Başlangıç",
    "conflicts": "Çakışmalar",
    "split_from": "Bölündüğü Parça",
    # Excel'den gelen alternatif sutun adlari.
    "customer": "Müşteri",
    "siparis_no": "Sipariş No",
    "company_name": "Firma",
    "weight_kg": "Ağırlık (kg)",
}

# Siparis/parca durum kodlari — ekranda "COMPLETED" yerine Turkce karsiligi.
# Karsiliklar frontend'deki STATUS_LABELS ile AYNI tutulur (bkz.
# OrderDetailsPage.tsx): ayni durum iki ekranda farkli adlansaydi
# ("APPROVED" vs "Devam Ediyor") kullanici bunlari ayri seyler sanardi.
STATUS_LABELS: dict[str, str] = {
    "PENDING": "Beklemede",
    "APPROVED": "Devam Ediyor",
    "COMPLETED": "Tamamlandı",
}

# base_data icinde kullaniciya hicbir sey ifade etmeyen teknik anahtarlar —
# gecmis kartinda "order_id: 3f2a... -> 3f2a..." gibi satirlar cikmasin diye
# karsilastirma disinda birakilir.
IGNORED_BASE_DATA_KEYS: set[str] = {
    "id",
    "order_id",
    "split_id",
    "parent_order_id",
    "component_product_id",
    "mapping_template_id",
    "created_at",
    "updated_at",
    "created_by",
    # Bolme (SPLIT) kayitlarindaki kaynak parca kimligi — ekranda
    # "source: split_1fe81863-46a0-... → —" gibi anlamsiz bir satir oluyordu.
    "source",
    "source_split_id",
}

# Ham deger -> okunabilir karsilik. duration_mode gibi alanlar ekranda
# "per_unit"/"flat" olarak gorunuyordu.
VALUE_LABELS: dict[str, str] = {
    "per_unit": "Adet Başına",
    "flat": "İş Günü",
    # Planlama catismasi bildirimlerindeki "reason" kodlari — ekranda ham kod
    # olarak goruluyordu.
    "schedule_setting_change_conflict_manual_edit_kept":
        "Ayar değişikliği çizelgeyle çakıştı; elle yapılan düzenleme korundu",
    "bom_component_schedule_conflict_manual_edit_kept":
        "Alt ürün çizelgesiyle çakışma oluştu; elle yapılan düzenleme korundu",
}

# CREATE/DELETE kayitlarinda karsilastirilacak bir "onceki hal" yoktur; kartin
# tamamen bos kalmamasi icin kaydin kendisinden bu alanlar ozetlenir (sirali).
SUMMARY_KEYS: tuple[str, ...] = (
    "product_name",
    "text",
    "quantity",
    "customer_name",
    "start_date",
    "end_date",
    "promised_date",
)

STEP_LABELS: dict[str, str] = {
    "supply": "Tedarik",
    "assembly": "Dizgi",
    "kalite": "Kalite",
    "test1": "Test1",
    "epoxy": "Epoxy",
    "conformal": "Conformal",
    "test2": "Test2",
    "montaj": "Montaj",
    "montaj_kalite": "M.Kalite",
    "final_test": "F.Test",
    "delivery": "Sevkiyat",
    # Veritabanindaki manual_steps kayitlarinda GERCEKTEN bulunan ama burada
    # eksik olan anahtarlar. Eksik olduklari icin bu adimlarin tamamlandi/
    # beklemede degisimi gecmiste HIC gorunmuyordu (dongu yalnizca bu sozlukteki
    # anahtarlari geziyor).
    "production": "Üretim",
    "quality": "Kalite Kontrol",
    "test": "Test",
}

ACTION_LABELS: dict[str, str] = {
    "CREATE": "oluşturdu",
    "UPDATE": "güncelledi",
    "DELETE": "sildi",
    "DRAG": "sürükledi",
    "SPLIT": "böldü",
}


# Iki AYRI kavram, bilincli olarak farkli isaretlenir:
#   EMPTY_MARK      -> "onceki bir hal YOK" (olusturma ozeti). Arayuz bunu gorunce
#                      ok/ustu-cizili gostermez, tek degeri basar.
#   NULL_VALUE_TEXT -> "onceki deger GERCEKTEN bostu". Bu bir bilgidir ve
#                      gizlenmemelidir: "Üretim (toplam gün): boş → 5" ile
#                      "... 3 → 5" arasindaki fark kullanici icin onemli.
# Ikisi ayni isarete baglandiginda, bos bir alanin doldurulmasi ekranda yalnizca
# "5" olarak gorunuyor ve "5 miydi, 3'ten mi 5 oldu?" belirsizligi olusuyordu.
EMPTY_MARK = "—"
NULL_VALUE_TEXT = "boş"


def _fmt(val) -> str:
    """Ham JSON degerini kullaniciya gosterilecek metne cevirir.

    Onceden yalnizca ISO tarih donusumu yapiliyordu; geri kalan her sey str()
    ile basiliyordu. Bu yuzden gecmis kartlarinda "True", "per_unit", "13.0"
    gibi ham degerler goruluyordu.
    """
    if val is None or val == "":
        return NULL_VALUE_TEXT
    # bool, int'in alt sinifi — int kontrolunden ONCE bakilmali.
    if isinstance(val, bool):
        return "Evet" if val else "Hayır"
    if isinstance(val, float):
        return str(int(val)) if val.is_integer() else f"{val:g}"
    if isinstance(val, int):
        return str(val)
    if isinstance(val, str):
        if val in VALUE_LABELS:
            return VALUE_LABELS[val]
        if val in STATUS_LABELS:
            return STATUS_LABELS[val]
        # "status" alani bazen bir durum kodu degil, o an calisilan ADIMIN
        # anahtarini tutuyor (ör. "supply", "test") — ham birakilmasin.
        if val in STEP_LABELS:
            return STEP_LABELS[val]
        try:
            return datetime.fromisoformat(val.replace("Z", "+00:00")).strftime("%d.%m.%Y")
        except (ValueError, TypeError):
            pass
        return val
    # Sozluk/liste (ör. alt urun elde-mevcut haritasi) tek tek basilirsa kart
    # okunamaz hale gelir — sadece buyuklugu ozetlenir.
    if isinstance(val, dict):
        return f"{len(val)} kayıt"
    if isinstance(val, list):
        return f"{len(val)} kayıt"
    return str(val)


def _flatten_snapshot(snapshot: dict | None) -> dict:
    """order_fields / base_data katmanlarini tek duz sozlukte toplar."""
    flat: dict = {}
    if not isinstance(snapshot, dict):
        return flat
    for container in (snapshot, snapshot.get("order_fields"), snapshot.get("base_data")):
        if isinstance(container, dict):
            for key, value in container.items():
                if isinstance(value, dict) and key in ("order_fields", "base_data", "manual_steps"):
                    continue
                if flat.get(key) in (None, ""):
                    flat[key] = value
    return flat


def _summarize_snapshot(snapshot: dict | None) -> list[OrderHistoryChange]:
    """CREATE/DELETE icin ozet satirlari.

    Bu iki eylemde karsilastirilacak ikinci bir hal yok, bu yuzden eskiden
    `changes` bos kaliyor ve kart yalnizca "... olusturdu" yaziyordu. Artik
    kaydin kendisinden ürün/adet/tarih gibi ayirt edici alanlar cikarilir.
    `old_value` bilerek EMPTY_MARK: arayuz bunu gorunce ok/ustu-cizili gosterimi
    yerine tek degeri basar (bkz. DiffBadge).
    """
    flat = _flatten_snapshot(snapshot)
    out: list[OrderHistoryChange] = []
    seen_labels: set[str] = set()
    for key in SUMMARY_KEYS:
        if key not in flat:
            continue
        value = flat.get(key)
        if value is None or value == "":
            continue
        label = FIELD_LABELS.get(key, key)
        if label in seen_labels:
            continue
        seen_labels.add(label)
        out.append(OrderHistoryChange(field=label, old_value=EMPTY_MARK, new_value=_fmt(value)))
    return out


def _extract_product_name(log: AuditLog) -> str | None:
    """Kaydin urun adi — aciklamada siparis numarasinin yaninda gosterilir."""
    for source in (log.new_value, log.old_value):
        flat = _flatten_snapshot(source)
        name = flat.get("product_name") or flat.get("text")
        if name:
            return str(name)
    return None


def _compute_changes_for_order(old: dict | None, new: dict | None) -> list[OrderHistoryChange]:
    changes: list[OrderHistoryChange] = []
    # Bazi UPDATE kayitlarinda old_value TAMAMEN null'dur (ör. planlama
    # catismasi bildirimleri: {"reason": ..., "current_start_date": ...}).
    # Eskiden burada erken donuluyor ve bu kayitlar detaysiz kaliyordu; artik
    # eksik taraf bos sozluk sayilir ve degerler "— → X" olarak cikarilir.
    if old is None and new is None:
        return changes
    old = old if isinstance(old, dict) else {}
    new = new if isinstance(new, dict) else {}

    # Hazir fark listesi varsa YETKILI kaynak odur ve digger karsilastirmalar
    # yapilmaz. Bu kayitlarda taraflardan biri tam bir base_data anlik goruntusu,
    # digeri yalnizca fark listesi tasiyor; ikisini duz karsilastirmak "tum
    # alanlar silindi" gibi tamamen yaniltici bir cikti uretirdi.
    precomputed = _changes_from_precomputed(new) or _changes_from_precomputed(old)
    if precomputed:
        return precomputed

    old_fields = (old.get("order_fields") or {}) if isinstance(old.get("order_fields"), dict) else {}
    new_fields = (new.get("order_fields") or {}) if isinstance(new.get("order_fields"), dict) else {}
    for key, label in FIELD_LABELS.items():
        ov = old_fields.get(key)
        nv = new_fields.get(key)
        if ov != nv:
            changes.append(OrderHistoryChange(field=label, old_value=_fmt(ov), new_value=_fmt(nv)))
    old_base = (old.get("base_data") or {}) if isinstance(old.get("base_data"), dict) else {}
    new_base = (new.get("base_data") or {}) if isinstance(new.get("base_data"), dict) else {}
    # Anahtarlar sirali gezilir: aksi halde set sirasi rastgele oldugu icin ayni
    # duzenlemenin gecmis kartinda alanlar her seferinde baska sirada cikiyordu.
    for key in sorted(set(old_base.keys()) | set(new_base.keys())):
        if key in IGNORED_BASE_DATA_KEYS:
            continue
        ov = old_base.get(key)
        nv = new_base.get(key)
        if ov != nv:
            changes.append(OrderHistoryChange(
                field=FIELD_LABELS.get(key, key),
                old_value=_fmt(ov),
                new_value=_fmt(nv),
            ))
    # Zaman cizelgesi duzenlemeleri (siparis duzeyinde de kaydedilebiliyor).
    changes.extend(_changes_from_stage_schedule(old, new))

    # SARMALAYICISIZ ("duz") kayitlar. Bir kismi UPDATE kaydi old/new degerini
    # {"order_fields": ...} / {"base_data": ...} ile SARMADAN, dogrudan
    # {"test_flat_days": null} -> {"test_flat_days": 15} seklinde yaziyor.
    # Yukaridaki dongular yalnizca sarmalayicilara baktigi icin bu kayitlarin
    # tamami "degisiklik yok" sayiliyordu (veritabanindaki UPDATE kayitlarinin
    # ~%35'i) ve kartta yalnizca "... guncelledi" yaziyordu.
    # Kosul "hic degisiklik bulunamadiysa": sarmalayicilar is gordugunde ust
    # duzey anahtarlari tekrar gezmek ayni satiri iki kez uretirdi.
    if not changes:
        for key in sorted(set(old.keys()) | set(new.keys())):
            if key in ("order_fields", "base_data", "manual_steps", "stage_schedule", "changes"):
                continue
            if key in IGNORED_BASE_DATA_KEYS:
                continue
            ov = old.get(key)
            nv = new.get(key)
            if ov != nv:
                changes.append(OrderHistoryChange(
                    field=FIELD_LABELS.get(key, key),
                    old_value=_fmt(ov),
                    new_value=_fmt(nv),
                ))

    old_steps = (old.get("manual_steps") or {}) if isinstance(old.get("manual_steps"), dict) else {}
    new_steps = (new.get("manual_steps") or {}) if isinstance(new.get("manual_steps"), dict) else {}
    # Anahtarlar STEP_LABELS yerine verinin KENDISINDEN gezilir: sozlukte
    # olmayan bir adim (ör. "production") eskiden tamamen gorunmez kaliyordu.
    for key in sorted(set(old_steps.keys()) | set(new_steps.keys())):
        label = STEP_LABELS.get(key, key)
        old_checked = old_steps.get(key, {}).get("checked") if isinstance(old_steps.get(key), dict) else None
        new_checked = new_steps.get(key, {}).get("checked") if isinstance(new_steps.get(key), dict) else None
        if old_checked != new_checked:
            changes.append(OrderHistoryChange(
                field=label,
                old_value="Tamamlandı" if old_checked else "Beklemede",
                new_value="Tamamlandı" if new_checked else "Beklemede",
            ))
    return changes


def _changes_from_precomputed(new: dict | None) -> list[OrderHistoryChange]:
    """Bazi kayitlar zaten hazir bir fark listesi tasiyor:
    new_value["changes"] = [{"field", "old_value", "new_value", "source"}, ...]

    Bu liste en zengin kaynak ama HIC KULLANILMIYORDU — o kayitlar ekranda
    detaysiz "guncelledi" olarak goruluyordu.
    """
    out: list[OrderHistoryChange] = []
    raw = (new or {}).get("changes")
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, dict) or "field" not in item:
            continue
        key = str(item.get("field"))
        out.append(OrderHistoryChange(
            field=FIELD_LABELS.get(key, key),
            old_value=_fmt(item.get("old_value")),
            new_value=_fmt(item.get("new_value")),
        ))
    return out


def _changes_from_stage_schedule(old: dict | None, new: dict | None) -> list[OrderHistoryChange]:
    """Zaman cizelgesi (stage_schedule) duzenlemeleri.

    Yapisi: {"blocks": {"assembly": {"start": ..., "end": ...}, ...}}
    Eskiden hic okunmuyordu; cizelgeyi elle duzenlemek gecmiste yalnizca
    "guncelledi" satiri birakiyordu (veritabanindaki en kalabalik detaysiz grup).
    """
    out: list[OrderHistoryChange] = []
    old_blocks = ((old or {}).get("stage_schedule") or {}).get("blocks") if isinstance((old or {}).get("stage_schedule"), dict) else None
    new_blocks = ((new or {}).get("stage_schedule") or {}).get("blocks") if isinstance((new or {}).get("stage_schedule"), dict) else None
    old_blocks = old_blocks if isinstance(old_blocks, dict) else {}
    new_blocks = new_blocks if isinstance(new_blocks, dict) else {}
    if not old_blocks and not new_blocks:
        return out

    def span(block) -> str:
        if not isinstance(block, dict):
            return NULL_VALUE_TEXT
        return f"{_fmt(block.get('start'))} - {_fmt(block.get('end'))}"

    for key in sorted(set(old_blocks.keys()) | set(new_blocks.keys())):
        ov, nv = span(old_blocks.get(key)), span(new_blocks.get(key))
        if ov != nv:
            out.append(OrderHistoryChange(
                field=f"{STEP_LABELS.get(key, key)} (çizelge)",
                old_value=ov,
                new_value=nv,
            ))
    return out


# delivery_split kayitlarinda ayrica ele alinan / kullaniciya gosterilmeyecek
# anahtarlar — kalan her sey asagida duz fark olarak cikarilir.
_SPLIT_HANDLED_KEYS = {
    "segments",
    "ratio",
    "stage_schedule",
    "changes",
    "warnings",
    "manual_steps",
    # Sarmalayicilar duz fark olarak basilmamali — icerigi acilmadigi icin
    # "base_data: — → 17 kayıt" gibi anlamsiz bir satir cikiyordu. Bunlari
    # aciklamak siparis-tarafi hesabin isi (bkz. _build_order_history_read
    # yonlendirmesi); CREATE'te ise _summarize_snapshot zaten iceriden ozetliyor.
    "base_data",
    "order_fields",
}


def _compute_changes_for_delivery_split(old: dict | None, new: dict | None) -> list[OrderHistoryChange]:
    changes: list[OrderHistoryChange] = []
    # Bazi UPDATE kayitlarinda old_value TAMAMEN null'dur (ör. planlama
    # catismasi bildirimleri: {"reason": ..., "current_start_date": ...}).
    # Eskiden burada erken donuluyor ve bu kayitlar detaysiz kaliyordu; artik
    # eksik taraf bos sozluk sayilir ve degerler "— → X" olarak cikarilir.
    if old is None and new is None:
        return changes
    old = old if isinstance(old, dict) else {}
    new = new if isinstance(new, dict) else {}

    # Hazir fark listesi varsa en zengin kaynak odur.
    changes.extend(_changes_from_precomputed(new))
    changes.extend(_changes_from_stage_schedule(old, new))

    # Uyarilar kullaniciya dogrudan bir sey soyluyor (ör. "Planlanan bitiş, söz
    # verilen teslim tarihinden sonraya sarkıyor.") — gecmiste gorunmuyordu.
    warnings = new.get("warnings")
    if isinstance(warnings, list) and warnings:
        changes.append(OrderHistoryChange(
            field="Uyarı",
            old_value=EMPTY_MARK,
            new_value="; ".join(str(w) for w in warnings),
        ))

    # Eskiden YALNIZCA bu uc alan karsilastiriliyordu; manual_edit,
    # effort_weight gibi diger alanlardaki degisiklikler gorunmez kaliyordu.
    for key in sorted(set(old.keys()) | set(new.keys())):
        if key in _SPLIT_HANDLED_KEYS or key in IGNORED_BASE_DATA_KEYS:
            continue
        ov = old.get(key)
        nv = new.get(key)
        if ov != nv:
            changes.append(OrderHistoryChange(
                field=FIELD_LABELS.get(key, key),
                old_value=_fmt(ov),
                new_value=_fmt(nv),
            ))
    segments = new.get("segments")
    if segments and isinstance(segments, list):
        for i, seg in enumerate(segments):
            # qty _fmt'ten gecirilir: ham hali "10.0 adet" gibi yaziliyordu.
            qty = _fmt(seg.get("quantity"))
            sd = _fmt(seg.get("start_date"))
            ed = _fmt(seg.get("end_date"))
            changes.append(OrderHistoryChange(
                field=f"Dilim {i + 1}",
                old_value=EMPTY_MARK,
                new_value=f"{qty} adet ({sd} - {ed})",
            ))
    ratio = new.get("ratio")
    if ratio is not None:
        changes.append(OrderHistoryChange(field="Bölünme Oranı", old_value=EMPTY_MARK, new_value=f"%{ratio * 100:.0f}"))
    return changes


def _build_description(
    action: str,
    performer: str | None,
    external_id: str | None,
    changes: list[OrderHistoryChange],
    product_name: str | None = None,
    entity_type: str = "order",
    quantity: float | None = None,
) -> str:
    """Gecmis kartinin ust satirindaki tek cumlelik ozet.

    Onceki hali yalnizca "<kullanici>, SIP-xxx guncelledi" ya da en fazla
    degisen ILK alanin ADINI veriyordu — degerin neyden neye dondugu hic
    yazmiyordu, birden fazla degisiklikte ise "(3 degisiklik)" deyip geciyordu.
    Artik ne degistigi de cumlede yer aliyor; ayrinti listesi (changes) kartin
    altinda zaten duruyor, bu satir onun ozeti.
    """
    user = performer or "Sistem"
    # DIKKAT: external_id eskiden [:10] ile kirpiliyordu — 11 haneli siparis
    # numaralari (ör. 23135678657) son hanesi eksik gosteriliyor, yani gecmisteki
    # numara gercek siparis numarasiyla eslesmiyordu.
    order_ref = f"SIP-{external_id}" if external_id else "Sipariş"
    scope = "teslimat parçasını" if entity_type == "delivery_split" else "siparişini"
    # Urun adi ve adet, denetim kaydinin icinden DEGIL siparisin kendisinden
    # gelir (bkz. cagrildigi yer): "test_flat_days: 15" gibi dar kapsamli bir
    # guncelleme kaydinda urun bilgisi hic bulunmaz, ama kullanicinin hangi
    # siparise baktigini bilmesi gerekir.
    ident = ", ".join(p for p in (product_name, f"{_fmt(quantity)} adet" if quantity else None) if p)
    subject = f"{order_ref} ({ident}) {scope}" if ident else f"{order_ref} {scope}"
    verb = ACTION_LABELS.get(action, action)
    head = f"{user}, {subject} {verb}"

    if not changes:
        return head

    def render(change: OrderHistoryChange) -> str:
        # old_value EMPTY_MARK ise "yoktan var edildi" demektir (CREATE ozeti ya
        # da bos birakilmis bir alanin doldurulmasi) — "— → 13" yerine "13".
        if change.old_value == EMPTY_MARK:
            return f"{change.field}: {change.new_value}"
        return f"{change.field}: {change.old_value} → {change.new_value}"

    shown = [render(c) for c in changes[:2]]
    detail = "; ".join(shown)
    remaining = len(changes) - len(shown)
    if remaining > 0:
        detail += f" (+{remaining} alan daha)"
    return f"{head} — {detail}"


# --- Endpoints ---

@router.get(
    "/order-history",
    response_model=OrderHistoryListResponse,
    summary="List order history events (Admin only)",
)
async def list_order_history(
    action: str | None = Query(None, description="Filter by action: CREATE, UPDATE, DELETE, DRAG, SPLIT"),
    entity_id: UUID | None = Query(None, description="Filter by entity ID"),
    search: str | None = Query(None, description="Search by order external_id or customer_name"),
    date_from: str | None = Query(None, description="ISO date string (inclusive)"),
    date_to: str | None = Query(None, description="ISO date string (inclusive)"),
    performed_by: UUID | None = Query(None, description="Filter by user ID"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER, UserRole.VIEWER)),
) -> OrderHistoryListResponse:
    """
    Return paginated order history events with human-readable descriptions.
    Only tracks order and delivery_split entities.
    """
    base_query = (
        select(AuditLog)
        .options(selectinload(AuditLog.performer))
        .where(AuditLog.entity_type.in_(["order", "delivery_split"]))
    )

    if action:
        base_query = base_query.where(AuditLog.action == action)
    if entity_id:
        base_query = base_query.where(AuditLog.entity_id == entity_id)
    if performed_by:
        base_query = base_query.where(AuditLog.performed_by == performed_by)
    if date_from:
        try:
            dt_from = datetime.fromisoformat(date_from)
            base_query = base_query.where(AuditLog.timestamp >= dt_from)
        except (ValueError, TypeError):
            pass
    if date_to:
        try:
            dt_to = datetime.fromisoformat(date_to)
            base_query = base_query.where(AuditLog.timestamp <= dt_to)
        except (ValueError, TypeError):
            pass

    # Count
    count_query = select(func.count()).select_from(base_query.subquery())
    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0

    # Paginated + ordered
    query = base_query.order_by(desc(AuditLog.timestamp))
    query = query.offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(query)
    logs = result.scalars().unique().all()

    # Batch resolve order info
    order_ids: set[UUID] = set()
    split_ids: set[UUID] = set()
    for log in logs:
        if log.entity_type == "order":
            order_ids.add(log.entity_id)
        elif log.entity_type == "delivery_split":
            split_ids.add(log.entity_id)

    order_map: dict[UUID, Order] = {}
    if order_ids:
        order_result = await db.execute(select(Order).where(Order.id.in_(order_ids)))
        for o in order_result.scalars().all():
            order_map[o.id] = o

    split_to_order_map: dict[UUID, Order | None] = {}
    if split_ids:
        split_result = await db.execute(
            select(DeliverySplit).options(selectinload(DeliverySplit.order)).where(DeliverySplit.id.in_(split_ids))
        )
        for s in split_result.scalars().all():
            split_to_order_map[s.id] = s.order

    # Siparislerin toplam adedi — parcalarin (delivery_splits) toplami. Adet
    # siparisin kendisinde degil parcalarinda tutuluyor (orders.base_data'da
    # yalnizca bazi kayitlarda var), bu yuzden tek sorguda toplanir.
    involved_order_ids = {o.id for o in order_map.values()} | {
        o.id for o in split_to_order_map.values() if o is not None
    }
    quantity_map: dict[UUID, float] = {}
    if involved_order_ids:
        qty_result = await db.execute(
            select(DeliverySplit.order_id, func.sum(DeliverySplit.quantity))
            .where(DeliverySplit.order_id.in_(involved_order_ids))
            .group_by(DeliverySplit.order_id)
        )
        for order_id, total_qty in qty_result.all():
            if total_qty is not None:
                quantity_map[order_id] = float(total_qty)

    def _product_of(order: Order | None) -> str | None:
        if order is None or not isinstance(order.base_data, dict):
            return None
        name = order.base_data.get("product_name") or order.base_data.get("text")
        return str(name) if name else None

    # Apply search filter after resolving order info
    filtered_logs = []
    for log in logs:
        external_id = None
        customer_name = None
        product_name = None
        quantity = None
        order = None
        if log.entity_type == "order":
            order = order_map.get(log.entity_id)
        elif log.entity_type == "delivery_split":
            order = split_to_order_map.get(log.entity_id)
        if order:
            external_id = order.external_id
            customer_name = order.customer_name
            product_name = _product_of(order)
            quantity = quantity_map.get(order.id)
        if search:
            search_lower = search.lower()
            if external_id and search_lower in external_id.lower():
                pass
            elif customer_name and search_lower in customer_name.lower():
                pass
            else:
                continue
        filtered_logs.append((log, external_id, customer_name, product_name, quantity))

    # Batch fetch note counts
    log_ids = [entry[0].id for entry in filtered_logs]
    note_counts: dict[UUID, int] = {}
    if log_ids:
        note_result = await db.execute(
            select(AuditLogNote.audit_log_id, func.count(AuditLogNote.id).label("cnt"))
            .where(AuditLogNote.audit_log_id.in_(log_ids))
            .group_by(AuditLogNote.audit_log_id)
        )
        for row in note_result.all():
            note_counts[row[0]] = row[1]

    return OrderHistoryListResponse(
        logs=[
            _build_order_history_read(
                log,
                external_id,
                customer_name,
                note_counts.get(log.id, 0),
                product_name=product_name,
                quantity=quantity,
            )
            for log, external_id, customer_name, product_name, quantity in filtered_logs
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


def _build_order_history_read(
    log: AuditLog,
    external_id: str | None,
    customer_name: str | None,
    note_count: int = 0,
    product_name: str | None = None,
    quantity: float | None = None,
) -> OrderHistoryRead:
    changes: list[OrderHistoryChange] = []
    if log.action in ("UPDATE",):
        if log.entity_type == "order":
            changes = _compute_changes_for_order(log.old_value, log.new_value)
        elif log.entity_type == "delivery_split":
            # Yonlendirme eskiden yalnizca "manual_steps"e bakiyordu; base_data /
            # order_fields tasiyan parca kayitlari parca-tarafina gidiyor ve orada
            # bu sarmalayicilar acilamadigi icin "base_data: — → 17 kayıt" gibi
            # anlamsiz tek satira donusuyordu. Sarmalayicilardan HERHANGI biri
            # varsa siparis-tarafi hesap kullanilir (o taraf hepsini aciyor).
            wrappers = {"manual_steps", "base_data", "order_fields"}
            present = wrappers & (set((log.old_value or {}).keys()) | set((log.new_value or {}).keys()))
            if present:
                changes = _compute_changes_for_order(log.old_value, log.new_value)
            else:
                changes = _compute_changes_for_delivery_split(log.old_value, log.new_value)
    elif log.action == "DRAG":
        changes = _compute_changes_for_delivery_split(log.old_value, log.new_value)
    elif log.action == "SPLIT":
        changes = _compute_changes_for_delivery_split(log.old_value, log.new_value)
    elif log.action == "CREATE":
        # Eskiden yalnizca delivery_split icin hesaplaniyordu, o da old_value
        # None oldugu icin HER ZAMAN bos donuyordu — yani her "oluşturdu" kaydi
        # detaysizdi. Artik kaydin kendisinden ozet cikarilir.
        changes = _compute_changes_for_delivery_split(log.old_value, log.new_value)
        if not changes:
            changes = _summarize_snapshot(log.new_value)
    elif log.action == "DELETE":
        if log.old_value:
            # Silinen seyin NE oldugu da yazilir; tek basina "Aktif -> Silindi"
            # satiri hangi urun/adet silindigini soylemiyordu.
            changes.append(OrderHistoryChange(field="Durum", old_value="Aktif", new_value="Silindi"))
            changes.extend(_summarize_snapshot(log.old_value))

    performer = log.performer.username if log.performer else None
    description = _build_description(
        log.action,
        performer,
        external_id,
        changes,
        # Siparisten cozulen ad onceliklidir; yoksa denetim kaydinin icine
        # bakilir (silinmis siparislerde tek kaynak odur).
        product_name=product_name or _extract_product_name(log),
        entity_type=log.entity_type,
        quantity=quantity,
    )

    return OrderHistoryRead(
        id=str(log.id),
        entity_type=log.entity_type,
        entity_id=str(log.entity_id),
        action=log.action,
        performed_by=str(log.performed_by) if log.performed_by else "",
        performer_username=performer,
        timestamp=log.timestamp.isoformat(),
        order_external_id=external_id,
        order_customer_name=customer_name,
        description=description,
        changes=changes,
        old_value=log.old_value,
        new_value=log.new_value,
        note_count=note_count,
    )


@router.get(
    "/",
    response_model=AuditLogListResponse,
    summary="List audit logs",
)
async def list_audit_logs(
    entity_type: str | None = Query(None, description="Filter by entity type: order, delivery_split, mapping_template"),
    action: str | None = Query(None, description="Filter by action: CREATE, UPDATE, DELETE, DRAG, SPLIT"),
    entity_id: UUID | None = Query(None, description="Filter by entity ID"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER, UserRole.VIEWER)),
) -> AuditLogListResponse:
    """
    Return paginated audit logs with optional filtering.
    Authenticated users can view the audit trail.
    """
    query = select(AuditLog).options(selectinload(AuditLog.performer))

    if entity_type:
        query = query.where(AuditLog.entity_type == entity_type)
    if action:
        query = query.where(AuditLog.action == action)
    if entity_id:
        query = query.where(AuditLog.entity_id == entity_id)

    # Total count
    count_query = select(func.count()).select_from(
        select(AuditLog.id).where(
            *([AuditLog.entity_type == entity_type] if entity_type else []),
            *([AuditLog.action == action] if action else []),
            *([AuditLog.entity_id == entity_id] if entity_id else []),
        ).subquery()
    )
    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0

    # Paginated + ordered
    query = query.order_by(desc(AuditLog.timestamp))
    query = query.offset((page - 1) * page_size).limit(page_size)

    result = await db.execute(query)
    logs = result.scalars().unique().all()

    return AuditLogListResponse(
        logs=[
            AuditLogRead(
                id=str(log.id),
                entity_type=log.entity_type,
                entity_id=str(log.entity_id),
                action=log.action,
                old_value=log.old_value,
                new_value=log.new_value,
                performed_by=str(log.performed_by),
                performer_username=log.performer.username if log.performer else None,
                timestamp=log.timestamp.isoformat(),
            )
            for log in logs
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


# --- Note Schemas ---

class NoteCreate(BaseModel):
    content: str


class NoteUpdate(BaseModel):
    content: str


class NoteRead(BaseModel):
    id: str
    audit_log_id: str
    content: str
    created_by: str
    creator_username: str | None = None
    created_at: str
    updated_at: str | None = None


# --- Note Endpoints ---

@router.get(
    "/{log_id}/notes",
    response_model=list[NoteRead],
    summary="List notes for an audit log entry",
)
async def list_notes(
    log_id: UUID,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER, UserRole.VIEWER)),
) -> list[NoteRead]:
    result = await db.execute(
        select(AuditLogNote)
        .options(selectinload(AuditLogNote.creator))
        .where(AuditLogNote.audit_log_id == log_id)
        .order_by(AuditLogNote.created_at)
    )
    notes = result.scalars().all()
    return [
        NoteRead(
            id=str(n.id),
            audit_log_id=str(n.audit_log_id),
            content=n.content,
            created_by=str(n.created_by),
            creator_username=n.creator.username if n.creator else None,
            created_at=n.created_at.isoformat(),
            updated_at=n.updated_at.isoformat() if n.updated_at else None,
        )
        for n in notes
    ]


@router.post(
    "/{log_id}/notes",
    response_model=NoteRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a note on an audit log entry",
)
async def create_note(
    log_id: UUID,
    body: NoteCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER, UserRole.VIEWER)),
) -> NoteRead:
    log_entry = await db.get(AuditLog, log_id)
    if not log_entry:
        from fastapi import HTTPException
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audit log entry not found")

    note = AuditLogNote(
        audit_log_id=log_id,
        content=body.content,
        created_by=current_user.id,
    )
    db.add(note)
    await db.flush()
    await db.refresh(note)

    return NoteRead(
        id=str(note.id),
        audit_log_id=str(note.audit_log_id),
        content=note.content,
        created_by=str(note.created_by),
        creator_username=current_user.username,
        created_at=note.created_at.isoformat(),
        updated_at=note.updated_at.isoformat() if note.updated_at else None,
    )


def _can_manage_note(current_user: User, note: AuditLogNote) -> bool:
    return current_user.role in (UserRole.ADMIN, UserRole.PLANNER) or note.created_by == current_user.id


@router.put(
    "/notes/{note_id}",
    response_model=NoteRead,
    summary="Update a note",
)
async def update_note(
    note_id: UUID,
    body: NoteUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER, UserRole.VIEWER)),
) -> NoteRead:
    from fastapi import HTTPException

    note = await db.get(AuditLogNote, note_id)
    if not note:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    if not _can_manage_note(current_user, note):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not authorized to edit this note")

    note.content = body.content
    await db.flush()
    await db.refresh(note)

    creator = await db.get(User, note.created_by)

    return NoteRead(
        id=str(note.id),
        audit_log_id=str(note.audit_log_id),
        content=note.content,
        created_by=str(note.created_by),
        creator_username=creator.username if creator else None,
        created_at=note.created_at.isoformat(),
        updated_at=note.updated_at.isoformat() if note.updated_at else None,
    )


@router.delete(
    "/notes/{note_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a note",
)
async def delete_note(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER, UserRole.VIEWER)),
) -> None:
    from fastapi import HTTPException

    note = await db.get(AuditLogNote, note_id)
    if not note:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    if not _can_manage_note(current_user, note):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not authorized to delete this note")

    await db.delete(note)
    await db.flush()
