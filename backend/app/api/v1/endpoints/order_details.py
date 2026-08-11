"""
Order details API — spreadsheet-friendly view of imported order data.
"""

from datetime import date, datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, require_role
from app.api.v1.endpoints.gantt import (
    MANUAL_STEP_KEYS,
    _apply_component_on_hand,
    _blended_status,
    _get_manual_steps,
    _get_split_manual_steps,
    _normalize_manual_steps,
    _recompute_and_persist_bom_main_order,
    _rescale_component_split,
    _set_manual_steps,
    _set_split_manual_steps,
    _status_from_manual_steps,
    _status_from_split_statuses,
)
from app.core.date_utils import (
    BLOCK_KEYS,
    calculate_split_stage_ranges,
    calculate_split_start_date,
    effective_product_params,
    effective_split_quantity,
    is_outsourced_from_base_data,
)
from app.database import get_db
from app.models.app_setting import AppSetting
from app.models.audit_log import AuditLog
from app.models.delivery_split import DeliverySplit
from app.models.enums import AuditAction, OrderStatus
from app.models.official_holiday import OfficialHoliday
from app.models.order import Order
from app.models.step_employee_assignment import StepEmployeeAssignment
from app.models.user import User, UserRole
from app.schemas.order import BulkCellUpdateRequest, CellUpdateRequest
from app.services.sse_service import sse_manager
from app.services.bom_scheduling import get_components_ready_at, get_components_start_at, cascade_soft_delete_components

router = APIRouter(prefix="/order-details", tags=["Order Details"])

STAGE_BLOCK_LABELS = {
    "supply": "Tedarik",
    "assembly": "Dizgi",
    "production": "Üretim",
    "test": "Test",
    "delivery": "Teslimat",
}

def _split_is_outsourced(order: Order, split: DeliverySplit) -> bool:
    """Split.is_outsourced OR the shared base_data outsourcing detector
    (`is_outsourced_from_base_data`, date_utils.py) — used by the stage-schedule
    GET/PUT handlers so the "Dizgi" block's label (and the drag-and-drop timeline
    editor that reads it) reflects fason status consistently with the main Gantt
    view (gantt.py) and app_settings.py's capacity calc, which use the same
    detector so all three surfaces agree on the same order."""
    return bool(split.is_outsourced) or bool(is_outsourced_from_base_data(order.base_data))


def _stage_labels_for(is_outsourced: bool) -> dict[str, str]:
    labels = dict(STAGE_BLOCK_LABELS)
    if is_outsourced:
        labels["assembly"] = "Fason (Dış Dizgi)"
    return labels

VISIBLE_BASE_DATA_KEYS = {
    "product_name",
    "supply_days",
    "production_days",
    "is_outsourced",
    "production_mode",
}


class OrderDetailRow(BaseModel):
    order_id: str
    external_id: str
    status: str
    current_step_key: str | None = None
    order_status: str
    order_current_step_key: str | None = None
    total_quantity: float | None = None
    customer_name: str | None = None
    responsible_personnel: str | None = None
    order_date: str | None = None
    promised_date: str | None = None
    requirement_date: str | None = None
    penalty_date: str | None = None
    mapping_template_id: str
    mapping_template_name: str | None = None
    created_by: str
    created_by_username: str | None = None
    order_is_deleted: bool
    order_deleted_at: str | None = None
    order_created_at: str
    order_updated_at: str
    split_id: str | None = None
    split_quantity: float | None = None
    split_on_hand_quantity: float | None = None
    split_start_date: str | None = None
    split_end_date: str | None = None
    split_promised_date: str | None = None
    has_splits: bool = False
    split_count: int = 0
    split_manual_edit: bool | None = None
    split_is_outsourced: bool | None = None
    split_is_deleted: bool | None = None
    split_deleted_at: str | None = None
    split_created_at: str | None = None
    split_updated_at: str | None = None
    has_custom_schedule: bool = False
    base_data: dict[str, Any]
    parent_order_id: str | None = None
    component_product_id: str | None = None
    # Bir BOM bilesen parcasinin bagli oldugu ANA parca. Kaydetme sirasinda
    # bilesenlerin adedi bu bag uzerinden orantili olceklenir
    # (bkz. quantity_changes / _rescale_component_split). Duzenleme ekraninin
    # ONIZLEMEDE ayni olceklemeyi gosterebilmesi icin arayuze de gonderilir —
    # aksi halde ana siparisin adedi degistiginde alt urun barlari ekranda
    # degismiyor, ama KAYDEDINCE degisiyordu (onizleme ile sonuc uyusmuyordu).
    source_main_split_id: str | None = None


class OrderDetailsResponse(BaseModel):
    rows: list[OrderDetailRow]
    total_orders: int
    total_rows: int
    base_data_keys: list[str]


def _iso(value: date | datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat()


def _derived_order_status(order: Order) -> str:
    """Combine manual production-step completion with the DB status (kept in
    sync elsewhere by serial-number completion, see
    ``mark_order_completed_if_all_serials_completed``). Either signal reaching
    a given stage should be reflected here, so neither mechanism is masked by
    the other."""
    steps = _normalize_manual_steps((order.base_data or {}).get("_manual_steps"))
    manual_status = _status_from_manual_steps(steps)
    return _blended_status(order.status, manual_status)


# "Durum" dropdown'unun her seçeneği, manuel adım takibindeki (STEP_LABELS) aynı
# isimlerle bire bir eşleşir. Değer, (o an kaç adımın işaretli olması gerektiği,
# hangi status'e geçileceği) çiftini doğrudan belirtir. "PENDING" ve "supply"
# (Tedarik) ikisi de 0 işaretli adıma karşılık gelir — checked_count tek başına
# bu ikisini ayırt edemez, bu yüzden status ayrıca (checked_count'tan tahmin
# edilmeden) burada açıkça taşınır; Order/DeliverySplit'in kalıcı `status`
# kolonu bu değeri doğrudan alır (bkz. _blended_status), böylece "Tedarik"
# sonradan ilgisiz bir checkbox değişikliğiyle sessizce "Beklemede"ye dönmez.
_STATUS_SELECT_TO_STATE: dict[str, tuple[int, str]] = {
    "PENDING": (0, OrderStatus.PENDING.value),
    "supply": (0, OrderStatus.APPROVED.value),
    "assembly": (1, OrderStatus.APPROVED.value),
    "production": (2, OrderStatus.APPROVED.value),
    "test": (3, OrderStatus.APPROVED.value),
    "delivery": (4, OrderStatus.APPROVED.value),
    "COMPLETED": (5, OrderStatus.COMPLETED.value),
}


def _manual_steps_for_checked_count(
    current_steps: dict[str, dict[str, str | bool | None]],
    checked_count: int,
    actor_id: str,
    actor_username: str | None,
    now_iso: str,
) -> dict[str, dict[str, str | bool | None]]:
    """Set exactly the first `checked_count` steps (in MANUAL_STEP_KEYS order) to
    checked and the rest to unchecked — used when the user directly picks a granular
    status (e.g. "Test") in the preview modal's "Durum" dropdown, so the manual step
    checklist elsewhere in the app lands on that exact state instead of going stale.
    Steps whose checked state doesn't actually change keep their original
    checked_by/checked_at metadata."""

    def checked_entry() -> dict[str, str | bool | None]:
        return {"checked": True, "checked_by": actor_id, "checked_by_username": actor_username, "checked_at": now_iso}

    def unchecked_entry() -> dict[str, str | bool | None]:
        return {"checked": False, "checked_by": None, "checked_by_username": None, "checked_at": None}

    result: dict[str, dict[str, str | bool | None]] = {}
    for i, key in enumerate(MANUAL_STEP_KEYS):
        should_be_checked = i < checked_count
        was_checked = bool(current_steps.get(key, {}).get("checked"))
        if should_be_checked == was_checked:
            result[key] = current_steps.get(key) or unchecked_entry()
        else:
            result[key] = checked_entry() if should_be_checked else unchecked_entry()
    return result


def _current_step_key(order: Order) -> str | None:
    """Key of the next not-yet-completed manual step, for a friendlier
    "in progress" label (e.g. show "Dizgi" once "Tedarik" is checked off)."""
    steps = _normalize_manual_steps((order.base_data or {}).get("_manual_steps"))
    for key in MANUAL_STEP_KEYS:
        if not steps[key].get("checked"):
            return key
    return None


def _derived_split_status(split: DeliverySplit) -> str:
    """Each delivery split tracks its own manual-step progress independently
    of its sibling splits (and of the order's own roll-up status). Blends the
    split's own persisted `status` column with its manual-step checkboxes —
    mirrors `_derived_order_status` — so a directly-set status (e.g. "Tedarik")
    isn't masked by 0 checked steps."""
    manual_status = _status_from_manual_steps(_get_split_manual_steps(split))
    return _blended_status(split.status, manual_status)


def _split_current_step_key(split: DeliverySplit) -> str | None:
    steps = _get_split_manual_steps(split)
    for key in MANUAL_STEP_KEYS:
        if not steps[key].get("checked"):
            return key
    return None


def _order_rollup_current_step_key(order: Order, active_splits: list[DeliverySplit]) -> str | None:
    """"Genel" (collapsed) satırın "şu an X aşamasında" rozeti için geçerli adım.

    Aktif parçası olan siparişlerde ilerleme artık HER parçanın kendi
    ``manual_steps``'inde tutuluyor (bkz. gantt.py update_manual_step_state) —
    order.base_data["_manual_steps"] bu durumda bir daha güncellenmiyor. Bu yüzden
    ``_current_step_key(order)`` burada kullanılırsa rozet hep ilk adımda ("Tedarik")
    donuk kalır. Onun yerine, henüz tamamlanmamış parçalar arasında EN GERİDE olanın
    adımı gösterilir (sipariş bütünüyle bitene kadar "hâlâ bu aşamadayız" anlamına
    gelir) — parçasız (legacy) siparişlerde eskisi gibi order'ın kendi adımı kullanılır.
    """
    if not active_splits:
        return _current_step_key(order)
    step_indices = {key: i for i, key in enumerate(MANUAL_STEP_KEYS)}
    pending_indices = [
        step_indices[key]
        for split in active_splits
        if (key := _split_current_step_key(split)) is not None
    ]
    if not pending_indices:
        return None
    return MANUAL_STEP_KEYS[min(pending_indices)]


def _order_total_quantity(order: Order, active_splits: list[DeliverySplit]) -> float | None:
    """Total quantity to be produced for this order, across all its splits.
    Mirrors the same fallback used to display the parent row in the Gantt chart
    (see gantt.py's ``order_total_qty`` computation)."""
    try:
        stored = float((order.base_data or {}).get("quantity", 0)) or None
    except (ValueError, TypeError):
        stored = None
    if stored:
        return stored
    if active_splits:
        return sum(split.quantity for split in active_splits)
    return None


@router.get(
    "/",
    response_model=OrderDetailsResponse,
    summary="List orders and delivery splits as spreadsheet rows",
)
async def list_order_details(
    include_deleted: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> OrderDetailsResponse:
    """Return all order records with raw imported columns for an Excel-like table."""
    query = select(Order).options(
        selectinload(Order.mapping_template),
        selectinload(Order.creator),
        selectinload(Order.delivery_splits),
    )
    if not include_deleted:
        query = query.where(Order.is_deleted == False)  # noqa: E712

    result = await db.execute(
        query.order_by(Order.created_at.desc())
    )
    orders = result.scalars().unique().all()

    rows: list[OrderDetailRow] = []
    base_data_keys: set[str] = set()

    for order in orders:
        order_base_data = dict(order.base_data or {})
        base_data_keys.update(str(key) for key in order_base_data.keys() if key in VISIBLE_BASE_DATA_KEYS)
        splits = [
            split
            for split in sorted(order.delivery_splits, key=lambda split: split.created_at)
            if include_deleted or not split.is_deleted
        ]
        has_splits = bool((order.base_data or {}).get("is_explicit_split", False))
        split_items = splits or [None]
        order_status = _derived_order_status(order)
        order_current_step_key = (
            _order_rollup_current_step_key(order, splits) if order_status == OrderStatus.APPROVED.value else None
        )
        total_quantity = _order_total_quantity(order, splits)

        for split in split_items:
            if split is not None:
                row_status = _derived_split_status(split)
                row_current_step_key = _split_current_step_key(split) if row_status == OrderStatus.APPROVED.value else None
            else:
                row_status = order_status
                row_current_step_key = order_current_step_key

            rows.append(
                OrderDetailRow(
                    order_id=str(order.id),
                    external_id=order.external_id,
                    status=row_status,
                    current_step_key=row_current_step_key,
                    order_status=order_status,
                    order_current_step_key=order_current_step_key,
                    total_quantity=total_quantity,
                    customer_name=order.customer_name,
                    responsible_personnel=order.responsible_personnel,
                    order_date=_iso(order.order_date),
                    promised_date=_iso(order.promised_date),
                    requirement_date=_iso(order.requirement_date),
                    penalty_date=_iso(order.penalty_date),
                    mapping_template_id=str(order.mapping_template_id),
                    mapping_template_name=order.mapping_template.name if order.mapping_template else None,
                    created_by=str(order.created_by),
                    created_by_username=order.creator.username if order.creator else None,
                    order_is_deleted=order.is_deleted,
                    order_deleted_at=_iso(order.deleted_at),
                    order_created_at=order.created_at.isoformat(),
                    order_updated_at=order.updated_at.isoformat(),
                    split_id=str(split.id) if split else None,
                    split_quantity=split.quantity if split else None,
                    split_on_hand_quantity=split.on_hand_quantity if split else None,
                    split_start_date=_iso(split.start_date) if split else None,
                    split_end_date=_iso(split.end_date) if split else None,
                    split_promised_date=_iso(split.promised_date) if split else None,
                    has_splits=has_splits,
                    split_count=len(splits),
                    split_manual_edit=split.manual_edit if split else None,
                    split_is_outsourced=split.is_outsourced if split else None,
                    split_is_deleted=split.is_deleted if split else None,
                    split_deleted_at=_iso(split.deleted_at) if split else None,
                    split_created_at=_iso(split.created_at) if split else None,
                    split_updated_at=_iso(split.updated_at) if split else None,
                    has_custom_schedule=bool(split.stage_schedule) if split else False,
                    source_main_split_id=(
                        str(split.source_main_split_id)
                        if split and split.source_main_split_id else None
                    ),
                    # Her satırın kendi üretim parametreleri — parça bazlı geçersiz
                    # kılmalar (varsa) sipariş-geneli değerlerin üzerine yazılır, böylece
                    # aynı siparişin farklı parçaları artık AYNI referansı PAYLAŞMAZ.
                    base_data=effective_product_params(order.base_data, split.param_overrides if split else None),
                    parent_order_id=str(order.parent_order_id) if order.parent_order_id else None,
                    component_product_id=str(order.component_product_id) if order.component_product_id else None,
                )
            )

    return OrderDetailsResponse(
        rows=rows,
        total_orders=len(orders),
        total_rows=len(rows),
        base_data_keys=sorted(base_data_keys, key=str.lower),
    )


ORDER_FIELD_KEYS = {
    "customer_name",
    "responsible_personnel",
    "order_date",
    "promised_date",
    "requirement_date",
    "penalty_date",
    "status",
    "external_id",
}

SPLIT_FIELD_KEYS = {
    "quantity",
    "start_date",
    "end_date",
    "is_outsourced",
    # "promised_date" DEĞİL — ORDER_FIELD_KEYS'te aynı isimde sipariş-seviyesi bir
    # alan zaten var; aynı field_key kullanılırsa if/elif zinciri isteği yanlışlıkla
    # order.promised_date dalına yönlendirir. Split-seviyesi alan için ayrı isim.
    "split_promised_date",
    # Aynı sebeple "status" değil: ORDER_FIELD_KEYS'teki "status" TÜM aktif
    # split'lere birden uygulanır (parçalı siparişlerde hepsi aynı duruma geçerdi —
    # bu tam olarak düzeltilen sorun). Her ürün/teslimatın kendi üretim sürecini
    # bağımsız ilerletebilmesi için ayrı isim.
    "split_status",
    # Gerçek bir DB kolonu değil — bir BOM bileşen (component) split'inin "elde
    # zaten mevcut olan miktarı"nı bir kerelik düşüm eylemi olarak temsil eder
    # (bkz. aşağıdaki elif dalı, _rescale_component_split). CreateDeliveryModal'daki
    # sipariş-oluşturma-anı "elde mevcut" özelliğinin var olan siparişler için
    # karşılığı.
    "on_hand_reduction",
}

# base_data içindeki zamanlama/üretim parametreleri — bunlar her zaman sayı olarak
# saklanmalı (anahtar daha önce hiç yoksa bile), aksi halde string değer süre
# hesaplarını (calculate_split_start_date vb.) bozar. Ayrıca bu anahtarlardan biri
# değişince siparişin aktif split'lerinin start_date'i yeniden hesaplanır.
NUMERIC_BASE_DATA_KEYS = {
    "supply_days",
    "assembly_days",
    "production_days",
    "outsource_days",
    "delivery_days",
    "quality_minutes",
    "epoxy_minutes",
    "conformal_minutes",
    "montaj_minutes",
    "montaj_kalite_minutes",
    "test1_minutes",
    "test2_minutes",
    "final_test_minutes",
    "production_flat_days",
    "test_flat_days",
    "assembly_flat_days",
}

# "Üretim Parametreleri" bölümündeki Adet/Gün anahtarı (string enum: "per_unit"/"flat")
# — dizgi+üretim+test'in üçünü birden etkiler, bu yüzden değiştiğinde de start_date
# yeniden hesaplanmalı (NUMERIC_BASE_DATA_KEYS ile aynı desende, ayrı tutuluyor çünkü
# sayısal değil).
DURATION_MODE_KEY = "duration_mode"


def _json_safe(value: Any) -> Any:
    """AuditLog.old_value/new_value JSONB kolonlarına yazmadan önce datetime/date
    nesnelerini ISO string'e çevirir — aksi halde bulk-update, split.end_date/
    start_date gibi NOT NULL tarih alanlarının (her zaman dolu olan) eski değerini
    denetim kaydına yazarken "datetime is not JSON serializable" hatasıyla çöker."""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def _parse_date_value(value: str | None) -> date | None:
    if value is None or value == "":
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
    except (ValueError, TypeError):
        try:
            return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
        except (ValueError, TypeError):
            raise ValueError(f"Cannot parse date: {value}")


def _parse_number_value(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (ValueError, TypeError):
        raise ValueError(f"Cannot parse number: {value}")


def _parse_bool_value(value: Any) -> bool | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() in ("1", "true", "t", "yes", "y", "evet", "e")
    return bool(value)


async def _load_order_detail_holidays(db: AsyncSession) -> set[date]:
    result = await db.execute(
        select(OfficialHoliday.holiday_date).where(OfficialHoliday.is_active == True)
    )
    return set(result.scalars().all())


async def _load_order_detail_work_hours(db: AsyncSession) -> float:
    result = await db.execute(
        select(AppSetting).where(AppSetting.key == "work_hours_per_day")
    )
    setting = result.scalar_one_or_none()
    if setting is not None:
        try:
            return float(setting.value)
        except (ValueError, TypeError):
            pass
    return 8.0


async def _load_order_detail_employee_map(
    db: AsyncSession,
) -> dict[str, dict[str, float]]:
    result = await db.execute(select(StepEmployeeAssignment))
    rows = result.scalars().all()
    emp_map: dict[str, dict[str, float]] = {}
    order_ids_with_rows: set[str] = set()
    for row in rows:
        if row.split_id is not None:
            sid = str(row.split_id)
            if sid not in emp_map:
                emp_map[sid] = {"assembly": 1.0, "production": 1.0, "test": 1.0}
            emp_map[sid][row.step_key] = float(row.employee_count)
        else:
            oid = str(row.order_id)
            order_ids_with_rows.add(oid)
            if oid not in emp_map:
                emp_map[oid] = {"assembly": 1.0, "production": 1.0, "test": 1.0}
            emp_map[oid][row.step_key] = float(row.employee_count)
    all_orders = await db.execute(select(Order).where(Order.is_deleted == False))
    for o in all_orders.scalars().all():
        oid = str(o.id)
        if oid not in order_ids_with_rows and oid not in emp_map:
            emp_map[oid] = {"assembly": 1.0, "production": 1.0, "test": 1.0}
    return emp_map


class StageScheduleBlockOut(BaseModel):
    key: str
    label: str
    start: str
    end: str


class StageScheduleOut(BaseModel):
    split_id: str
    is_custom: bool
    blocks: list[StageScheduleBlockOut]
    warnings: list[str] = []


class StageScheduleBlockIn(BaseModel):
    key: str
    start: str
    end: str


class StageScheduleUpdateRequest(BaseModel):
    blocks: list[StageScheduleBlockIn]


async def _load_split_and_order(db: AsyncSession, split_id: str) -> tuple[DeliverySplit, Order]:
    try:
        split_uuid = UUID(split_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid split_id")

    result = await db.execute(select(DeliverySplit).where(DeliverySplit.id == split_uuid))
    split = result.scalar_one_or_none()
    if split is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Split not found")

    order_result = await db.execute(select(Order).where(Order.id == split.order_id))
    order = order_result.scalar_one_or_none()
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found")

    return split, order


async def _suggested_stage_schedule(db: AsyncSession, order: Order, split: DeliverySplit) -> list[dict]:
    """Compute the system's suggested 5-block schedule for a split — the initial
    proposal the drag-and-drop editor starts from before the user customizes it.

    BOM entegrasyonu: bu split bir bileşen siparişine (component_product_id dolu)
    aitse Teslimat bloğu hiç üretilmez (bileşen müşteriye teslim edilmez). Bu split
    bir ANA siparişe aitse ve kendi bileşenleri (parent_order_id ile bağlı) varsa,
    Dizgi atlanıp Üretim'in başlangıcı bileşenlerin bitişine göre (gerekirse ileri
    kaydırılarak) hesaplanır — gantt.py'deki create_manual_task ile aynı kural."""
    holidays = await _load_order_detail_holidays(db)
    work_hours_per_day = await _load_order_detail_work_hours(db)
    work_minutes = work_hours_per_day * 60
    emp_map = await _load_order_detail_employee_map(db)
    sid = str(split.id)
    oid = str(order.id)
    emp = emp_map.get(sid, emp_map.get(oid, {"assembly": 1.0, "production": 1.0, "test": 1.0}))
    product_params = effective_product_params(order.base_data, split.param_overrides)

    include_delivery = order.component_product_id is None
    component_ready_at = None
    if order.parent_order_id is None:
        component_ready_at = await get_components_ready_at(db, order.id)

    return calculate_split_stage_ranges(
        end_date=split.end_date,
        quantity=effective_split_quantity(split),
        product_params=product_params,
        emp=emp,
        work_minutes=work_minutes,
        holidays=holidays,
        is_outsourced=_split_is_outsourced(order, split),
        component_ready_at=component_ready_at,
        include_delivery=include_delivery,
        start_date=split.start_date,
    )


@router.get(
    "/splits/{split_id}/stage-schedule",
    response_model=StageScheduleOut,
    summary="Get the suggested or user-confirmed 5-block stage schedule for a delivery split",
)
async def get_split_stage_schedule(
    split_id: str,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> StageScheduleOut:
    split, order = await _load_split_and_order(db, split_id)
    labels = _stage_labels_for(_split_is_outsourced(order, split))

    if split.stage_schedule:
        blocks_map = split.stage_schedule.get("blocks") or {}
        # Kaydedilmiş özel programda bir blok (ör. Test) yer almayabilir — özel
        # program kaydedildiği anda o bloğun süresi 0/boştu demektir. Sonradan o
        # bloğu gerektirecek parametreler eklenirse (artık güncel önerilen
        # programda varsa), eksik anahtar EBEDİYEN kaybolmasın diye önerilen
        # konumundan geri eklenir — kullanıcının özel konumlandırdığı diğer
        # bloklara dokunulmaz.
        suggested_by_key = {b["key"]: b for b in await _suggested_stage_schedule(db, order, split)}
        # Rows are always shown in canonical order (Tedarik → ... → Teslimat); only
        # each row's date position is user-customized.
        blocks_out: list[StageScheduleBlockOut] = []
        for key in BLOCK_KEYS:
            if key in blocks_map:
                blocks_out.append(StageScheduleBlockOut(
                    key=key,
                    label=labels.get(key, key),
                    start=blocks_map[key]["start"],
                    end=blocks_map[key]["end"],
                ))
            elif key in suggested_by_key:
                b = suggested_by_key[key]
                blocks_out.append(StageScheduleBlockOut(
                    key=key,
                    label=labels.get(key, key),
                    start=b["start"].isoformat(),
                    end=b["end"].isoformat(),
                ))
        return StageScheduleOut(split_id=split_id, is_custom=True, blocks=blocks_out)

    suggested = await _suggested_stage_schedule(db, order, split)
    blocks_out = [
        StageScheduleBlockOut(
            key=b["key"],
            label=labels.get(b["key"], b["key"]),
            start=b["start"].isoformat(),
            end=b["end"].isoformat(),
        )
        for b in suggested
    ]
    return StageScheduleOut(split_id=split_id, is_custom=False, blocks=blocks_out)


@router.put(
    "/splits/{split_id}/stage-schedule",
    response_model=StageScheduleOut,
    summary="Save a user-confirmed custom stage schedule for a delivery split",
)
async def update_split_stage_schedule(
    split_id: str,
    body: StageScheduleUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> StageScheduleOut:
    """Persist the user's drag-and-drop schedule exactly as confirmed — each stage keeps
    its own row and may freely overlap its siblings. Warnings are informational only
    (unusual sequence, excessive duration, slipping past the promised date) — we
    suggest, the user decides, we never block the save."""
    split, order = await _load_split_and_order(db, split_id)
    labels = _stage_labels_for(_split_is_outsourced(order, split))

    if not body.blocks:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="blocks cannot be empty")

    parsed_blocks: list[tuple[str, datetime, datetime]] = []
    for b in body.blocks:
        if b.key not in STAGE_BLOCK_LABELS:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Unknown stage key: {b.key}")
        try:
            start_dt = datetime.fromisoformat(b.start.replace("Z", "+00:00"))
            end_dt = datetime.fromisoformat(b.end.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Invalid date for stage {b.key}")
        if end_dt <= start_dt:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"{b.key}: end must be after start")
        parsed_blocks.append((b.key, start_dt, end_dt))

    warnings: list[str] = []
    canonical_order = {key: i for i, key in enumerate(BLOCK_KEYS)}
    # Sequence deviation is judged by actual start-date order, not submission order —
    # rows are always shown in canonical order, only their date position can vary.
    by_start = sorted(parsed_blocks, key=lambda blk: blk[1])
    canonical_positions = [canonical_order.get(k, -1) for k, _s, _e in by_start]
    if canonical_positions != sorted(canonical_positions):
        warnings.append(
            "Adım sırası standart üretim akışından (Tedarik → Dizgi → Üretim → Test → Teslimat) farklı."
        )

    last_end = max(end_dt for _key, _start_dt, end_dt in parsed_blocks)
    # Bu parçaya özel bir söz verilen tarih varsa (split.promised_date) ONU kullan —
    # order.promised_date yalnızca split kendi tarihini hiç almamışsa yedek (fallback).
    # Aksi halde çok parçalı, farklı teslim tarihli siparişlerde uyarı hep sipariş
    # genelindeki (alakasız olabilecek) tarihe göre verilirdi.
    split_promised_date = split.promised_date.date() if split.promised_date else None
    effective_promised_date = split_promised_date or order.promised_date
    if effective_promised_date and last_end.date() > effective_promised_date:
        warnings.append("Planlanan bitiş, söz verilen teslim tarihinden sonraya sarkıyor.")

    old_value = split.stage_schedule
    new_schedule = {
        "blocks": {
            key: {"start": start_dt.isoformat(), "end": end_dt.isoformat()}
            for key, start_dt, end_dt in parsed_blocks
        },
    }
    split.stage_schedule = new_schedule

    db.add(
        AuditLog(
            entity_type="delivery_split",
            entity_id=split.id,
            action=AuditAction.UPDATE.value,
            old_value={"stage_schedule": old_value},
            new_value={"stage_schedule": new_schedule, "warnings": warnings},
            performed_by=current_user.id,
        )
    )
    await db.commit()

    # bulk_update_cells/step-employees ile aynı desen — bu split zaten açık olan
    # başka bir sekmede (Gantt/Takvim/Adım Görünümü) gösteriliyorsa, sayfa elle
    # yenilenmeden zaman çizelgesindeki yeni blok konumlarını görsün diye.
    await sse_manager.publish("TASK_UPDATED", {
        "task_id": f"split_{split_id}",
        "updated_by": current_user.username,
        "action": "stage_schedule_update",
    })

    blocks_out = [
        StageScheduleBlockOut(
            key=key,
            label=labels.get(key, key),
            start=start_dt.isoformat(),
            end=end_dt.isoformat(),
        )
        for key, start_dt, end_dt in parsed_blocks
    ]
    return StageScheduleOut(split_id=split_id, is_custom=True, blocks=blocks_out, warnings=warnings)


@router.delete(
    "/splits/{split_id}/stage-schedule",
    response_model=StageScheduleOut,
    summary="Clear a split's confirmed custom schedule, reverting it to the live system suggestion",
)
async def clear_split_stage_schedule(
    split_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> StageScheduleOut:
    """"Sistem Önerisi" tıklanıp üzerinde elle hiçbir değişiklik yapılmadan kaydedilirse
    bu gerçek bir özel program değildir — frontend bu durumu PUT yerine burayı çağırarak
    ayırt eder. stage_schedule temizlenir, split kalıcı olarak "kilitlenmek" yerine adet/
    parametre/çalışan sayısı değiştikçe otomatik güncel öneriye göre hesaplanmaya devam eder."""
    split, order = await _load_split_and_order(db, split_id)
    labels = _stage_labels_for(_split_is_outsourced(order, split))

    old_value = split.stage_schedule
    if old_value is not None:
        split.stage_schedule = None
        db.add(
            AuditLog(
                entity_type="delivery_split",
                entity_id=split.id,
                action=AuditAction.UPDATE.value,
                old_value={"stage_schedule": old_value},
                new_value={"stage_schedule": None},
                performed_by=current_user.id,
            )
        )
        await db.commit()
        await sse_manager.publish("TASK_UPDATED", {
            "task_id": f"split_{split_id}",
            "updated_by": current_user.username,
            "action": "stage_schedule_cleared",
        })

    suggested = await _suggested_stage_schedule(db, order, split)
    blocks_out = [
        StageScheduleBlockOut(
            key=b["key"],
            label=labels.get(b["key"], b["key"]),
            start=b["start"].isoformat(),
            end=b["end"].isoformat(),
        )
        for b in suggested
    ]
    return StageScheduleOut(split_id=split_id, is_custom=False, blocks=blocks_out)


@router.patch(
    "/bulk-update",
    summary="Update cells in the order details spreadsheet",
)
async def bulk_update_cells(
    body: BulkCellUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> dict:
    """
    Accept a list of cell updates and apply them to orders / delivery_splits / base_data.
    """
    if not body.updates:
        return {"updated": 0}

    # Collect all unique order_ids
    order_ids: set[UUID] = set()
    split_ids: set[UUID] = set()
    for upd in body.updates:
        try:
            order_ids.add(UUID(upd.order_id))
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid order_id: {upd.order_id}",
            )
        if upd.split_id:
            try:
                split_ids.add(UUID(upd.split_id))
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"Invalid split_id: {upd.split_id}",
                )

    # Load orders
    result = await db.execute(
        select(Order).where(Order.id.in_(order_ids)).options(selectinload(Order.delivery_splits))
    )
    orders = {str(o.id): o for o in result.scalars().all()}
    for oid in order_ids:
        if str(oid) not in orders:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Order not found: {oid}",
            )

    # Load splits
    splits: dict[str, DeliverySplit] = {}
    if split_ids:
        result = await db.execute(
            select(DeliverySplit).where(DeliverySplit.id.in_(split_ids))
        )
        for s in result.scalars().all():
            splits[str(s.id)] = s

    audit_logs: list[AuditLog] = []
    updated_count = 0
    warnings: list[str] = []
    splits_needing_start_recalc: set[str] = set()
    # BOM: bir ANA siparişin split'inin miktarı burada (bölme değil, doğrudan
    # hücre düzenleme ile) değişirse, bağlı bileşen (component) split'lerinin
    # miktarını da orantılı güncellemek için — split_id -> (eski, yeni) miktar.
    quantity_changes: dict[str, tuple[float, float]] = {}
    # BOM: "on_hand_reduction" ile miktarı düşürülen bileşen split'lerin id'leri —
    # bunlar splits_needing_start_recalc'a EKLENMEZ (genel start-date-yeniden-hesapla
    # bloğu _rescale_component_split'in yaptığını çakışarak geçersiz kılardı), ama
    # bağlı ana siparişin yeniden hesaplanması tetiklenmeli (aşağıdaki
    # bom_main_orders_to_recompute toplama adımına dahil edilir).
    component_on_hand_touched_splits: set[str] = set()
    on_hand_holidays: set | None = None
    on_hand_work_minutes: float | None = None

    for upd in body.updates:
        order = orders[upd.order_id]
        split = splits.get(upd.split_id) if upd.split_id else None

        field_key = upd.field_key
        new_value = upd.value
        old_value: Any = None

        if field_key in ORDER_FIELD_KEYS:
            # Order-level fields
            old_value = getattr(order, field_key, None)

            if field_key == "status":
                if new_value not in _STATUS_SELECT_TO_STATE:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail=f"Invalid status: {new_value}",
                    )
                # BOM ana siparişlerde "Dizgi" ayrı/seçilebilir bir adım değildir
                # (bkz. gantt.py update_manual_step_state'teki aynı kural) — normal
                # arayüz bu seçeneği zaten sunmuyor, burası yalnızca doğrudan API
                # çağrısına karşı savunma amaçlı.
                if new_value == "assembly" and await get_components_ready_at(db, order.id) is not None:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail="Bu siparişin alt ürünleri olduğu için 'Dizgi' ayrı bir adım değildir — Tedarik tamamlanınca otomatik atlanır.",
                    )
                checked_count, new_status = _STATUS_SELECT_TO_STATE[new_value]
                setattr(order, "status", new_status)

                # Manuel adım takibi bu doğrudan değişikliğe göre ilerlesin/gerilesin —
                # aksi halde "Durum" burada değiştirilir ama adım kutucukları eski
                # (tutarsız) halinde kalır. Aktif parça varsa HER birine uygulanır (her
                # parça kendi ilerlemesini bağımsız tutar, sipariş durumu bunların
                # roll-up'ıdır); parça yoksa siparişin kendi _manual_steps'ine uygulanır.
                now_iso = datetime.now(timezone.utc).isoformat()
                active_splits = [s for s in order.delivery_splits if not s.is_deleted]
                if active_splits:
                    for s in active_splits:
                        _set_split_manual_steps(
                            s,
                            _manual_steps_for_checked_count(
                                _get_split_manual_steps(s), checked_count, str(current_user.id), current_user.username, now_iso
                            ),
                        )
                        # Split'in kendi status kolonu da eşlenir — aksi halde bu parça tek
                        # başına sorgulandığında (_derived_split_status) 0 işaretli adımı
                        # "Beklemede" sanır, oysa burada az önce "Tedarik" (veya başka bir
                        # granüler durum) olarak açıkça seçildi.
                        s.status = new_status
                else:
                    _set_manual_steps(
                        order,
                        _manual_steps_for_checked_count(
                            _get_manual_steps(order), checked_count, str(current_user.id), current_user.username, now_iso
                        ),
                    )

            elif field_key in ("order_date", "promised_date", "requirement_date", "penalty_date"):
                try:
                    parsed = _parse_date_value(new_value)
                except ValueError as e:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail=f"Invalid date for {field_key}: {e}",
                    )
                setattr(order, field_key, parsed)

            elif field_key in ("customer_name", "responsible_personnel"):
                setattr(order, field_key, str(new_value) if new_value is not None else None)

            elif field_key == "external_id":
                new_external_id = str(new_value).strip() if new_value is not None else ""
                # Boş bırakılması bilinçli bir seçim — "MANUEL-<zaman damgası>" gibi
                # teknik bir kod yerine, manuel oluşturmadaki (create_manual_task)
                # aynı "atanmamış" yer tutucusu kullanılır. "?" biricik bir iş
                # anahtarı olmadığından çakışma kontrolüne de tabi tutulmaz — birden
                # fazla sipariş aynı anda "?" taşıyabilir.
                if not new_external_id:
                    new_external_id = "?"
                elif new_external_id != "?":
                    # Excel yeniden-içe-aktarma eşlemesi, denetim kaydı arama ve Gantt
                    # gösterimleri external_id'yi biricik bir iş anahtarı gibi kullanıyor
                    # (bkz. excel_service.py db_lookup) — burada çakışmaya izin verilirse
                    # iki sipariş aynı numarayı taşır ve o eşlemeler sessizce karışır.
                    duplicate = await db.execute(
                        select(Order.id).where(
                            and_(
                                Order.external_id == new_external_id,
                                Order.id != order.id,
                                Order.is_deleted == False,  # noqa: E712
                            )
                        )
                    )
                    if duplicate.scalar_one_or_none() is not None:
                        raise HTTPException(
                            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=f"Bu sipariş no zaten kullanılıyor: {new_external_id}",
                        )
                setattr(order, field_key, new_external_id)

        elif upd.split_id and field_key in (NUMERIC_BASE_DATA_KEYS | {DURATION_MODE_KEY}):
            # Üretim parametreleri artık parça bazlı bağımsız olabilir — split_id
            # verilmişse bu alan SİPARİŞ GENELİNE değil, YALNIZCA bu parçanın
            # param_overrides'ına yazılır (eksik anahtarlar order.base_data'dan miras
            # alınmaya devam eder, bkz. effective_product_params). split_id yoksa
            # (siparişte hiç split yoksa) aşağıdaki genel base_data dalı hâlâ çalışır.
            if not split:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"Cannot update split field '{field_key}' without split_id",
                )
            old_value = effective_product_params(order.base_data, split.param_overrides).get(field_key)
            overrides = dict(split.param_overrides or {})
            if field_key == DURATION_MODE_KEY:
                overrides[field_key] = str(new_value) if new_value not in (None, "") else None
            else:
                try:
                    overrides[field_key] = _parse_number_value(new_value)
                except ValueError:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail=f"Invalid number for {field_key}: {new_value}",
                    )
                if field_key == "assembly_days":
                    # "production_days" (RightPanel'in eski "Dizgi" alanı) date_utils.py'de
                    # `assembly_d = params.get("production_days") or params.get("assembly_days")`
                    # ile assembly_days'i GÖLGELER — sipariş genelinde production_days set
                    # edilmişse, split'e özel assembly_days override'ı sessizce göz ardı
                    # edilirdi. Bu yüzden aynı anda gölgeleyen anahtar da geçersiz kılınır.
                    overrides["production_days"] = None
            split.param_overrides = overrides
            if overrides.get(field_key) != old_value:
                splits_needing_start_recalc.add(upd.split_id)
                # Onaylanmış özel takvim (stage_schedule) varsa, artık DEĞİŞMİŞ bir
                # üretim parametresine göre hesaplanmış eski blok sürelerini taşıyor —
                # yanlış (artık geçersiz) süreleri sessizce göstermeye devam etmesin
                # diye temizlenir; ekran otomatik olarak güncel (doğru) önerilen
                # takvime döner, kullanıcı isterse yeniden özelleştirip onaylar.
                if split.stage_schedule:
                    split.stage_schedule = None

        elif field_key in SPLIT_FIELD_KEYS:
            if not split:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"Cannot update split field '{field_key}' without split_id",
                )

            old_value = getattr(split, field_key, None)

            if field_key == "end_date":
                try:
                    parsed = _parse_date_value(new_value)
                except ValueError as e:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail=f"Invalid date for {field_key}: {e}",
                    )
                if parsed is None:
                    # end_date, DB'de NOT NULL — boş bırakılırsa None yazılıp
                    # commit anında IntegrityError fırlatır ve bu YALNIZCA bu hücreyi
                    # değil, AYNI İSTEKTEKİ TÜM diğer hücre değişikliklerini de
                    # rollback ederdi (hepsi tek transaction). Bunun yerine burada,
                    # DB'ye gitmeden ÖNCE, açık bir 422 ile reddedilir.
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail="end_date boş bırakılamaz",
                    )
                new_end = datetime.combine(parsed, datetime.min.time()).replace(tzinfo=timezone.utc)
                setattr(split, field_key, new_end)
                # Kaydedilmiş özel zaman çizelgesi (stage_schedule) varsa onun
                # "gerçek" çapası her zaman split.end_date'tir — teslimat bitiş
                # tarihi değişince özel program eski (artık anlamsız) tarihlerde
                # donmuş kalmasın diye TÜM bloklar aynı delta kadar kaydırılır
                # (blokların birbirine göre süresi/boşluğu AYNEN korunur).
                if split.stage_schedule and old_value is not None:
                    delta = new_end - old_value
                    if delta:
                        blocks_map = split.stage_schedule.get("blocks") or {}
                        split.stage_schedule = {
                            "blocks": {
                                key: {
                                    "start": (datetime.fromisoformat(b["start"]) + delta).isoformat(),
                                    "end": (datetime.fromisoformat(b["end"]) + delta).isoformat(),
                                }
                                for key, b in blocks_map.items()
                            }
                        }
                split.manual_edit = True
                if upd.split_id:
                    splits_needing_start_recalc.add(upd.split_id)

            elif field_key == "start_date":
                try:
                    parsed = _parse_date_value(new_value)
                except ValueError as e:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail=f"Invalid date for {field_key}: {e}",
                    )
                if parsed is None:
                    # start_date de NOT NULL — aynı gerekçe (end_date dalındaki yorum).
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail="start_date boş bırakılamaz",
                    )
                setattr(split, field_key, datetime.combine(parsed, datetime.min.time()).replace(tzinfo=timezone.utc))
                split.manual_edit = True

            elif field_key == "quantity":
                try:
                    parsed = _parse_number_value(new_value)
                except ValueError as e:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail=f"Invalid number for {field_key}: {e}",
                    )
                # quantity da NOT NULL — boş bırakılırsa (parsed None) aynı gerekçeyle
                # reddedilir (0'dan büyük olması gerektiği kontrolüyle birleştirildi).
                if parsed is None or parsed <= 0:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail="quantity must be > 0",
                    )
                if parsed != old_value and split.stage_schedule:
                    # Onaylanmış özel takvim, eski miktara göre hesaplanmış blok
                    # sürelerini taşıyor — miktar değişince geçersiz kalır (bkz.
                    # param_overrides dalındaki aynı gerekçe), bu yüzden temizlenir.
                    split.stage_schedule = None
                if upd.split_id and parsed != old_value and old_value:
                    # BOM: bu split bir ANA siparişinkiyse, bağlı bileşen split'lerinin
                    # miktarını da orantılı güncellemek için eski/yeni değer saklanır
                    # (bkz. tanım yeri — asıl sync ana update döngüsünden SONRA yapılır).
                    quantity_changes[upd.split_id] = (float(old_value), float(parsed))
                split.quantity = parsed
                split.manual_edit = True
                if upd.split_id:
                    splits_needing_start_recalc.add(upd.split_id)

            elif field_key == "is_outsourced":
                # is_outsourced da NOT NULL (default False) — boş hücre None üretip
                # aynı IntegrityError/toplu-rollback riskini taşırdı (bkz. yukarıdaki
                # end_date/start_date/quantity dallarındaki aynı gerekçe).
                parsed_outsourced = _parse_bool_value(new_value)
                if parsed_outsourced is None:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail="is_outsourced boş bırakılamaz",
                    )
                split.is_outsourced = parsed_outsourced

            elif field_key == "split_promised_date":
                # Bu parçaya özel, kullanıcının elle girdiği sabit söz verilen tarih —
                # BİLİNÇLİ OLARAK manual_edit=True set etmiyor ve
                # splits_needing_start_recalc'a eklemiyor: hiçbir yeniden hesaplamayı
                # tetiklememeli (bar sürükleme/parametre/işçi değişikliklerinden bağımsız).
                # old_value burada override edilir — genel `getattr(split, field_key)`
                # (satır 684) "split_promised_date" adında bir öznitelik bulamaz, gerçek
                # kolon adı `promised_date`.
                old_value = split.promised_date
                try:
                    parsed = _parse_date_value(new_value)
                except ValueError as e:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail=f"Invalid date for {field_key}: {e}",
                    )
                if parsed is not None:
                    split.promised_date = datetime.combine(parsed, datetime.min.time()).replace(tzinfo=timezone.utc)
                else:
                    split.promised_date = None

            elif field_key == "split_status":
                # Her ürün/teslimat kendi üretim sürecini bağımsız ilerletebilsin diye —
                # yalnızca BU split'in manuel adımları değişir, kardeş split'ler
                # etkilenmez (parçalı siparişlerde hepsinin aynı duruma geçmesi hatasını
                # düzeltir). old_value burada override edilir — genel
                # `getattr(split, field_key)` "split_status" adında bir öznitelik bulamaz.
                old_value = _derived_split_status(split)
                if new_value not in _STATUS_SELECT_TO_STATE:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail=f"Invalid status: {new_value}",
                    )
                if new_value == "assembly" and await get_components_ready_at(db, order.id) is not None:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail="Bu siparişin alt ürünleri olduğu için 'Dizgi' ayrı bir adım değildir — Tedarik tamamlanınca otomatik atlanır.",
                    )
                checked_count, new_status = _STATUS_SELECT_TO_STATE[new_value]
                now_iso = datetime.now(timezone.utc).isoformat()
                _set_split_manual_steps(
                    split,
                    _manual_steps_for_checked_count(
                        _get_split_manual_steps(split), checked_count, str(current_user.id), current_user.username, now_iso
                    ),
                )
                # Split'in kendi status kolonu da açıkça yazılır (yalnızca manuel adımlara
                # değil) — aksi halde "Tedarik" (0 işaretli adım) "Beklemede" ile ayırt
                # edilemez, bkz. _derived_split_status.
                split.status = new_status
                # Siparişin kendi durumu, tüm aktif split'lerinin bağımsız ilerlemesinin
                # roll-up'ıdır (gantt.py'nin update_manual_step_state'iyle aynı kural).
                active_splits = [s for s in order.delivery_splits if not s.is_deleted]
                split_statuses = [_derived_split_status(s) for s in active_splits]
                order.status = _status_from_split_statuses(split_statuses)

            elif field_key == "on_hand_reduction":
                # "Elde mevcut X adet var" — CreateDeliveryModal'daki sipariş-oluşturma-anı
                # aynı özelliğin, var olan bir bileşen (component) split'i için karşılığı.
                # ABSOLUTE/üzerine-yazma semantiği: girilen değer HER ZAMAN o anki toplam
                # elde mevcut stok miktarını temsil eder (kümülatif/delta DEĞİL). Teslimat
                # Adedi (split.quantity — nominal ihtiyaç) ASLA değiştirilmez; efektif
                # miktar HER ÇAĞRIDA split.quantity - on_hand olarak baştan hesaplanır —
                # bu yüzden ardışık girişler (ör. 5, sonra 1) birbirini yanlışlıkla
                # bileştirmez. old_value burada override edilir — genel
                # `getattr(split, field_key)` "on_hand_reduction" adında bir öznitelik
                # bulamaz (gerçek bir kolon değil).
                if order.parent_order_id is None:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail="Elde mevcut düşümü yalnızca alt ürün (bileşen) parçaları için uygulanabilir.",
                    )
                try:
                    on_hand = max(0.0, float(new_value or 0))
                except (ValueError, TypeError):
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail=f"Geçersiz sayı: {new_value}",
                    )
                if on_hand >= split.quantity:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail=f"Elde mevcut miktar, toplam miktardan ({split.quantity:.0f}) küçük olmalı.",
                    )
                old_value = split.on_hand_quantity or 0.0
                if on_hand_holidays is None:
                    on_hand_holidays = await _load_order_detail_holidays(db)
                    on_hand_work_minutes = (await _load_order_detail_work_hours(db)) * 60
                default_comp_emp = {"assembly": 1.0, "production": 1.0, "test": 1.0}
                await _apply_component_on_hand(
                    db, split, on_hand, on_hand_holidays, on_hand_work_minutes, default_comp_emp,
                )
                component_on_hand_touched_splits.add(upd.split_id)

        else:
            # base_data field
            base = dict(order.base_data or {})
            old_value = base.get(field_key)

            if field_key in NUMERIC_BASE_DATA_KEYS:
                # Zamanlama parametreleri eski değerin tipinden bağımsız her zaman
                # sayı olarak saklanır (anahtar hiç yoksa da) — string kalırsa
                # süre hesapları bozuluyor.
                try:
                    base[field_key] = _parse_number_value(new_value)
                except ValueError:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail=f"Invalid number for {field_key}: {new_value}",
                    )
                if field_key == "assembly_days":
                    # Split-override dalındaki (satır ~824) aynı düzeltme: "production_days"
                    # (RightPanel'in eski "Dizgi" alanı) date_utils.py'de
                    # `assembly_d = params.get("production_days") or params.get("assembly_days")`
                    # ile assembly_days'i GÖLGELER — sipariş genelinde eski bir production_days
                    # değeri varsa, buradan girilen assembly_days sessizce göz ardı edilirdi.
                    base["production_days"] = None
                if base[field_key] != old_value:
                    for s in order.delivery_splits:
                        if not s.is_deleted:
                            sid = str(s.id)
                            splits.setdefault(sid, s)
                            splits_needing_start_recalc.add(sid)
                            # Sipariş genelindeki bir üretim parametresi değişince tüm
                            # split'lerin (varsa) onaylı özel takvimi artık geçersiz
                            # kalan eski sürelere göre hesaplanmıştır — temizlenir
                            # (bkz. split_id'li param_overrides dalındaki aynı gerekçe).
                            if s.stage_schedule:
                                s.stage_schedule = None
            elif field_key == DURATION_MODE_KEY:
                base[field_key] = str(new_value) if new_value not in (None, "") else None
                if base[field_key] != old_value:
                    for s in order.delivery_splits:
                        if not s.is_deleted:
                            sid = str(s.id)
                            splits.setdefault(sid, s)
                            splits_needing_start_recalc.add(sid)
                            if s.stage_schedule:
                                s.stage_schedule = None
            elif isinstance(old_value, bool):
                base[field_key] = _parse_bool_value(new_value)
            elif isinstance(old_value, (int, float)):
                try:
                    base[field_key] = _parse_number_value(new_value)
                except ValueError:
                    base[field_key] = new_value
            else:
                base[field_key] = new_value

            order.base_data = base

        audit_logs.append(
            AuditLog(
                entity_type="order",
                entity_id=order.id,
                action=AuditAction.UPDATE.value,
                old_value={field_key: _json_safe(old_value)},
                new_value={field_key: _json_safe(new_value)},
                performed_by=current_user.id,
            )
        )
        updated_count += 1

    # Recalculate start_date for splits whose end_date or quantity changed
    if splits_needing_start_recalc:
        holidays = await _load_order_detail_holidays(db)
        work_hours_per_day = await _load_order_detail_work_hours(db)
        work_minutes = work_hours_per_day * 60
        emp_map = await _load_order_detail_employee_map(db)
        # BOM: ana siparişin (parent_order_id yok) kendi bileşenleri varsa Dizgi
        # atlanır ve start_date buna göre hesaplanmalı — get_gantt_tasks/
        # _suggested_stage_schedule ile aynı kural (bkz. calculate_split_start_date
        # docstring'i). Aynı ana sipariş için birden fazla split değişmiş olabilir,
        # bu yüzden component_ready_at sipariş başına bir kez sorgulanıp önbelleğe alınır.
        component_ready_at_cache: dict[str, datetime | None] = {}
        components_start_at_cache: dict[str, datetime | None] = {}
        for sid in splits_needing_start_recalc:
            split = splits.get(sid)
            if not split or split.end_date is None:
                continue
            order_for_split = orders.get(str(split.order_id))
            if not order_for_split:
                continue
            product_params = effective_product_params(order_for_split.base_data, split.param_overrides)
            oid = str(split.order_id)
            split_emp = emp_map.get(sid, emp_map.get(oid, {"assembly": 1.0, "production": 1.0, "test": 1.0}))
            split_is_fason = _split_is_outsourced(order_for_split, split)
            if oid not in component_ready_at_cache:
                component_ready_at_cache[oid] = (
                    await get_components_ready_at(db, order_for_split.id)
                    if order_for_split.parent_order_id is None
                    else None
                )
                # Tedarik'in bilesenlerle paralel cizilebilmesi icin start_date'in
                # de bilesenlere bakmasi gerekiyor (bkz. calculate_split_start_date).
                components_start_at_cache[oid] = (
                    await get_components_start_at(db, order_for_split.id)
                    if order_for_split.parent_order_id is None
                    else None
                )
            split_include_delivery = order_for_split.component_product_id is None
            new_start = calculate_split_start_date(
                end_date=split.end_date,
                quantity=effective_split_quantity(split),
                product_params=product_params,
                emp=split_emp,
                work_minutes=work_minutes,
                holidays=holidays,
                is_outsourced=split_is_fason,
                component_ready_at=component_ready_at_cache[oid],
                include_delivery=split_include_delivery,
                components_start_at=components_start_at_cache[oid],
            )
            if new_start != split.start_date:
                split.start_date = new_start

            # Bileşenler bu split'in naif hesaplanan üretim başlangıcından DAHA GEÇ
            # hazır oluyorsa, kullanıcının girdiği end_date fiziksel olarak
            # ulaşılamaz olabilir (bkz. gantt.py'deki split-multi endpoint'lerindeki
            # aynı düzeltme/yorum — _gate_new_main_segments_against_component_readiness).
            # component_ready_at burada da doluysa, start_date sabitlenmiş haliyle
            # blokları yeniden hesaplayıp gerçek (kaydırılmış) bitişi end_date'e
            # yansıtırız; aksi halde Gantt'ın canlı görünümü ile DB'deki end_date
            # sessizce birbirinden habersiz kalır.
            if component_ready_at_cache[oid] is not None:
                gated_blocks = calculate_split_stage_ranges(
                    end_date=split.end_date,
                    quantity=effective_split_quantity(split),
                    product_params=product_params,
                    emp=split_emp,
                    work_minutes=work_minutes,
                    holidays=holidays,
                    is_outsourced=split_is_fason,
                    component_ready_at=component_ready_at_cache[oid],
                    include_delivery=split_include_delivery,
                    start_date=split.start_date,
                )
                if gated_blocks:
                    true_end = max(b["end"] for b in gated_blocks)
                    if true_end != split.end_date:
                        warnings.append(
                            f"{split.quantity:.0f} adetlik parça için girilen bitiş tarihi "
                            f"({split.end_date.date()}) bileşenlerin hazır olma tarihiyle "
                            f"uyumsuz olduğundan {true_end.date()} tarihine uzatıldı."
                        )
                        split.end_date = true_end

    # BOM: değişen split'lerden biri bir alt ürüne (bileşene) aitse, ana siparişin
    # Tedarik/Üretim'i bu bileşenin GÜNCEL en geç bitişine göre yeniden hesaplanıp
    # kaydedilir. Aynı ana siparişe birden fazla bileşen parçası değişmiş olabilir —
    # her ana sipariş yalnızca BİR KEZ yeniden hesaplanır.
    bom_main_orders_to_recompute: set[UUID] = set()
    for sid in splits_needing_start_recalc | component_on_hand_touched_splits:
        split = splits.get(sid)
        if not split:
            continue
        order_for_split = orders.get(str(split.order_id))
        if order_for_split and order_for_split.parent_order_id is not None:
            bom_main_orders_to_recompute.add(order_for_split.parent_order_id)
    if bom_main_orders_to_recompute:
        await db.flush()
        for main_order_id in bom_main_orders_to_recompute:
            await _recompute_and_persist_bom_main_order(db, main_order_id, current_user.id)

    # BOM: bir ANA siparişin split'inin miktarı split olmadan (doğrudan hücre
    # düzenleme ile) değiştiyse, bağlı bileşen (component) split'lerinin miktarı
    # da AYNI ORANDA güncellenir — aksi halde bileşen üretimi eski miktarda
    # "yetim" kalırdı (bkz. source_main_split_id, gantt.py split akışlarındaki
    # aynı desen — _sync_component_orders_for_main_split_replace).
    if quantity_changes:
        sync_holidays = await _load_order_detail_holidays(db)
        sync_work_hours = await _load_order_detail_work_hours(db)
        sync_work_minutes = sync_work_hours * 60
        default_comp_emp = {"assembly": 1.0, "production": 1.0, "test": 1.0}
        # Bilesenleri yeniden olceklenen ANA siparisler — olcekleme bittikten SONRA
        # bir kez yeniden hesaplanirlar (bkz. asagidaki dongu).
        rescaled_main_order_ids: set[UUID] = set()
        for sid, (old_qty, new_qty) in quantity_changes.items():
            main_split = splits.get(sid)
            if not main_split or not old_qty:
                continue
            order_for_split = orders.get(str(main_split.order_id))
            if not order_for_split or order_for_split.parent_order_id is not None:
                continue  # yalnızca ANA siparişin split'i — bileşenin kendi miktarı DEĞİL
            ratio = new_qty / old_qty
            linked_result = await db.execute(
                select(DeliverySplit).where(
                    DeliverySplit.source_main_split_id == main_split.id,
                    DeliverySplit.is_deleted == False,  # noqa: E712
                )
            )
            rescaled_any = False
            for comp_split in linked_result.scalars().all():
                new_comp_qty = round(comp_split.quantity * ratio, 2)
                await _rescale_component_split(
                    db, comp_split, new_comp_qty, sync_holidays, sync_work_minutes, default_comp_emp,
                )
                rescaled_any = True
            if rescaled_any:
                rescaled_main_order_ids.add(order_for_split.id)

        # ANA siparisin adedi degisince bilesenlerin suresi de degisir — yani ana
        # urunun Uretim'i artik baska bir gunde baslayabilir hale gelir. Yukaridaki
        # (bu bloktan ONCE calisan) BOM yeniden hesabi bu durumu YAKALAMAZ:
        #   1) orada yalnizca `parent_order_id is not None` olan, yani BILESEN
        #      siparislerine ait split'ler taraniyor — ana siparisin kendi split'i
        #      hicbir zaman eslesmiyordu;
        #   2) ayrica o blok bu olceklemeden ONCE calisiyor, yani bilesenlerin yeni
        #      tarihleri henuz yazilmamis oluyordu.
        # Sonuc: ana siparisin adedi dusurulunce bilesenler kisaliyor ama Tedarik
        # ile Uretim arasinda bos bir aralik kaliyordu (sistem onerisi guncellenmiyordu).
        if rescaled_main_order_ids:
            await db.flush()
            for main_order_id in rescaled_main_order_ids:
                await _recompute_and_persist_bom_main_order(db, main_order_id, current_user.id)

    for al in audit_logs:
        db.add(al)
    await db.commit()

    await sse_manager.publish("TASK_UPDATED", {
        "updated_by": current_user.username,
        "action": "bulk_cell_update",
        "update_count": updated_count,
    })

    return {"updated": updated_count, "warnings": warnings}


@router.delete(
    "/orders/{order_id}",
    summary="Delete an order and all of its delivery splits (preview modal's 'Siparişi Sil' button)",
)
async def delete_order(
    order_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> dict:
    try:
        order_uuid = UUID(order_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid order id")

    result = await db.execute(
        select(Order)
        .where(Order.id == order_uuid, Order.is_deleted == False)  # noqa: E712
        .options(selectinload(Order.delivery_splits))
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found")

    deleted_at = datetime.now(timezone.utc)
    active_splits = [s for s in order.delivery_splits if not s.is_deleted]
    for split in active_splits:
        split.is_deleted = True
        split.deleted_at = deleted_at

    order.is_deleted = True
    order.deleted_at = deleted_at

    # BOM: bu siparişin (varsa) alt ürün bileşenleri de silinmeli — aksi halde
    # ana sipariş silindikten sonra bileşenler is_deleted=False kalıp Gantt/adım
    # takviminde "yetim" olarak görünmeye devam eder (FK ondelete=CASCADE yalnızca
    # gerçek DELETE'te tetiklenir, soft-delete'te değil).
    deleted_component_count = await cascade_soft_delete_components(db, order.id, deleted_at)

    db.add(
        AuditLog(
            entity_type="order",
            entity_id=order.id,
            action=AuditAction.DELETE.value,
            old_value={"is_deleted": False},
            new_value={
                "is_deleted": True,
                "deleted_split_count": len(active_splits),
                "deleted_component_count": deleted_component_count,
            },
            performed_by=current_user.id,
        )
    )

    await db.commit()

    await sse_manager.publish("TASK_DELETED", {
        "order_id": order_id,
        "deleted_by": current_user.username,
    })

    return {
        "message": "Order deleted",
        "order_id": order_id,
        "deleted_split_count": len(active_splits),
        "deleted_component_count": deleted_component_count,
    }
