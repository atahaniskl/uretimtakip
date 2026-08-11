"""
Statistics API — planlama odaklı özet göstergeler.

Tek bir GET ile sol menüdeki "İstatistikler" sayfasının ihtiyaç duyduğu bütün
kırılımları döner. Kasten TEK endpoint: sayfadaki her kutu aynı "bugün" ve aynı
dönem üzerinden hesaplanmalı, aksi halde paralel isteklerde kartlar birbiriyle
çelişen sayılar gösterebilir.

İki kapsam vardır ve arayüzde de bu ayrım açıkça yazılıdır:

* ``totals`` ve ``overdue`` — TÜM veriye, "bugün"e göre. Dönem gezinmesinden
  ETKİLENMEZ: kullanıcı 2029'a baksa bile "şu an 6 teslimat gecikmiş" bilgisi
  geçerliliğini korumalı, yoksa ileri sarınca gecikmeler sıfırlanmış gibi görünür.
* ``period_totals`` / ``buckets`` / ``status_breakdown`` / ``customers`` /
  ``products`` / ``deliveries`` — YALNIZCA ``start``–``end`` aralığına düşen
  teslimatlara göre. Kullanıcı ileri/geri gezindikçe bunlar değişir.

Teslimat birimi = DeliverySplit. Bir siparişin her parçası ayrı bir teslimattır;
teslimat tarihi olarak parçanın ``end_date``'i kullanılır (Gantt/Takvim
görünümlerindeki bar bitişiyle aynı tarih). Söz verilen tarih kıyaslamasında
parçanın kendi ``promised_date``'i varsa o, yoksa siparişin geneli kullanılır —
order_details.py'deki update_split_stage_schedule uyarısıyla aynı kural.

BOM bileşen (alt ürün) siparişleri de sayılır — istatistikler toplam ÜRETİM
yükünü gösterir, yalnızca müşteriye çıkan sevkiyatı değil. Bunun bilinçli
sonucu: alt ürünlü bir siparişte hem ana ürünün hem her alt ürünün adedi ayrı
ayrı toplama girer, yani "adet" müşteriye teslim edilen ürün sayısı değil
üretilen kalem sayısıdır. Satır bazında ayırt edilebilsin diye her teslimat
``is_component`` bayrağıyla döner.
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status as http_status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.api.v1.endpoints.gantt import (
    MANUAL_STEP_KEYS,
    _blended_status,
    _get_split_manual_steps,
    _status_from_manual_steps,
    _status_from_split_statuses,
)
from app.core.date_utils import effective_product_params, is_outsourced_from_base_data
from app.database import get_db
from app.models.delivery_split import DeliverySplit
from app.models.enums import OrderStatus
from app.models.order import Order
from app.models.user import User

router = APIRouter(prefix="/statistics", tags=["Statistics"])

TR_MONTH_SHORT = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"]

# order_details.py'deki "Durum" dropdown'u ile birebir aynı isimler — kullanıcı
# aynı parçayı iki ekranda gördüğünde aynı etiketi okumalı.
STATUS_BUCKET_LABELS: dict[str, str] = {
    "PENDING": "Beklemede",
    "supply": "Tedarik",
    "assembly": "Dizgi",
    "production": "Üretim",
    "test": "Test",
    "delivery": "Teslimat",
    "COMPLETED": "Tamamlandı",
}

TOP_N = 8
DELIVERIES_LIMIT = 25
OVERDUE_LIMIT = 20
# Bir istekte üretilebilecek en fazla kova — arayüz yıllıkta 5, aylıkta 12 kova
# ister; sınır yalnızca elle çok geniş bir start/end verilmesine karşı.
MAX_BUCKETS = 240


class Totals(BaseModel):
    """Tüm veriye ve "bugün"e göre genel durum — dönem gezinmesinden etkilenmez."""

    total_orders: int
    active_orders: int
    completed_orders: int
    total_deliveries: int
    remaining_deliveries: int
    remaining_quantity: float
    completed_deliveries: int
    completed_quantity: float
    overdue_deliveries: int
    overdue_quantity: float
    this_month_deliveries: int
    this_month_quantity: float
    next_30_days_deliveries: int
    next_30_days_quantity: float
    at_risk_deliveries: int
    outsourced_remaining_deliveries: int


class PeriodTotals(BaseModel):
    """Yalnızca seçili dönemdeki teslimatlar.

    DİKKAT — ``overdue_*`` değerleri ``remaining_*`` içinde ZATEN sayılıdır
    (geciken bir teslimat hâlâ kalan bir teslimattır). Grafikte üst üste
    yığmadan önce ayrıştırılmalı: zamanında kalan = remaining - overdue.
    ``delivery_count = completed_count + remaining_count`` her zaman geçerlidir.
    """

    delivery_count: int
    quantity: float
    remaining_count: int
    remaining_quantity: float
    completed_count: int
    completed_quantity: float
    overdue_count: int
    overdue_quantity: float
    at_risk_count: int
    avg_per_bucket: float
    avg_quantity_per_bucket: float


class Bucket(BaseModel):
    """Grafikteki tek bir sütun (bir ay veya bir yıl).

    ``label`` tam ad ("Ağu 2026"), ``short``/``sub`` ise grafiğin altındaki iki
    satırlık eksen etiketi ("Ağu" / "'26"). Yıllık görünümde ``sub`` boştur.
    Etiketi backend üretir — aksi halde arayüzün ay adını string ayrıştırarak
    bölmesi gerekir ve bu, yıllık kovalarda ("2026") bozulur.
    """

    key: str
    label: str
    short: str
    sub: str
    delivery_count: int
    quantity: float
    remaining_count: int
    remaining_quantity: float
    completed_count: int
    completed_quantity: float
    overdue_count: int
    overdue_quantity: float
    is_current: bool
    is_past: bool


class PeriodInfo(BaseModel):
    granularity: str
    start: str
    end: str
    label: str
    contains_today: bool


class StatusBucket(BaseModel):
    key: str
    label: str
    count: int
    quantity: float


class CustomerBucket(BaseModel):
    name: str
    remaining_deliveries: int
    remaining_quantity: float
    overdue_deliveries: int
    next_delivery_date: str | None


class ProductBucket(BaseModel):
    name: str
    remaining_deliveries: int
    remaining_quantity: float


class DeliveryItem(BaseModel):
    split_id: str
    order_id: str
    external_id: str
    customer_name: str | None
    product_name: str | None
    quantity: float
    delivery_date: str
    promised_date: str | None
    days_left: int
    status_key: str
    status_label: str
    is_component: bool
    is_outsourced: bool
    is_overdue: bool
    late_vs_promise: bool


class StatisticsSummary(BaseModel):
    generated_at: str
    today: str
    period: PeriodInfo
    totals: Totals
    period_totals: PeriodTotals
    buckets: list[Bucket]
    status_breakdown: list[StatusBucket]
    customers: list[CustomerBucket]
    products: list[ProductBucket]
    deliveries: list[DeliveryItem]
    overdue: list[DeliveryItem]


@dataclass
class _Record:
    """Tek bir teslimatın (DeliverySplit) hesaplanmış hâli — hem genel hem
    dönem kapsamı aynı listeden türetilir, böylece iki kapsam arasında sessiz
    bir hesap farkı oluşamaz."""

    split_id: str
    order_id: str
    external_id: str
    customer_name: str | None
    customer_key: str
    product_name: str
    quantity: float
    delivery_date: date
    promised_date: date | None
    status_bucket: str
    is_completed: bool
    is_overdue: bool
    late_vs_promise: bool
    is_component: bool
    is_outsourced: bool


def _month_key(value: date) -> str:
    return f"{value.year:04d}-{value.month:02d}"


def _shift_month(year: int, month: int, delta: int) -> tuple[int, int]:
    index = (year * 12 + (month - 1)) + delta
    return index // 12, index % 12 + 1


def _derived_split_status(split: DeliverySplit) -> str:
    """order_details.py ``_derived_split_status`` ile aynı kural — parçanın kalıcı
    ``status`` kolonu ile manuel adım kutucuklarından türeyen durum harmanlanır."""
    return _blended_status(split.status, _status_from_manual_steps(_get_split_manual_steps(split)))


def _split_status_bucket(split: DeliverySplit) -> str:
    """Parçayı istatistik kırılımındaki tek bir kovaya yerleştirir: Beklemede,
    5 üretim adımından o an bulunduğu adım, veya Tamamlandı."""
    status = _derived_split_status(split)
    if status == OrderStatus.COMPLETED.value:
        return "COMPLETED"
    if status != OrderStatus.APPROVED.value:
        return "PENDING"
    steps = _get_split_manual_steps(split)
    for key in MANUAL_STEP_KEYS:
        if not steps[key].get("checked"):
            return key
    return "COMPLETED"


def _as_date(value: datetime | date | None) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    return value


def _resolve_period(
    granularity: str, start: date | None, end: date | None, today: date
) -> tuple[date, date, str]:
    """Verilmeyen sınırları makul bir varsayılana tamamlar ve dönem etiketini üretir.

    Varsayılan aylık görünüm, içinde bulunulan TAKVİM YILIDIR (Oca–Ara) — gezinme
    ileri/geri bir yıl kaydırdığı için sabit bir takvim yılı, kayan bir pencereye
    göre çok daha öngörülebilir: kullanıcı ileri gidip geri döndüğünde tam olarak
    aynı aralığa döner.
    """
    if granularity == "year":
        if start is None:
            start = date(today.year - 1, 1, 1)
        if end is None:
            end = date(start.year + 4, 12, 31)
        start = date(start.year, 1, 1)
        end = date(end.year, 12, 31)
        label = str(start.year) if start.year == end.year else f"{start.year} – {end.year}"
    else:
        if start is None:
            start = date(today.year, 1, 1)
        if end is None:
            end = date(start.year, 12, 31)
        start = date(start.year, start.month, 1)
        # Bitiş her zaman ayın SON gününe genişletilir — aksi halde "2026-12-01"
        # gibi bir end, aralığın Aralık ayının tamamını kapsamasını engellerdi.
        end_y, end_m = _shift_month(end.year, end.month, 1)
        end = date(end_y, end_m, 1) - timedelta(days=1)
        if start.year == end.year and start.month == 1 and end.month == 12:
            label = str(start.year)
        elif start.year == end.year:
            label = f"{TR_MONTH_SHORT[start.month - 1]} – {TR_MONTH_SHORT[end.month - 1]} {start.year}"
        else:
            label = (
                f"{TR_MONTH_SHORT[start.month - 1]} {start.year} – "
                f"{TR_MONTH_SHORT[end.month - 1]} {end.year}"
            )

    if end < start:
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="end, start'tan önce olamaz",
        )
    return start, end, label


def _bucket_keys(granularity: str, start: date, end: date, today: date) -> list[Bucket]:
    """Dönemi kapsayan boş kovaları üretir — veri olmayan aylar/yıllar da yer alır,
    aksi halde grafikteki boşluklar görünmez ve "yoğunluk" yanlış okunur."""
    buckets: list[Bucket] = []
    if granularity == "year":
        for year in range(start.year, end.year + 1):
            buckets.append(
                Bucket(
                    key=str(year),
                    label=str(year),
                    short=str(year),
                    sub="",
                    delivery_count=0, quantity=0.0,
                    remaining_count=0, remaining_quantity=0.0,
                    completed_count=0, completed_quantity=0.0,
                    overdue_count=0, overdue_quantity=0.0,
                    is_current=year == today.year,
                    is_past=year < today.year,
                )
            )
    else:
        year, month = start.year, start.month
        while (year, month) <= (end.year, end.month):
            key = f"{year:04d}-{month:02d}"
            buckets.append(
                Bucket(
                    key=key,
                    label=f"{TR_MONTH_SHORT[month - 1]} {year}",
                    short=TR_MONTH_SHORT[month - 1],
                    sub=f"'{str(year)[2:]}",
                    delivery_count=0, quantity=0.0,
                    remaining_count=0, remaining_quantity=0.0,
                    completed_count=0, completed_quantity=0.0,
                    overdue_count=0, overdue_quantity=0.0,
                    is_current=key == _month_key(today),
                    is_past=key < _month_key(today),
                )
            )
            year, month = _shift_month(year, month, 1)
    if len(buckets) > MAX_BUCKETS:
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Dönem çok geniş (en fazla {MAX_BUCKETS} kova)",
        )
    return buckets


def _record_bucket_key(granularity: str, value: date) -> str:
    return str(value.year) if granularity == "year" else _month_key(value)


def _to_item(record: _Record, today: date) -> DeliveryItem:
    return DeliveryItem(
        split_id=record.split_id,
        order_id=record.order_id,
        external_id=record.external_id,
        customer_name=record.customer_name,
        product_name=record.product_name,
        quantity=record.quantity,
        delivery_date=record.delivery_date.isoformat(),
        promised_date=record.promised_date.isoformat() if record.promised_date else None,
        days_left=(record.delivery_date - today).days,
        status_key=record.status_bucket,
        status_label=STATUS_BUCKET_LABELS.get(record.status_bucket, record.status_bucket),
        is_component=record.is_component,
        is_outsourced=record.is_outsourced,
        is_overdue=record.is_overdue,
        late_vs_promise=record.late_vs_promise,
    )


@router.get(
    "/summary",
    response_model=StatisticsSummary,
    summary="Aggregated delivery/order statistics for the statistics page",
)
async def get_statistics_summary(
    granularity: str = Query("month", pattern="^(month|year)$"),
    start: date | None = Query(None, description="Dönem başlangıcı; verilmezse içinde bulunulan yıl"),
    end: date | None = Query(None, description="Dönem bitişi; verilmezse start'a göre türetilir"),
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> StatisticsSummary:
    today = datetime.now(timezone.utc).date()
    period_start, period_end, period_label = _resolve_period(granularity, start, end, today)

    result = await db.execute(
        select(Order)
        .where(Order.is_deleted == False)  # noqa: E712
        .options(selectinload(Order.delivery_splits))
    )
    orders = result.scalars().unique().all()

    records: list[_Record] = []
    total_orders = active_orders = completed_orders = 0

    for order in orders:
        splits = [split for split in order.delivery_splits if not split.is_deleted]
        split_statuses = [_derived_split_status(split) for split in splits]
        order_status = (
            _blended_status(order.status, _status_from_split_statuses(split_statuses))
            if splits
            else order.status
        )

        total_orders += 1
        if order_status == OrderStatus.COMPLETED.value:
            completed_orders += 1
        else:
            active_orders += 1

        is_component = order.parent_order_id is not None
        order_outsourced = bool(is_outsourced_from_base_data(order.base_data))
        fallback_product = str((order.base_data or {}).get("product_name") or "").strip() or "(ürün adı yok)"
        customer_key = (order.customer_name or "").strip() or "(müşteri belirtilmemiş)"

        for split in splits:
            delivery_date = _as_date(split.end_date)
            if delivery_date is None:
                continue
            bucket = _split_status_bucket(split)
            is_completed = bucket == "COMPLETED"
            promised = _as_date(split.promised_date) or order.promised_date
            product = str(
                effective_product_params(order.base_data, split.param_overrides).get("product_name") or ""
            ).strip() or fallback_product

            records.append(
                _Record(
                    split_id=str(split.id),
                    order_id=str(order.id),
                    external_id=order.external_id,
                    customer_name=order.customer_name,
                    customer_key=customer_key,
                    product_name=product,
                    quantity=float(split.quantity or 0.0),
                    delivery_date=delivery_date,
                    promised_date=promised,
                    status_bucket=bucket,
                    is_completed=is_completed,
                    is_overdue=not is_completed and delivery_date < today,
                    late_vs_promise=bool(promised and delivery_date > promised),
                    is_component=is_component,
                    is_outsourced=bool(split.is_outsourced) or order_outsourced,
                )
            )

    # ─────────── Genel durum: TÜM kayıtlar, "bugün"e göre ───────────
    totals = Totals(
        total_orders=total_orders,
        active_orders=active_orders,
        completed_orders=completed_orders,
        total_deliveries=len(records),
        remaining_deliveries=0, remaining_quantity=0.0,
        completed_deliveries=0, completed_quantity=0.0,
        overdue_deliveries=0, overdue_quantity=0.0,
        this_month_deliveries=0, this_month_quantity=0.0,
        next_30_days_deliveries=0, next_30_days_quantity=0.0,
        at_risk_deliveries=0,
        outsourced_remaining_deliveries=0,
    )
    current_month = _month_key(today)
    for record in records:
        if record.is_completed:
            totals.completed_deliveries += 1
            totals.completed_quantity += record.quantity
            continue
        totals.remaining_deliveries += 1
        totals.remaining_quantity += record.quantity
        if record.is_outsourced:
            totals.outsourced_remaining_deliveries += 1
        if record.late_vs_promise:
            totals.at_risk_deliveries += 1
        if record.is_overdue:
            totals.overdue_deliveries += 1
            totals.overdue_quantity += record.quantity
            continue
        if _month_key(record.delivery_date) == current_month:
            totals.this_month_deliveries += 1
            totals.this_month_quantity += record.quantity
        if (record.delivery_date - today).days <= 30:
            totals.next_30_days_deliveries += 1
            totals.next_30_days_quantity += record.quantity
    for field in ("remaining_quantity", "completed_quantity", "overdue_quantity",
                  "this_month_quantity", "next_30_days_quantity"):
        setattr(totals, field, round(getattr(totals, field), 2))

    # ─────────── Dönem kapsamı: yalnızca aralıktaki teslimatlar ───────────
    scoped = [r for r in records if period_start <= r.delivery_date <= period_end]

    buckets = _bucket_keys(granularity, period_start, period_end, today)
    by_key = {b.key: b for b in buckets}
    period_totals = PeriodTotals(
        delivery_count=0, quantity=0.0,
        remaining_count=0, remaining_quantity=0.0,
        completed_count=0, completed_quantity=0.0,
        overdue_count=0, overdue_quantity=0.0,
        at_risk_count=0,
        avg_per_bucket=0.0, avg_quantity_per_bucket=0.0,
    )
    status_stats: dict[str, dict[str, float]] = defaultdict(lambda: {"count": 0.0, "quantity": 0.0})
    customer_stats: dict[str, dict] = {}
    product_stats: dict[str, dict[str, float]] = defaultdict(
        lambda: {"remaining_deliveries": 0.0, "remaining_quantity": 0.0}
    )

    for record in scoped:
        bucket = by_key.get(_record_bucket_key(granularity, record.delivery_date))
        period_totals.delivery_count += 1
        period_totals.quantity += record.quantity
        status_stats[record.status_bucket]["count"] += 1
        status_stats[record.status_bucket]["quantity"] += record.quantity
        if bucket is not None:
            bucket.delivery_count += 1
            bucket.quantity += record.quantity

        if record.is_completed:
            period_totals.completed_count += 1
            period_totals.completed_quantity += record.quantity
            if bucket is not None:
                bucket.completed_count += 1
                bucket.completed_quantity += record.quantity
            continue

        period_totals.remaining_count += 1
        period_totals.remaining_quantity += record.quantity
        if bucket is not None:
            bucket.remaining_count += 1
            bucket.remaining_quantity += record.quantity
        if record.late_vs_promise:
            period_totals.at_risk_count += 1
        if record.is_overdue:
            period_totals.overdue_count += 1
            period_totals.overdue_quantity += record.quantity
            if bucket is not None:
                bucket.overdue_count += 1
                bucket.overdue_quantity += record.quantity

        entry = customer_stats.setdefault(
            record.customer_key,
            {"remaining_deliveries": 0, "remaining_quantity": 0.0, "overdue_deliveries": 0, "next": None},
        )
        entry["remaining_deliveries"] += 1
        entry["remaining_quantity"] += record.quantity
        if record.is_overdue:
            entry["overdue_deliveries"] += 1
        if entry["next"] is None or record.delivery_date < entry["next"]:
            entry["next"] = record.delivery_date

        product = product_stats[record.product_name]
        product["remaining_deliveries"] += 1
        product["remaining_quantity"] += record.quantity

    for bucket in buckets:
        for field in ("quantity", "remaining_quantity", "completed_quantity", "overdue_quantity"):
            setattr(bucket, field, round(getattr(bucket, field), 2))

    # Ortalama, YALNIZCA teslimatı olan kovalar üzerinden — boş aylar/yıllar
    # paydaya girerse "kova başına kaç teslimat" göstergesi yapay olarak düşer.
    filled = [b for b in buckets if b.delivery_count > 0]
    if filled:
        period_totals.avg_per_bucket = round(sum(b.delivery_count for b in filled) / len(filled), 1)
        period_totals.avg_quantity_per_bucket = round(sum(b.quantity for b in filled) / len(filled), 1)
    for field in ("quantity", "remaining_quantity", "completed_quantity", "overdue_quantity"):
        setattr(period_totals, field, round(getattr(period_totals, field), 2))

    status_breakdown = [
        StatusBucket(
            key=key,
            label=label,
            count=int(status_stats.get(key, {}).get("count", 0)),
            quantity=round(float(status_stats.get(key, {}).get("quantity", 0.0)), 2),
        )
        for key, label in STATUS_BUCKET_LABELS.items()
    ]

    customers = sorted(
        (
            CustomerBucket(
                name=name,
                remaining_deliveries=int(data["remaining_deliveries"]),
                remaining_quantity=round(float(data["remaining_quantity"]), 2),
                overdue_deliveries=int(data["overdue_deliveries"]),
                next_delivery_date=data["next"].isoformat() if data["next"] else None,
            )
            for name, data in customer_stats.items()
        ),
        key=lambda c: (-c.remaining_quantity, c.name),
    )[:TOP_N]

    products = sorted(
        (
            ProductBucket(
                name=name,
                remaining_deliveries=int(data["remaining_deliveries"]),
                remaining_quantity=round(data["remaining_quantity"], 2),
            )
            for name, data in product_stats.items()
        ),
        key=lambda p: (-p.remaining_quantity, p.name),
    )[:TOP_N]

    deliveries = sorted(scoped, key=lambda r: (r.delivery_date, r.external_id))
    # Geciken listesi BİLİNÇLİ olarak dönemden bağımsız: kullanıcı gelecek bir yıla
    # baksa bile bugün geciken işleri görmeye devam etmeli.
    overdue = sorted(
        (r for r in records if r.is_overdue), key=lambda r: (r.delivery_date, r.external_id)
    )

    return StatisticsSummary(
        generated_at=datetime.now(timezone.utc).isoformat(),
        today=today.isoformat(),
        period=PeriodInfo(
            granularity=granularity,
            start=period_start.isoformat(),
            end=period_end.isoformat(),
            label=period_label,
            contains_today=period_start <= today <= period_end,
        ),
        totals=totals,
        period_totals=period_totals,
        buckets=buckets,
        status_breakdown=status_breakdown,
        customers=customers,
        products=products,
        deliveries=[_to_item(r, today) for r in deliveries[:DELIVERIES_LIMIT]],
        overdue=[_to_item(r, today) for r in overdue[:OVERDUE_LIMIT]],
    )
