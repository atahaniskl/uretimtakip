"""
Gantt API — SVAR React Gantt bridge.
SVAR Gantt Implementation, Drag-and-Drop Sync, Manual Split logic.

Endpoints:
  GET  /api/gantt/tasks          — Fetch all tasks in SVAR format
  PATCH /api/gantt/tasks/{id}    — Update task dates (drag-and-drop)
  POST /api/gantt/tasks/{id}/split — Split a delivery into two
"""

import math
from typing import Literal
from uuid import UUID
from datetime import datetime, timezone, timedelta, date

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy import text
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.config import settings
from app.models.user import User
from app.models.order import Order
from app.models.order_serial_number import OrderSerialNumber
from app.models.delivery_split import DeliverySplit
from app.models.delivery_note import DeliveryNote
from app.models.audit_log import AuditLog
from app.models.official_holiday import OfficialHoliday
from app.models.step_employee_assignment import StepEmployeeAssignment
from app.models.enums import AuditAction
from app.api.deps import get_current_user, require_role
from app.models.user import UserRole
from app.models.mapping_template import MappingTemplate
from app.core.date_utils import (
    is_workday as _is_workday,
    add_workdays as _add_workdays,
    subtract_workdays as _subtract_workdays,
    calculate_split_start_date,
    calculate_split_stage_ranges,
    calculate_component_end_date,
    effective_product_params,
    effective_split_quantity,
    build_product_params,
    is_outsourced_from_base_data,
    BLOCK_KEYS,
)
from app.models.enums import OrderStatus
from app.models.product_info import ProductInfo
from app.models.product_sub_product import ProductSubProduct
from app.services.sse_service import sse_manager
from app.services.excel_service import excel_service
from app.services.completion_metrics import calculate_completion_metrics
from app.services.bom_scheduling import (
    get_components_ready_at,
    get_components_start_at,
    get_components_ready_at_map,
    get_component_ready_at_for_split,
    get_components_ready_at_by_split_map,
    cascade_soft_delete_components,
    cascade_restore_components,
    cascade_soft_delete_linked_component_splits,
    cascade_restore_linked_component_splits,
)

router = APIRouter(prefix="/gantt", tags=["Gantt"])

MANUAL_STEP_KEYS = ("supply", "assembly", "production", "test", "delivery")


# --- Schemas ---

class GanttTaskOut(BaseModel):
    """SVAR Gantt task format."""
    id: str
    text: str
    start_date: str
    end_date: str | None = None
    duration: int
    parent: str | None = None
    type: str  # "project" (order) or "task" (delivery_split)
    progress: float = 0
    status: str | None = None
    external_id: str | None = None
    manual_edit: bool | None = None
    quantity: float | None = None
    on_hand_quantity: float | None = None
    created_by_username: str | None = None
    last_interacted_by_username: str | None = None
    is_outsourced: bool | None = None
    # --- Yeni: ürün parametreleri ---
    supply_days: float | None = None       # Tedarik süresi (iş günü)
    production_days: float | None = None   # Üretim/assembly süresi (iş günü)
    # --- Yeni: her aşama için ayrı süre bilgisi ---
    assembly_days: float | None = None
    outsource_days: float | None = None    # Fason (dış dizgi) süresi (iş günü, düz)
    epoxy_minutes: float | None = None
    conformal_minutes: float | None = None
    montaj_minutes: float | None = None
    quality_minutes: float | None = None
    montaj_kalite_minutes: float | None = None
    test1_minutes: float | None = None
    test2_minutes: float | None = None
    final_test_minutes: float | None = None
    delivery_days: float | None = None
    # --- Adet/Gün modu: "flat" ise dizgi+üretim+test süreleri düz TOPLAM gün olarak
    # yorumlanır (adetle çarpılmaz); üretim/test için tek alanlar kullanılır ---
    duration_mode: str | None = None
    production_flat_days: float | None = None
    test_flat_days: float | None = None
    assembly_flat_days: float | None = None
    # --- Eğer görev bir aşamaysa bu alanda aşama adı bulunur ---
    stage: str | None = None
    # --- Yeni: sipariş bilgileri (base_data alanları) ---
    customer_name: str | None = None
    responsible_personnel: str | None = None
    order_date: str | None = None
    promised_date: str | None = None
    requirement_date: str | None = None
    penalty_date: str | None = None
    # --- Yeni: ağırlıklı tamamlanma yüzde ve aşama sayıları ---
    completion_percentage: float = Field(default=0.0, description="0-100 weighted completion %")
    stage_counts: dict[str, int] = Field(default_factory=dict, description="Count of serial numbers by stage")
    is_explicit_split: bool = Field(default=False, description="True if order was explicitly split")
    # --- Teslimat tarihi (tüm aynı teslimatın taskleri aynı değeri alır, renk gruplaması için) ---
    delivery_date: str | None = None
    # --- Çalışan atama bilgileri ---
    assembly_employees: float = 1.0
    production_employees: float = 1.0
    test_employees: float = 1.0
    work_hours_per_day: float = 8.0



class GanttTasksResponse(BaseModel):
    tasks: list[GanttTaskOut]
    total: int


class GanttUpdateRequest(BaseModel):
    """Payload for drag-and-drop update."""
    start_date: str
    end_date: str
    quantity: float | None = None


class SplitRequest(BaseModel):
    """Payload for split action."""
    ratio: float = 0.5  # Default 50/50 split


class MultiSplitSegment(BaseModel):
    quantity: float
    start_date: str | None = None
    end_date: str
    is_outsourced: bool = False
    # Fason (dış dizgi) süresi (gün) — outsource_days şu an order.base_data'da
    # SİPARİŞ GENELİNDE tutulan tek bir değer (bkz. _block_days, date_utils.py);
    # segment bazında farklı bir değer YOKSA bu segment fason işaretlenirken
    # order.base_data["outsource_days"] hiç set edilmediği için "Dizgi" bloğu
    # zaman çizelgesinden sessizce düşüyordu (days=None -> blok atlanıyor). Bu
    # alan, formdan gelen değeri o paylaşılan alana yazabilmek için eklendi.
    outsource_days: float | None = None


class MultiSplitRequest(BaseModel):
    segments: list[MultiSplitSegment]


class OrderFieldsUpdateRequest(BaseModel):
    """Payload for updating order base_data fields."""
    customer_name: str | None = None
    responsible_personnel: str | None = None
    order_date: str | None = None
    promised_date: str | None = None
    requirement_date: str | None = None
    penalty_date: str | None = None


class ProductParamsUpdateRequest(BaseModel):
    """Payload for updating per-order product parameter overrides (stage durations)."""
    supply_days: float | None = Field(default=None, ge=0)
    production_days: float | None = Field(default=None, ge=0)
    outsource_days: float | None = Field(default=None, ge=0)
    is_outsourced: bool | None = None
    quality_minutes: float | None = Field(default=None, ge=0)
    epoxy_minutes: float | None = Field(default=None, ge=0)
    conformal_minutes: float | None = Field(default=None, ge=0)
    montaj_minutes: float | None = Field(default=None, ge=0)
    montaj_kalite_minutes: float | None = Field(default=None, ge=0)
    test1_minutes: float | None = Field(default=None, ge=0)
    test2_minutes: float | None = Field(default=None, ge=0)
    final_test_minutes: float | None = Field(default=None, ge=0)
    delivery_days: float | None = Field(default=None, ge=0)


class DeliveryNoteCreate(BaseModel):
    content: str


class DeliveryNoteUpdate(BaseModel):
    content: str


class DeliveryNoteOut(BaseModel):
    id: str
    order_id: str
    content: str
    created_by: str
    created_by_username: str | None = None
    created_at: str


class GanttManualCreateRequest(BaseModel):
    """Payload for manual delivery creation."""
    text: str = Field(min_length=1, description="Ürün adı / Açıklama")
    external_id: str | None = None  # Sipariş No
    quantity: float = Field(gt=0, description="Sipariş adedi (0'dan büyük olmalı)")
    start_date: str = Field(description="ISO 8601 başlangıç tarihi (YYYY-MM-DDTHH:MM:SSZ)")
    end_date: str = Field(description="ISO 8601 bitiş tarihi (YYYY-MM-DDTHH:MM:SSZ)")
    customer_name: str | None = None
    responsible_personnel: str | None = None
    order_date: str | None = None
    promised_date: str | None = None
    requirement_date: str | None = None
    penalty_date: str | None = None
    is_outsourced: bool | None = None
    supply_days: int | None = Field(default=None, ge=0)
    production_days: int | None = Field(default=None, ge=0)
    assembly_days: int | None = Field(default=None, ge=0)
    outsource_days: float | None = Field(default=None, ge=0)
    epoxy_minutes: float | None = Field(default=None, ge=0)
    conformal_minutes: float | None = Field(default=None, ge=0)
    montaj_minutes: float | None = Field(default=None, ge=0)
    quality_minutes: float | None = Field(default=None, ge=0)
    montaj_kalite_minutes: float | None = Field(default=None, ge=0)
    test1_minutes: float | None = Field(default=None, ge=0)
    test2_minutes: float | None = Field(default=None, ge=0)
    final_test_minutes: float | None = Field(default=None, ge=0)
    delivery_days: int | None = Field(default=None, ge=0)
    duration_mode: Literal["per_unit", "flat"] | None = Field(default=None)
    production_flat_days: float | None = Field(default=None, ge=0)
    test_flat_days: float | None = Field(default=None, ge=0)
    assembly_flat_days: float | None = Field(default=None, ge=0)
    sub_product_on_hand: dict[str, float] | None = Field(
        default=None,
        description="BOM alt ürünü ProductInfo.id -> elde zaten mevcut olan miktar. "
        "Belirtilen alt ürün için üretilecek miktardan düşülür.",
    )

    @model_validator(mode='after')
    def validate_dates_and_quantity(self):
        if self.start_date and self.end_date:
            try:
                start = datetime.fromisoformat(self.start_date.replace("Z", "+00:00"))
                end = datetime.fromisoformat(self.end_date.replace("Z", "+00:00"))
            except ValueError as e:
                raise ValueError(f"Geçersiz tarih formatı: {e}")
            if end <= start:
                raise ValueError("Bitiş tarihi, başlangıç tarihinden sonra olmalıdır.")
        if self.quantity is not None and self.quantity <= 0:
            raise ValueError("Sipariş adedi 0'dan büyük olmalıdır.")
        return self


class ManualStepMetaOut(BaseModel):
    checked: bool = False
    checked_by: str | None = None
    checked_by_username: str | None = None
    checked_at: str | None = None


class ManualStepStateOut(BaseModel):
    order_id: str
    split_id: str | None = None
    order_status: str
    steps: dict[str, ManualStepMetaOut]
    completed_count: int
    total_count: int


class ManualStepUpdateRequest(BaseModel):
    steps: dict[str, dict[str, str | bool | None]]


# --- Helpers ---

def _calc_duration(start: datetime, end: datetime, holiday_days: set[date]) -> int:
    """Calculate business-day duration in [start, end) with min 1."""
    cursor = start.date()
    end_day = end.date()
    days = 0
    while cursor < end_day:
        if _is_workday(cursor, holiday_days):
            days += 1
        cursor = cursor + timedelta(days=1)
    return max(1, days)


async def _get_holiday_days(db: AsyncSession) -> set[date]:
    result = await db.execute(
        select(OfficialHoliday.holiday_date).where(OfficialHoliday.is_active == True)  # noqa: E712
    )
    return set(result.scalars().all())


async def _get_work_hours_per_day(db: AsyncSession) -> float:
    """Read work_hours_per_day from AppSetting, fallback to 8."""
    from app.models.app_setting import AppSetting
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


async def _get_step_employee_map(db: AsyncSession) -> dict[str, dict[str, float]]:
    """Return {order_id|split_id: {step_key: employee_count}} defaulting to 1.

    Entries keyed by split_id are per-split overrides.
    Entries keyed by order_id are order-level defaults.
    """
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
    # Fill defaults for orders with no order-level row
    all_orders = await db.execute(select(Order).where(Order.is_deleted == False))
    for o in all_orders.scalars().all():
        oid = str(o.id)
        if oid not in order_ids_with_rows and oid not in emp_map:
            emp_map[oid] = {"assembly": 1.0, "production": 1.0, "test": 1.0}
    return emp_map


def _build_task_text(order: Order) -> str:
    """Build a display name from order base_data or external_id."""
    base = order.base_data or {}
    # Try common field names for display
    for key in ("product_name", "name", "description", "ürün", "urun", "siparis_no", "product_code", "proje"):
        if key in base and base[key]:
            return str(base[key])
    return f"Sipariş #{order.external_id[:8]}"


def _build_order_fields(order: Order) -> dict:
    """Expose order-level columns to the Gantt UI."""
    return {
        "customer_name": order.customer_name,
        "responsible_personnel": order.responsible_personnel,
        "order_date": order.order_date.isoformat() if order.order_date else None,
        "promised_date": order.promised_date.isoformat() if order.promised_date else None,
        "requirement_date": order.requirement_date.isoformat() if order.requirement_date else None,
        "penalty_date": order.penalty_date.isoformat() if order.penalty_date else None,
    }


def _build_product_params(order: Order) -> dict:
    """Order-typed thin wrapper around the shared `build_product_params`
    (date_utils.py) — order_details.py reuses the same function directly
    (with `.base_data`) so both agree on the same field-alias normalization."""
    return build_product_params(order.base_data)


def _build_outsourcing_flag(order: Order) -> bool | None:
    """Extract whether order is outsourced from flexible Excel/base_data aliases —
    thin wrapper around the shared `is_outsourced_from_base_data` (date_utils.py) so
    this view, order_details.py, and app_settings.py all agree on the same order.
    Returns True/False/None (unknown/not provided)."""
    return is_outsourced_from_base_data(order.base_data)


def _set_auto_delivery_suppressed(order: Order, suppressed: bool) -> None:
    """Persist whether fallback split_fake delivery should be hidden for this order."""
    base = dict(order.base_data or {})
    base["_auto_delivery_suppressed"] = suppressed
    order.base_data = base


def _normalize_manual_steps(raw_steps: dict | None) -> dict[str, dict[str, str | bool | None]]:
    raw_steps = raw_steps or {}
    normalized: dict[str, dict[str, str | bool | None]] = {}
    for key in MANUAL_STEP_KEYS:
        raw_value = raw_steps.get(key, False)
        if isinstance(raw_value, dict):
            checked = bool(raw_value.get("checked", False))
            normalized[key] = {
                "checked": checked,
                "checked_by": raw_value.get("checked_by"),
                "checked_by_username": raw_value.get("checked_by_username"),
                "checked_at": raw_value.get("checked_at"),
            }
        else:
            normalized[key] = {
                "checked": bool(raw_value),
                "checked_by": None,
                "checked_by_username": None,
                "checked_at": None,
            }
    return normalized


def _get_manual_steps(order: Order) -> dict[str, dict[str, str | bool | None]]:
    base = order.base_data or {}
    return _normalize_manual_steps(base.get("_manual_steps"))


def _set_manual_steps(order: Order, steps: dict[str, dict[str, str | bool | None]]) -> None:
    base = dict(order.base_data or {})
    base["_manual_steps"] = _normalize_manual_steps(steps)
    order.base_data = base


def _get_split_manual_steps(split: DeliverySplit) -> dict[str, dict[str, str | bool | None]]:
    return _normalize_manual_steps(split.manual_steps)


def _set_split_manual_steps(split: DeliverySplit, steps: dict[str, dict[str, str | bool | None]]) -> None:
    split.manual_steps = _normalize_manual_steps(steps)


def _manual_step_state_out(order: Order, split: DeliverySplit | None = None) -> ManualStepStateOut:
    steps = _get_split_manual_steps(split) if split is not None else _get_manual_steps(order)
    completed_count = sum(1 for value in steps.values() if bool(value.get("checked")))
    step_out = {
        key: ManualStepMetaOut(
            checked=bool(value.get("checked")),
            checked_by=str(value.get("checked_by")) if value.get("checked_by") else None,
            checked_by_username=str(value.get("checked_by_username")) if value.get("checked_by_username") else None,
            checked_at=str(value.get("checked_at")) if value.get("checked_at") else None,
        )
        for key, value in steps.items()
    }
    return ManualStepStateOut(
        order_id=str(order.id),
        split_id=str(split.id) if split is not None else None,
        order_status=order.status,
        steps=step_out,
        completed_count=completed_count,
        total_count=len(MANUAL_STEP_KEYS),
    )


def _status_from_manual_steps(steps: dict[str, dict[str, str | bool | None]]) -> str:
    checked_values = [bool(steps[key].get("checked")) for key in MANUAL_STEP_KEYS]
    if checked_values and all(checked_values):
        return OrderStatus.COMPLETED.value
    if any(checked_values):
        return OrderStatus.APPROVED.value
    return OrderStatus.PENDING.value


def _status_from_split_statuses(statuses: list[str]) -> str:
    """Roll up an order's own status from the independent status of each of its splits."""
    if statuses and all(s == OrderStatus.COMPLETED.value for s in statuses):
        return OrderStatus.COMPLETED.value
    if any(s in (OrderStatus.APPROVED.value, OrderStatus.COMPLETED.value) for s in statuses):
        return OrderStatus.APPROVED.value
    return OrderStatus.PENDING.value


def _blended_status(persisted_status: str, manual_status: str) -> str:
    """Combine a persisted status column with the status derived from manual-step
    checkboxes — whichever signal reached the more advanced stage wins, so a status
    set directly (e.g. "Tedarik" — 0 checked steps, but explicitly APPROVED) isn't
    masked by, or silently overwritten by, the manual-steps-only computation."""
    if OrderStatus.COMPLETED.value in (persisted_status, manual_status):
        return OrderStatus.COMPLETED.value
    if OrderStatus.APPROVED.value in (persisted_status, manual_status):
        return OrderStatus.APPROVED.value
    return persisted_status


def _can_manage_note(current_user: User, note: DeliveryNote) -> bool:
    return current_user.role in (UserRole.ADMIN, UserRole.PLANNER) or note.created_by == current_user.id


async def _resolve_order_for_task(db: AsyncSession, task_id: str) -> Order:
    """Resolve a Gantt task ID to the related order."""
    async def _get_order(order_uuid: UUID) -> Order | None:
        order_result = await db.execute(
            select(Order)
            .where(
                Order.id == order_uuid,
                Order.is_deleted == False,  # noqa: E712
            )
            .options(selectinload(Order.serial_numbers), selectinload(Order.delivery_splits))
        )
        return order_result.scalar_one_or_none()

    def _parse_uuid(value: str) -> UUID | None:
        try:
            return UUID(value)
        except ValueError:
            return None

    # Support raw UUIDs, order_<uuid>, split_<uuid>, split_<uuid>_<stage>, and split_fake_<uuid>
    candidate_ids: list[str] = []
    if task_id.startswith("order_"):
        candidate_ids.append(task_id.removeprefix("order_"))
    elif task_id.startswith("split_fake_"):
        candidate_ids.append(task_id.removeprefix("split_fake_"))
    elif task_id.startswith("split_"):
        remainder = task_id.removeprefix("split_")
        candidate_ids.append(remainder.split("_")[0])
    else:
        candidate_ids.append(task_id)

    for candidate in candidate_ids:
        order_uuid = _parse_uuid(candidate)
        if order_uuid is not None:
            order = await _get_order(order_uuid)
            if order:
                return order

            split_result = await db.execute(
                select(DeliverySplit).where(
                    DeliverySplit.id == order_uuid,
                    DeliverySplit.is_deleted == False,  # noqa: E712
                )
            )
            split = split_result.scalar_one_or_none()
            if split:
                split_order = await _get_order(split.order_id)
                if split_order:
                    return split_order

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Order not found",
    )


async def _resolve_task_target(db: AsyncSession, task_id: str) -> tuple[Order, DeliverySplit | None]:
    """Resolve a Gantt task ID to (order, split). ``split`` is only populated when the
    task genuinely represents a single DeliverySplit (not an order_/split_fake_/bare-order
    id), so manual-step tracking can be scoped per delivery instead of per order."""

    def _parse_uuid(value: str) -> UUID | None:
        try:
            return UUID(value)
        except ValueError:
            return None

    if task_id.startswith("split_") and not task_id.startswith("split_fake_"):
        remainder = task_id.removeprefix("split_")
        candidate = remainder.split("_")[0]
        split_uuid = _parse_uuid(candidate)
        if split_uuid is not None:
            split_result = await db.execute(
                select(DeliverySplit).where(
                    DeliverySplit.id == split_uuid,
                    DeliverySplit.is_deleted == False,  # noqa: E712
                )
            )
            split = split_result.scalar_one_or_none()
            if split is not None:
                order_result = await db.execute(
                    select(Order)
                    .where(Order.id == split.order_id, Order.is_deleted == False)  # noqa: E712
                    .options(selectinload(Order.serial_numbers), selectinload(Order.delivery_splits))
                )
                order = order_result.scalar_one_or_none()
                if order is not None:
                    return order, split

    order = await _resolve_order_for_task(db, task_id)
    return order, None


# --- Endpoints ---

@router.get(
    "/tasks",
    response_model=GanttTasksResponse,
    summary="Get all tasks in SVAR Gantt format",
)
async def get_gantt_tasks(
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> GanttTasksResponse:
    """
    Fetch Orders (as project/parent rows) and their Delivery_Splits (as child tasks)
    formatted for SVAR React Gantt: {id, text, start_date, duration, parent, type}.
    """
    holiday_days = await _get_holiday_days(db)

    # Fetch orders with their delivery splits. BOM bileşen siparişleri (parent_order_id
    # dolu olanlar) üst seviye "project" satırı olarak ÜRETİLMEZ — kendi nested
    # görevleri döngü sonunda ayrı bir geçişte, ana siparişlerinin altına eklenir.
    result = await db.execute(
        select(Order)
        .where(Order.is_deleted == False, Order.parent_order_id.is_(None))  # noqa: E712
        .options(selectinload(Order.delivery_splits), selectinload(Order.serial_numbers))
        .order_by(Order.created_at)
    )
    orders = result.scalars().unique().all()

    split_ids: list[UUID] = []
    user_ids: set[UUID] = set()
    order_ids: list[UUID] = []
    for order in orders:
        order_ids.append(order.id)
        user_ids.add(order.created_by)
        for ds in order.delivery_splits:
            split_ids.append(ds.id)
            user_ids.add(ds.created_by)

    # BOM: her siparisin (varsa) bilesenlerinin en gec bitis tarihi — asagidaki
    # asama-gorevi uretiminde Dizgi'nin dusurulmesi ve Uretim/Test/Teslimat'in
    # (gerekirse) ileri kaydirilmasi icin. Tek sorguda topluca cekilir (N+1 onlenir).
    components_ready_at_map = await get_components_ready_at_map(db, order_ids)
    # Parça-bazlı hali: bir ana split N parçaya bölünmüşse (source_main_split_id),
    # her parça yalnızca KENDİSİNE bağlı bileşen parçalarının bitişine göre
    # gate'lenir — bkz. component_ready_at kullanım yeri aşağıda (fallback: order-geneli map).
    components_ready_at_by_split_map = await get_components_ready_at_by_split_map(db, split_ids)

    # BOM: bir ana siparişin tamamlanma yüzdesi/aşama sayıları yalnızca KENDİ seri
    # numaralarına değil, aktif bileşenlerinin (varsa) seri numaralarına da bakmalı —
    # aksi halde bileşenler henüz üretimdeyken bile ana sipariş "%100 tamamlandı"
    # gösterebilir (bkz. order_completion_email.py'deki aynı kural). Tek sorguda
    # topluca çekilir (N+1 önlenir).
    component_serials_by_parent: dict[UUID, list[OrderSerialNumber]] = {}
    if order_ids:
        component_serials_result = await db.execute(
            select(Order.parent_order_id, OrderSerialNumber)
            .join(OrderSerialNumber, OrderSerialNumber.order_id == Order.id)
            .where(Order.parent_order_id.in_(order_ids), Order.is_deleted == False)  # noqa: E712
        )
        for parent_id, sn in component_serials_result.all():
            component_serials_by_parent.setdefault(parent_id, []).append(sn)

    latest_split_audit_user: dict[UUID, UUID] = {}
    if split_ids:
        audit_result = await db.execute(
            select(AuditLog)
            .where(
                AuditLog.entity_type == "delivery_split",
                AuditLog.entity_id.in_(split_ids),
            )
            .order_by(AuditLog.entity_id, AuditLog.timestamp.desc())
        )
        for audit in audit_result.scalars().all():
            if audit.entity_id not in latest_split_audit_user:
                latest_split_audit_user[audit.entity_id] = audit.performed_by
                user_ids.add(audit.performed_by)

    latest_order_audit_user: dict[UUID, UUID] = {}
    if order_ids:
        order_audit_result = await db.execute(
            select(AuditLog)
            .where(
                AuditLog.entity_type == "order",
                AuditLog.entity_id.in_(order_ids),
            )
            .order_by(AuditLog.entity_id, AuditLog.timestamp.desc())
        )
        for audit in order_audit_result.scalars().all():
            if audit.entity_id not in latest_order_audit_user:
                latest_order_audit_user[audit.entity_id] = audit.performed_by
                user_ids.add(audit.performed_by)

    users_by_id: dict[UUID, str] = {}
    if user_ids:
        user_result = await db.execute(select(User).where(User.id.in_(list(user_ids))))
        users_by_id = {user.id: user.username for user in user_result.scalars().all()}

    work_hours_per_day = await _get_work_hours_per_day(db)
    employee_map = await _get_step_employee_map(db)

    tasks: list[GanttTaskOut] = []

    for order in orders:
        product_params = _build_product_params(order)
        is_outsourced = _build_outsourcing_flag(order)
        # Get active (non-deleted) delivery splits
        active_splits = [
            ds for ds in order.delivery_splits if not ds.is_deleted
        ]

        oid_str = str(order.id)
        oid_emp = employee_map.get(oid_str, {"assembly": 1.0, "production": 1.0, "test": 1.0})
        assembly_emp = oid_emp.get("assembly", 1)
        production_emp = oid_emp.get("production", 1)
        test_emp = oid_emp.get("test", 1)
        emp_task_fields = {
            "assembly_employees": assembly_emp,
            "production_employees": production_emp,
            "test_employees": test_emp,
            "work_hours_per_day": work_hours_per_day,
        }

        if not active_splits:
            base_data = order.base_data or {}
            if bool(base_data.get("_auto_delivery_suppressed", False)):
                continue

            order_creator_username = users_by_id.get(order.created_by)
            order_last_username = users_by_id.get(latest_order_audit_user.get(order.id)) or order_creator_username

            # Generate a dynamic split for backward compatibility / missing splits
            min_start = order.created_at
            fallback_duration = 7
            max_end = _add_workdays(min_start, fallback_duration, holiday_days)
            if order.base_data:
                start_val = order.base_data.get("date") or order.base_data.get("start_date")
                end_val = order.base_data.get("delivery_date") or order.base_data.get("end_date")

                parsed_start = None
                parsed_end = None

                if start_val:
                    try:
                        parsed_start = datetime.fromisoformat(str(start_val).replace("Z", "+00:00"))
                    except ValueError:
                        parsed_start = None

                if end_val:
                    try:
                        parsed_end = datetime.fromisoformat(str(end_val).replace("Z", "+00:00"))
                    except ValueError:
                        parsed_end = None

                if parsed_start and parsed_end:
                    min_start = parsed_start
                    max_end = parsed_end + timedelta(days=1)
                    # Duration is either explicitly stored or calculated
                    prod_days = order.base_data.get("production_days")
                    if prod_days is not None:
                        try:
                            fallback_duration = max(1, int(float(prod_days)))
                        except (ValueError, TypeError):
                            fallback_duration = _calc_duration(parsed_start, max_end, holiday_days)
                    else:
                        fallback_duration = _calc_duration(parsed_start, max_end, holiday_days)
                elif parsed_start:
                    min_start = parsed_start
                    prod_days = order.base_data.get("production_days")
                    if prod_days is not None:
                        try:
                            fallback_duration = max(1, int(float(prod_days)))
                        except (ValueError, TypeError):
                            fallback_duration = 7
                    else:
                        fallback_duration = 7
                    max_end = _add_workdays(min_start, fallback_duration, holiday_days)
                elif parsed_end:
                    min_start = parsed_end
                    max_end = parsed_end + timedelta(days=1)
                    fallback_duration = 1
                else:
                    prod_days = order.base_data.get("production_days")
                    if prod_days is not None:
                        try:
                            fallback_duration = max(1, int(float(prod_days)))
                        except (ValueError, TypeError):
                            fallback_duration = 7
                    else:
                        fallback_duration = 7
                    max_end = _add_workdays(min_start, fallback_duration, holiday_days)

            # Calculate completion metrics from serial numbers (BOM: bileşenlerin
            # seri numaraları da dahil edilir — yukarıdaki component_serials_by_parent).
            completion_percentage, stage_counts = calculate_completion_metrics(
                list(order.serial_numbers) + component_serials_by_parent.get(order.id, [])
            )
            order_derived_status = _blended_status(order.status, _status_from_manual_steps(_get_manual_steps(order)))

            tasks.append(GanttTaskOut(
                id=f"order_{order.id}",
                text=_build_task_text(order),
                start_date=min_start.isoformat(),
                end_date=max_end.isoformat(),
                duration=fallback_duration,
                parent=None,
                type="project",
                progress=0,
                status=order_derived_status,
                external_id=order.external_id,
                    created_by_username=order_creator_username,
                last_interacted_by_username=order_last_username,
                is_outsourced=is_outsourced,
                completion_percentage=completion_percentage,
                stage_counts=stage_counts,
                is_explicit_split=bool((order.base_data or {}).get("is_explicit_split", False)),
                **_build_order_fields(order),
                **product_params,
                **emp_task_fields,
            ))

            qty = 1
            if order.base_data:
                try:
                    qty = float(order.base_data.get("quantity", 1))
                except (ValueError, TypeError):
                    qty = 1

            tasks.append(GanttTaskOut(
                id=f"split_fake_{order.id}",
                text=f"Otomatik Teslimat — {qty} adet",
                start_date=min_start.isoformat(),
                end_date=max_end.isoformat(),
                duration=fallback_duration,
                parent=f"order_{order.id}",
                type="task",
                progress=0,
                status=order_derived_status,
                manual_edit=False,
                quantity=qty,
                    created_by_username=order_creator_username,
                last_interacted_by_username=order_last_username,
                is_outsourced=is_outsourced,
                completion_percentage=completion_percentage,
                stage_counts=stage_counts,
                delivery_date=max_end.isoformat(),
                **_build_order_fields(order),
                **product_params,
                **emp_task_fields,
            ))
            continue

        # Calculate parent dates from children
        min_start = min(ds.start_date for ds in active_splits)
        max_end = max(ds.end_date for ds in active_splits)

        # Parent task (Order — project type)
        order_creator_username = users_by_id.get(order.created_by)
        order_last_username = users_by_id.get(latest_order_audit_user.get(order.id)) or order_creator_username

        # Calculate completion metrics from serial numbers (BOM: bileşenlerin
        # seri numaraları da dahil edilir — yukarıdaki component_serials_by_parent).
        completion_percentage, stage_counts = calculate_completion_metrics(
            list(order.serial_numbers) + component_serials_by_parent.get(order.id, [])
        )

        # Compute original order quantity from base_data (for the parent row display)
        try:
            order_total_qty = float((order.base_data or {}).get("quantity", 0)) or None
        except (ValueError, TypeError):
            order_total_qty = None
        if not order_total_qty:
            order_total_qty = sum(ds.quantity for ds in active_splits)

        # The order's own status is a roll-up of each split's independent manual-step
        # progress — every split now tracks its own status separately.
        split_statuses = [
            _blended_status(ds.status, _status_from_manual_steps(_get_split_manual_steps(ds)))
            for ds in active_splits
        ]
        order_rollup_status = _status_from_split_statuses(split_statuses)

        tasks.append(GanttTaskOut(
            id=f"order_{order.id}",
            text=_build_task_text(order),
            start_date=min_start.isoformat(),
            end_date=max_end.isoformat(),
            duration=_calc_duration(min_start, max_end, holiday_days),
            parent=None,
            type="project",
            progress=0,
            status=order_rollup_status,
            external_id=order.external_id,
            created_by_username=order_creator_username,
            last_interacted_by_username=order_last_username,
            is_outsourced=is_outsourced,
            completion_percentage=completion_percentage,
            stage_counts=stage_counts,
            quantity=order_total_qty,
            # is_explicit_split: only trust the flag stored in base_data when order was split.
            # Do NOT infer from deleted splits — that causes false positives.
            is_explicit_split=bool((order.base_data or {}).get("is_explicit_split", False)),
                **_build_order_fields(order),
            **product_params,
            **emp_task_fields,
        ))

        # Child tasks (Delivery_Splits) — emit per-stage tasks when product params exist
        for ds in active_splits:
            split_creator_username = users_by_id.get(ds.created_by)
            split_last_username = users_by_id.get(latest_split_audit_user.get(ds.id)) or split_creator_username
            split_status = _blended_status(ds.status, _status_from_manual_steps(_get_split_manual_steps(ds)))

            # Bu parçaya özel üretim parametresi geçersiz kılmaları (varsa) sipariş
            # değerinin üzerine yazılır — YALNIZCA aşağıdaki iç süre hesaplaması için
            # kullanılır. `product_params` (sipariş-geneli, birleştirilmemiş) kasıtlı
            # olarak DEĞİŞTİRİLMEZ: `**product_params` ile GanttTaskOut'a spread
            # edildiği yerler (RightPanel'in "Adım Süreleri" formu bunlardan okur) hep
            # saf sipariş-seviyesi değeri taşımaya devam etmeli, aksi halde RightPanel'de
            # ilgisiz bir alanı kaydetmek bu parçanın override'larını yanlışlıkla yeni
            # sipariş-geneli varsayılan olarak yazardı.
            split_effective_params = effective_product_params(order.base_data, ds.param_overrides)

            # Determine per-stage durations from product/order params
            # - supply / delivery: fixed days (total for order)
            # - assembly: days per unit × quantity ÷ assembly_employees
            # - production sub-steps: minutes per unit × quantity ÷ (work_minutes × production_employees)
            # - test sub-steps: minutes per unit × quantity ÷ (work_minutes × test_employees)
            qty = max(1, effective_split_quantity(ds) or 1)
            work_minutes = work_hours_per_day * 60

            # Per-split employee override (fall back to order-level)
            sid_str = str(ds.id)
            split_emp = employee_map.get(sid_str, {})
            s_assembly = split_emp.get("assembly") or assembly_emp
            s_production = split_emp.get("production") or production_emp
            s_test = split_emp.get("test") or test_emp
            split_emp_fields = {
                "assembly_employees": s_assembly,
                "production_employees": s_production,
                "test_employees": s_test,
                "work_hours_per_day": work_hours_per_day,
            }

            # Bu parça fason (dış dizgi) mi? Hem parçanın kendi bayrağı hem de
            # siparişin genel bayrağı dikkate alınır. Aşağıda hem etiketlemede
            # ("Fason (Dış Dizgi)" vs "Dizgi") hem de süre hesabında
            # (calculate_split_stage_ranges'e is_outsourced olarak) kullanılır —
            # fason işin süresi adetle çarpılmaz ve işçi sayısına bölünmez
            # (kuralın kendisi ve gerekçesi: date_utils.py _block_days).
            split_is_fason = bool(ds.is_outsourced) or bool(is_outsourced)

            # Kullanıcının önizleme modalinde sürükle-bırak ile kaydettiği özel program
            # varsa (stage_schedule), aşağıdaki hesaplanan (11 ince alt-aşamalı) mantığın
            # yerine doğrudan onu kullan — Gantt/Takvim/Hiyerarşik Gantt/Adım Görünümü/Özet
            # hepsi aynı /gantt/tasks yanıtından beslendiği için tek noktadan düzelir.
            component_ready_at = components_ready_at_by_split_map.get(ds.id) or components_ready_at_map.get(order.id)
            custom_blocks = (ds.stage_schedule or {}).get("blocks") if ds.stage_schedule else None
            if custom_blocks:
                # Kaydedilmiş özel programda bir blok (ör. Test) yer almayabilir — özel
                # program kaydedildiği anda o bloğun süresi 0/boştu demektir. Sonradan o
                # bloğu gerektirecek parametreler eklenirse, eksik anahtar EBEDİYEN
                # kaybolmasın diye güncel önerilen programdan geri eklenir — kullanıcının
                # özel konumlandırdığı diğer bloklara dokunulmaz.
                suggested_ranges = {
                    r["key"]: r
                    for r in calculate_split_stage_ranges(
                        end_date=ds.end_date,
                        quantity=qty,
                        product_params=split_effective_params,
                        emp={"assembly": s_assembly, "production": s_production, "test": s_test},
                        work_minutes=work_minutes,
                        holidays=holiday_days,
                        is_outsourced=split_is_fason,
                        component_ready_at=component_ready_at,
                        start_date=ds.start_date,
                    )
                }
                stage_label_map = {
                    "supply": "Tedarik",
                    "assembly": "Fason (Dış Dizgi)" if split_is_fason else "Dizgi",
                    "production": "Üretim",
                    "test": "Test",
                    "delivery": "Teslimat",
                }
                custom_tasks: list[GanttTaskOut] = []
                for key in BLOCK_KEYS:
                    blk = custom_blocks.get(key)
                    if blk:
                        start_dt = datetime.fromisoformat(blk["start"])
                        end_dt = datetime.fromisoformat(blk["end"])
                    elif key in suggested_ranges:
                        start_dt = suggested_ranges[key]["start"]
                        end_dt = suggested_ranges[key]["end"]
                    else:
                        continue
                    custom_tasks.append(GanttTaskOut(
                        id=f"split_{ds.id}_{key}",
                        text=f"{stage_label_map[key]} — {ds.quantity:.0f} adet",
                        start_date=start_dt.isoformat(),
                        end_date=end_dt.isoformat(),
                        duration=_calc_duration(start_dt, end_dt, holiday_days),
                        parent=f"order_{order.id}",
                        type="task",
                        progress=0,
                        status=split_status,
                        manual_edit=ds.manual_edit,
                        quantity=ds.quantity,
                                    created_by_username=split_creator_username,
                        last_interacted_by_username=split_last_username,
                        is_outsourced=split_is_fason,
                        stage=key,
                        completion_percentage=completion_percentage,
                        stage_counts=stage_counts,
                        delivery_date=ds.end_date.isoformat(),
                        **_build_order_fields(order),
                        **product_params,
                        **split_emp_fields,
                    ))
                tasks.extend(custom_tasks)
                continue

            # Emit consecutive block tasks. `calculate_split_stage_ranges` (date_utils.py)
            # kullanılır — burada AYRI bir geriye-dönük hesap kopyası TUTULMAZ, çünkü
            # daha önce tam olarak bu yüzden (iki paralel implementasyon birbirinden
            # sapıp) BOM'lu siparişlerde Tedarik'in bilesenlerle ilgisiz, yanlış bir
            # tarihte gösterilmesine yol açan bug oluşmuştu.
            #
            # Eskiden burada, tam da bu uyarıya rağmen, blok sürelerini elle hesaplayan
            # ~150 satırlık ikinci bir kopya vardı (supply_d/assembly_stage_days/
            # production_stage_days/test_stage_days/delivery_d). Gerçek tarihler yine
            # aşağıdaki kanonik çağrıdan geliyordu; o kopyanın TEK işlevi "hiç aşama
            # var mı?" kontrolüydü — ve o kontrol hiçbir zaman tetiklenemiyordu, çünkü
            # Tedarik ve Teslimat her koşulda en az 1 güne zorlanıyor (bkz. _block_days).
            # Kopya ve ona bağlı ölü fallback dalı kaldırıldı; silmeden önce iki
            # implementasyonun 540 kombinasyonda aynı sonucu verdiği doğrulandı
            # (tests/test_gantt_block_equivalence.py).
            stage_labels = {
                "supply": "Tedarik",
                "assembly": "Fason (Dış Dizgi)" if split_is_fason else "Dizgi",
                "production": "Üretim",
                "test": "Test",
                "delivery": "Teslimat",
            }

            computed_blocks = calculate_split_stage_ranges(
                end_date=ds.end_date,
                quantity=qty,
                product_params=split_effective_params,
                emp={"assembly": s_assembly, "production": s_production, "test": s_test},
                work_minutes=work_minutes,
                holidays=holiday_days,
                is_outsourced=split_is_fason,
                component_ready_at=component_ready_at,
                start_date=ds.start_date,
            )
            stage_tasks: list[GanttTaskOut] = []

            for blk in computed_blocks:
                stage_key = blk["key"]
                stage_start = blk["start"]
                stage_end = blk["end"]
                duration = _calc_duration(stage_start, stage_end, holiday_days)
                stage_tasks.append(GanttTaskOut(
                    id=f"split_{ds.id}_{stage_key}",
                    text=f"{stage_labels.get(stage_key, stage_key)} — {ds.quantity:.0f} adet",
                    start_date=stage_start.isoformat(),
                    end_date=stage_end.isoformat(),
                    duration=duration,
                    parent=f"order_{order.id}",
                    type="task",
                    progress=0,
                    status=split_status,
                    manual_edit=ds.manual_edit,
                    quantity=ds.quantity,
                            created_by_username=split_creator_username,
                    last_interacted_by_username=split_last_username,
                    is_outsourced=split_is_fason,
                    stage=stage_key,
                    completion_percentage=completion_percentage,
                    stage_counts=stage_counts,
                    delivery_date=ds.end_date.isoformat(),
                    **_build_order_fields(order),
                    **product_params,
                    **split_emp_fields,
                ))

            tasks.extend(stage_tasks)

    # BOM: bileşen siparişlerin (parent_order_id ile ana siparişe bağlı) kendi 4
    # aşamalı (Tedarik/Dizgi/Üretim/Test — Teslimat YOK) nested görevlerini üret.
    # Ana siparişlerin işlendiği yukarıdaki döngüden bağımsız, ayrı bir geçiş —
    # mevcut per-order dallanma mantığına (custom_blocks/no-split/vb.) dokunmadan.
    component_result = await db.execute(
        select(Order)
        .where(Order.parent_order_id.isnot(None), Order.is_deleted == False)  # noqa: E712
        .options(selectinload(Order.delivery_splits))
        .order_by(Order.created_at)
    )
    component_stage_labels = {"supply": "Tedarik", "assembly": "Dizgi", "production": "Üretim", "test": "Test"}
    for comp_order in component_result.scalars().unique().all():
        comp_splits = [ds for ds in comp_order.delivery_splits if not ds.is_deleted]
        if not comp_splits:
            continue
        comp_product_params = _build_product_params(comp_order)
        comp_product_name = (comp_order.base_data or {}).get("product_name") or "Bileşen"

        # Bilesenin KENDISI de parcali teslimata bolunmus olabilir (birden fazla
        # aktif DeliverySplit) — HER split icin ayri ayri blok hesaplanir, aksi
        # halde sadece ilk split'in asamalari uretilip digerleri sessizce kaybolurdu.
        comp_blocks_by_split: list[tuple[DeliverySplit, list[dict]]] = []
        for comp_split in comp_splits:
            comp_blocks = calculate_split_stage_ranges(
                end_date=comp_split.end_date,
                quantity=effective_split_quantity(comp_split),
                product_params=comp_product_params,
                emp={"assembly": 1.0, "production": 1.0, "test": 1.0},
                work_minutes=work_hours_per_day * 60,
                holidays=holiday_days,
                include_delivery=False,
            )
            if comp_blocks:
                comp_blocks_by_split.append((comp_split, comp_blocks))
        if not comp_blocks_by_split:
            continue

        # Bilesen icin ARA bir "proje" satiri (Order->stage gorevi deseninin ayni
        # ana siparis A'ninkiyle PAYLASILMIYOR — eger bilesenin asama gorevleri
        # dogrudan `parent=order_{A.id}` alsaydi, RightPanel/GanttChart'taki
        # "ayni parent'i paylasan kardes gorevler = ayni siparisin parcali
        # teslimat parcalari" tespiti (getSplitRootId + siblings) bu bilesenleri
        # A'nin PARCALI TESLIMAT parcalari sanirdi. Bu yeni ara satir B/C'yi kendi
        # ayri "order_{B.id}" kok'unde tutup A'nin altina nested gosterirken bu
        # yanlis eslesmeyi engeller.
        comp_start = min(b["start"] for _, blocks in comp_blocks_by_split for b in blocks)
        comp_end = max(b["end"] for _, blocks in comp_blocks_by_split for b in blocks)
        tasks.append(GanttTaskOut(
            id=f"order_{comp_order.id}",
            text=f"📦 {comp_product_name}",
            start_date=comp_start.isoformat(),
            end_date=comp_end.isoformat(),
            duration=_calc_duration(comp_start, comp_end, holiday_days),
            parent=f"order_{comp_order.parent_order_id}",
            type="project",
            quantity=sum(cs.quantity for cs in comp_splits),
            on_hand_quantity=sum(cs.on_hand_quantity or 0.0 for cs in comp_splits),
            **comp_product_params,
        ))
        for comp_split, comp_blocks in comp_blocks_by_split:
            for blk in comp_blocks:
                tasks.append(GanttTaskOut(
                    id=f"split_{comp_split.id}_{blk['key']}",
                    text=f"{comp_product_name} — {component_stage_labels.get(blk['key'], blk['key'])} — {comp_split.quantity:.0f} adet",
                    start_date=blk["start"].isoformat(),
                    end_date=blk["end"].isoformat(),
                    duration=_calc_duration(blk["start"], blk["end"], holiday_days),
                    parent=f"order_{comp_order.id}",
                    type="task",
                    stage=blk["key"],
                    manual_edit=comp_split.manual_edit,
                    quantity=comp_split.quantity,
                    on_hand_quantity=comp_split.on_hand_quantity,
                    **comp_product_params,
                ))

    return GanttTasksResponse(tasks=tasks, total=len(tasks))


@router.get(
    "/tasks/{task_id}/notes",
    response_model=list[DeliveryNoteOut],
    summary="List shared notes for a delivery",
)
async def list_delivery_notes(
    task_id: str,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[DeliveryNoteOut]:
    order = await _resolve_order_for_task(db, task_id)

    result = await db.execute(
        select(DeliveryNote, User.username)
        .join(User, DeliveryNote.created_by == User.id)
        .where(DeliveryNote.order_id == order.id)
        .order_by(DeliveryNote.created_at.asc())
    )

    rows = result.all()
    return [
        DeliveryNoteOut(
            id=str(note.id),
            order_id=str(note.order_id),
            content=note.content,
            created_by=str(note.created_by),
            created_by_username=username,
            created_at=note.created_at.isoformat(),
        )
        for note, username in rows
    ]


@router.post(
    "/tasks/{task_id}/notes",
    response_model=DeliveryNoteOut,
    status_code=status.HTTP_201_CREATED,
    summary="Add a shared note to a delivery",
)
async def create_delivery_note(
    task_id: str,
    body: DeliveryNoteCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DeliveryNoteOut:
    if not body.content.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Note content cannot be empty",
        )

    order = await _resolve_order_for_task(db, task_id)
    note = DeliveryNote(
        order_id=order.id,
        content=body.content.strip(),
        created_by=current_user.id,
    )
    db.add(note)
    await db.flush()
    await db.refresh(note)

    return DeliveryNoteOut(
        id=str(note.id),
        order_id=str(note.order_id),
        content=note.content,
        created_by=str(note.created_by),
        created_by_username=current_user.username,
        created_at=note.created_at.isoformat(),
    )


@router.get(
    "/tasks/{task_id}/manual-steps",
    response_model=ManualStepStateOut,
    summary="Get manual step state for a delivery (per-split when the task is a single delivery split)",
)
async def get_manual_step_state(
    task_id: str,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> ManualStepStateOut:
    order, split = await _resolve_task_target(db, task_id)
    return _manual_step_state_out(order, split)


@router.patch(
    "/tasks/{task_id}/manual-steps",
    response_model=ManualStepStateOut,
    summary="Update manual step state for a delivery (per-split when the task is a single delivery split)",
)
async def update_manual_step_state(
    task_id: str,
    body: ManualStepUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ManualStepStateOut:
    order, split = await _resolve_task_target(db, task_id)
    old_steps = _get_split_manual_steps(split) if split is not None else _get_manual_steps(order)
    incoming_steps = _normalize_manual_steps(body.steps)
    now_iso = datetime.now(timezone.utc).isoformat()

    # BOM ana siparişlerde (bileşenleri varsa) "Dizgi" ayrı/bağımsız bir adım
    # değildir — bileşenlerin kendi Dizgi'siyle yapılmış sayılır ve süre hesabı
    # zaten Dizgi'yi atlar (bkz. date_utils.py calculate_split_stage_ranges,
    # component_ready_at filtresi). Bu yüzden kullanıcı ne gönderirse göndersin,
    # "assembly"nin işaretli durumu "supply"e KİLİTLENİR — Tedarik tamamlanınca
    # Dizgi de otomatik tamamlanmış sayılır, Tedarik geri alınınca Dizgi de geri
    # alınır. (Bileşen siparişlerin KENDİSİ için bu geçerli değil — onların kendi
    # bileşeni olmadığı için get_components_ready_at None döner.)
    if await get_components_ready_at(db, order.id) is not None:
        incoming_steps = dict(incoming_steps)
        incoming_steps["assembly"] = incoming_steps["supply"]

    new_steps: dict[str, dict[str, str | bool | None]] = {}
    for key in MANUAL_STEP_KEYS:
        incoming = incoming_steps[key]
        previous = old_steps.get(key, {})

        if bool(incoming.get("checked")):
            new_steps[key] = {
                "checked": True,
                "checked_by": str(current_user.id),
                "checked_by_username": current_user.username,
                "checked_at": now_iso if not bool(previous.get("checked")) or previous.get("checked_by") != str(current_user.id) else previous.get("checked_at") or now_iso,
            }
        else:
            new_steps[key] = {
                "checked": False,
                "checked_by": None,
                "checked_by_username": None,
                "checked_at": None,
            }

    old_status = order.status

    if split is not None:
        _set_split_manual_steps(split, new_steps)
        # A status set directly (e.g. "Tedarik" via the Durum dropdown — 0 checked steps,
        # but explicitly APPROVED) must not be silently reset to PENDING just because an
        # unrelated checkbox was toggled — so this blends with, rather than overwrites,
        # the persisted status column.
        split.status = _blended_status(split.status, _status_from_manual_steps(new_steps))
        # The order's own status becomes a roll-up of all its (still active) splits —
        # each split now tracks its own progress independently.
        active_splits = [s for s in order.delivery_splits if not s.is_deleted]
        split_statuses = [
            _blended_status(s.status, _status_from_manual_steps(_get_split_manual_steps(s)))
            for s in active_splits
        ]
        order.status = _status_from_split_statuses(split_statuses)
        audit_entity_type = "delivery_split"
        audit_entity_id = split.id
    else:
        _set_manual_steps(order, new_steps)
        order.status = _blended_status(order.status, _status_from_manual_steps(new_steps))
        audit_entity_type = "order"
        audit_entity_id = order.id

    db.add(
        AuditLog(
            entity_type=audit_entity_type,
            entity_id=audit_entity_id,
            action=AuditAction.UPDATE.value,
            old_value={"manual_steps": old_steps, "status": old_status},
            new_value={"manual_steps": new_steps, "status": order.status},
            performed_by=current_user.id,
        )
    )

    await db.commit()

    await sse_manager.publish("TASK_UPDATED", {
        "task_id": task_id,
        "updated_by": current_user.username,
        "action": "manual_steps_updated",
    })

    return _manual_step_state_out(order, split)


@router.patch(
    "/tasks/{task_id}/fields",
    response_model=GanttTaskOut,
    summary="Update order base_data fields",
)
async def update_order_fields(
    task_id: str,
    body: OrderFieldsUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> GanttTaskOut:
    """
    Update editable first-class order fields.
    """
    holiday_days = await _get_holiday_days(db)
    order = await _resolve_order_for_task(db, task_id)
    
    # Store old values for audit
    old_base_data = dict(order.base_data or {})
    old_order_fields = _build_order_fields(order)

    order.customer_name = body.customer_name
    order.responsible_personnel = body.responsible_personnel
    if body.order_date is not None:
        try:
            order.order_date = datetime.fromisoformat(body.order_date).date()
        except ValueError:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid order_date format. Use YYYY-MM-DD.")
    if body.promised_date is not None:
        try:
            order.promised_date = datetime.fromisoformat(body.promised_date).date()
        except ValueError:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid promised_date format. Use YYYY-MM-DD.")
    if body.requirement_date is not None:
        try:
            order.requirement_date = datetime.fromisoformat(body.requirement_date).date()
        except ValueError:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid requirement_date format. Use YYYY-MM-DD.")
    if body.penalty_date is not None:
        try:
            order.penalty_date = datetime.fromisoformat(body.penalty_date).date()
        except ValueError:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid penalty_date format. Use YYYY-MM-DD.")
    
    # base_data scheduling fields are not editable via this endpoint; preserve existing
    order.base_data = old_base_data
    
    # Audit log
    audit = AuditLog(
        entity_type="order",
        entity_id=order.id,
        action=AuditAction.UPDATE.value,
        old_value={"order_fields": old_order_fields, "base_data": old_base_data},
        new_value={"order_fields": _build_order_fields(order), "base_data": order.base_data},
        performed_by=current_user.id,
    )
    db.add(audit)
    await db.commit()
    
    # Get first delivery split for task output
    result = await db.execute(
        select(DeliverySplit).where(
            DeliverySplit.order_id == order.id,
            DeliverySplit.is_deleted == False,  # noqa: E712
        )
    )
    splits = result.scalars().all()
    split = splits[0] if splits else None
    
    task_id_out = f"order_{order.id}" if not split else f"split_{split.id}"
    
    task_out = GanttTaskOut(
        id=task_id_out,
        text=_build_task_text(order),
        start_date=split.start_date.isoformat() if split else datetime.now(timezone.utc).isoformat(),
        duration=_calc_duration(split.start_date, split.end_date, holiday_days) if split else 1,
        parent=None,
        type="project",
        external_id=order.external_id,
        **_build_order_fields(order),
    )
    
    await sse_manager.publish("TASK_UPDATED", {
        "task": task_out.model_dump(),
        "updated_by": current_user.username,
        "action": "fields_updated",
    })
    
    return task_out


@router.patch(
    "/tasks/{task_id}/product-params",
    response_model=GanttTaskOut,
    summary="Update per-order product parameter overrides (stage durations)",
)
async def update_product_params(
    task_id: str,
    body: ProductParamsUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> GanttTaskOut:
    """
    Override stage duration parameters for a specific order (stored in order.base_data).
    Only non-None fields are written; existing values for omitted fields are preserved.
    """
    holiday_days = await _get_holiday_days(db)
    order = await _resolve_order_for_task(db, task_id)

    old_base_data = dict(order.base_data or {})

    # Partial update: only write non-None fields
    updates = {
        "supply_days": body.supply_days,
        "production_days": body.production_days,
        "outsource_days": body.outsource_days,
        "quality_minutes": body.quality_minutes,
        "epoxy_minutes": body.epoxy_minutes,
        "conformal_minutes": body.conformal_minutes,
        "montaj_minutes": body.montaj_minutes,
        "montaj_kalite_minutes": body.montaj_kalite_minutes,
        "test1_minutes": body.test1_minutes,
        "test2_minutes": body.test2_minutes,
        "final_test_minutes": body.final_test_minutes,
        "delivery_days": body.delivery_days,
    }
    new_base_data = dict(order.base_data or {})
    # Zamanlama motoru (date_utils.py _block_days) "outsource_days" alanını HİÇ
    # okumaz — fason (dış dizgi) süresi gerçekte "assembly_days"ten (production_days
    # ile aynı gölgeleme kuralına tabi) hesaplanır. Bu yüzden fason bir siparişte
    # kullanıcının "Fason" kutusuna girdiği değer burada assembly_days'e de
    # yazılmazsa, "kaydedildi" mesajına rağmen Dizgi aşaması zamanlamadan tamamen
    # düşer. `outsource_days` yine de (geriye dönük uyumluluk/görüntüleme amacıyla
    # onu okuyan diğer ekranlar için) ayrıca saklanır.
    effective_outsourced = (
        bool(body.is_outsourced)
        if body.is_outsourced is not None
        else is_outsourced_from_base_data(order.base_data)
    )
    for key, val in updates.items():
        if val is None:
            continue
        if key == "outsource_days" and effective_outsourced:
            new_base_data["assembly_days"] = val
            new_base_data.pop("production_days", None)
        new_base_data[key] = val
    if body.is_outsourced is not None:
        new_base_data["is_outsourced"] = bool(body.is_outsourced)
    order.base_data = new_base_data

    # Splitler "Parçalara Böl" ile bazıları fason bazıları normal olacak şekilde
    # bilinçli olarak farklılaştırılmış olabilir (bkz. split-multi'deki
    # seg["is_outsourced"]) — sipariş genelindeki bu ayar artık VAR OLAN split'lerin
    # is_outsourced'ını EZMİYOR, yalnızca order.base_data'ya (yeni oluşturulacak
    # split'lerin miras alacağı varsayılana) yazılıyor. Önceden ilgisiz bir alanı
    # (ör. test süresi) güncellemek bile mevcut parça-bazlı fason/normal ayrımını
    # sessizce sıfırlıyordu.
    result = await db.execute(
        select(DeliverySplit).where(
            DeliverySplit.order_id == order.id,
            DeliverySplit.is_deleted == False,  # noqa: E712
        )
    )
    splits = result.scalars().all()

    db.add(AuditLog(
        entity_type="order",
        entity_id=order.id,
        action=AuditAction.UPDATE.value,
        old_value={"base_data": old_base_data},
        new_value={"base_data": new_base_data},
        performed_by=current_user.id,
    ))
    await db.commit()

    split = splits[0] if splits else None

    task_id_out = f"order_{order.id}" if not split else f"split_{split.id}"
    product_params = _build_product_params(order)

    task_out = GanttTaskOut(
        id=task_id_out,
        text=_build_task_text(order),
        start_date=split.start_date.isoformat() if split else datetime.now(timezone.utc).isoformat(),
        duration=_calc_duration(split.start_date, split.end_date, holiday_days) if split else 1,
        parent=None,
        type="project",
        external_id=order.external_id,
        **_build_order_fields(order),
        **product_params,
    )

    await sse_manager.publish("TASK_UPDATED", {
        "task": task_out.model_dump(),
        "updated_by": current_user.username,
        "action": "product_params_updated",
    })

    return task_out


@router.patch(
    "/tasks/{task_id}/notes/{note_id}",
    response_model=DeliveryNoteOut,
    summary="Update a shared note",
)
async def update_delivery_note(
    task_id: str,
    note_id: UUID,
    body: DeliveryNoteUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DeliveryNoteOut:
    if not body.content.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Note content cannot be empty",
        )

    order = await _resolve_order_for_task(db, task_id)

    result = await db.execute(
        select(DeliveryNote, User.username)
        .join(User, DeliveryNote.created_by == User.id)
        .where(DeliveryNote.id == note_id, DeliveryNote.order_id == order.id)
    )
    row = result.first()
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Note not found",
        )

    note, username = row
    if not _can_manage_note(current_user, note):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot edit this note",
        )

    note.content = body.content.strip()
    await db.flush()

    return DeliveryNoteOut(
        id=str(note.id),
        order_id=str(note.order_id),
        content=note.content,
        created_by=str(note.created_by),
        created_by_username=username,
        created_at=note.created_at.isoformat(),
    )


@router.delete(
    "/tasks/{task_id}/notes/{note_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a shared note",
)
async def delete_delivery_note(
    task_id: str,
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    order = await _resolve_order_for_task(db, task_id)

    result = await db.execute(
        select(DeliveryNote).where(
            DeliveryNote.id == note_id,
            DeliveryNote.order_id == order.id,
        )
    )
    note = result.scalar_one_or_none()
    if not note:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Note not found",
        )

    if not _can_manage_note(current_user, note):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot delete this note",
        )

    await db.delete(note)


@router.patch(
    "/tasks/{task_id}",
    response_model=GanttTaskOut,
    summary="Update task dates (drag-and-drop)",
)
async def update_gantt_task(
    task_id: str,
    body: GanttUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> GanttTaskOut:
    """
    Update a Delivery_Split's start/end dates when dragged in SVAR Gantt.
    Sets manual_edit = True and logs to AuditLog.
    Only child tasks (split_*) can be updated via drag.
    """
    holiday_days = await _get_holiday_days(db)

    # Validate task_id format
    if not task_id.startswith("split_") and not task_id.startswith("split_fake_"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only delivery split tasks can be updated via drag. Order (project) rows are calculated automatically.",
        )

    # Parse dates
    try:
        new_start = datetime.fromisoformat(body.start_date.replace("Z", "+00:00"))
        new_end = datetime.fromisoformat(body.end_date.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid date format. Use ISO 8601.",
        )

    if new_end <= new_start:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="end_date must be after start_date",
        )

    if body.quantity is not None and body.quantity <= 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="quantity must be greater than 0",
        )

    # split_fake_* rows are synthetic fallback tasks (no DB split yet).
    # If user edits them, create a real delivery split.
    if task_id.startswith("split_fake_"):
        order_id = task_id.replace("split_fake_", "")
        try:
            order_uuid = UUID(order_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid task ID format",
            )

        order_result = await db.execute(
            select(Order)
            .where(
                Order.id == order_uuid,
                Order.is_deleted == False,  # noqa: E712
            )
            .options(selectinload(Order.serial_numbers), selectinload(Order.delivery_splits))
        )
        order = order_result.scalar_one_or_none()
        if not order:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Order not found",
            )

        fallback_qty = 1.0
        if order.base_data:
            try:
                fallback_qty = float(order.base_data.get("quantity", 1))
            except (ValueError, TypeError):
                fallback_qty = 1.0

        new_split = DeliverySplit(
            order_id=order.id,
            quantity=body.quantity if body.quantity is not None else fallback_qty,
            start_date=new_start,
            end_date=new_end,
            manual_edit=True,
            created_by=current_user.id,
        )
        db.add(new_split)
        _set_auto_delivery_suppressed(order, False)
        db.add(
            AuditLog(
                entity_type="delivery_split",
                entity_id=order.id,
                action=AuditAction.CREATE.value,
                old_value=None,
                new_value={
                    "source": task_id,
                    "quantity": new_split.quantity,
                    "start_date": new_start.isoformat(),
                    "end_date": new_end.isoformat(),
                    "manual_edit": True,
                },
                performed_by=current_user.id,
            )
        )

        await db.commit()
        await db.refresh(new_split)

        task_out = GanttTaskOut(
            id=f"split_{new_split.id}",
            text=f"Teslimat — {new_split.quantity:.0f} adet",
            start_date=new_split.start_date.isoformat(),
            duration=_calc_duration(new_split.start_date, new_split.end_date, holiday_days),
            parent=f"order_{new_split.order_id}",
            type="task",
            manual_edit=new_split.manual_edit,
            quantity=new_split.quantity,
        )

        await sse_manager.publish("TASK_CREATED", {
            "task": task_out.model_dump(),
            "created_by": current_user.username,
        })
        return task_out

    # support optional stage suffix: "split_<uuid>" or "split_<uuid>_<stage>"
    remainder = task_id.replace("split_", "")
    parts = remainder.split("_")
    split_id = parts[0]
    stage_suffix = parts[1] if len(parts) > 1 else None
    try:
        split_uuid = UUID(split_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid task ID format",
        )

    # Fetch the delivery split
    result = await db.execute(
        select(DeliverySplit).where(
            DeliverySplit.id == split_uuid,
            DeliverySplit.is_deleted == False,  # noqa: E712
        )
    )
    split = result.scalar_one_or_none()
    if not split:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Delivery split not found",
        )

    # Store old values for audit
    order_result = await db.execute(
        select(Order).where(Order.id == split.order_id).options(selectinload(Order.serial_numbers))
    )
    order = order_result.scalar_one_or_none()

    old_values = {
        "start_date": split.start_date.isoformat(),
        "end_date": split.end_date.isoformat(),
        "manual_edit": split.manual_edit,
        "quantity": split.quantity,
    }

    # Update
    # If the incoming task_id targeted a stage-specific bar (e.g. split_<uuid>_assembly)
    # calculate original stage start using backward scheduling from split.end_date,
    # then shift the entire delivery by the delta.
    if stage_suffix:
        # Split-özel üretim parametresi (param_overrides) ve split-seviyesi işçi
        # ataması varsa bunlar dikkate alınmalı — read path'in (get_gantt_tasks
        # satır ~1060/1093, _suggested_stage_schedule) kullandığı ile AYNI kaynak
        # (effective_product_params + split-seviyesi emp lookup). Eskiden burada
        # yalnızca sipariş-seviyesi parametre/işçi sayısı kullanan, AYRI bir
        # kopya hesap vardı — ekranda gösterilen (split-özel parametrelerle
        # hesaplanmış) blok ile sürükleme sonrası kaydedilen tarih birbirini
        # tutmuyordu (bkz. gantt.py'deki "iki paralel implementasyon" uyarısı,
        # get_gantt_tasks içinde birkaç satır aşağıda).
        effective_params = effective_product_params(order.base_data, split.param_overrides) if order else {}
        work_hours_per_day_for_update = await _get_work_hours_per_day(db)
        work_minutes = work_hours_per_day_for_update * 60
        employee_map_for_update = await _get_step_employee_map(db)

        oid_str = str(order.id)
        sid_str = str(split.id)
        split_emp = employee_map_for_update.get(
            sid_str, employee_map_for_update.get(oid_str, {"assembly": 1.0, "production": 1.0, "test": 1.0})
        )
        # Fason (dış dizgi) ayrımı — read path ile aynı kural (bkz. calculate_split_stage_ranges/
        # _block_days: fason ise Dizgi süresi adetle çarpılmaz, işçi sayısına bölünmez).
        split_is_fason = bool(split.is_outsourced) or bool(_build_outsourcing_flag(order))

        # BOM: order kendi bileşenlerine sahip bir ana siparişse Dizgi atlanır —
        # read path ile aynı kural, aksi halde "hangi blok sürükleniyor" tespiti
        # (aşağıdaki orig_stage_start) var olmayan bir Dizgi süresini hesaba
        # katarak yanlış konumlanır.
        stage_component_ready_at = (
            await get_components_ready_at(db, order.id)
            if order is not None and order.parent_order_id is None
            else None
        )
        # Tedarik bilesenlerle paralel cizilir; bitisi ready_at (MAX), baslangici
        # start_at (MIN) — bkz. date_utils.calculate_split_start_date.
        stage_components_start_at = (
            await get_components_start_at(db, order.id)
            if order is not None and order.parent_order_id is None
            else None
        )

        # BOM bileşen split'leri (component_product_id dolu) müşteriye teslim
        # edilmez — Teslimat adımı hiç yoktur (bkz. calculate_component_end_date/
        # _apply_component_on_hand ile aynı kural). Bu, aşağıdaki her iki çağrıda
        # da (blok tespiti VE olası yeniden hesap) include_delivery=False ile
        # belirtilmezse, bileşenin start_date'i olması gerekenden ~1 gün erken
        # (hayalet bir Teslimat günü eklenerek) hesaplanır.
        split_include_delivery = order is None or order.component_product_id is None

        computed_blocks = calculate_split_stage_ranges(
            end_date=split.end_date,
            quantity=effective_split_quantity(split),
            product_params=effective_params,
            emp=split_emp,
            work_minutes=work_minutes,
            holidays=holiday_days,
            is_outsourced=split_is_fason,
            component_ready_at=stage_component_ready_at,
            start_date=split.start_date,
            include_delivery=split_include_delivery,
        )
        matching_block = next((b for b in computed_blocks if b["key"] == stage_suffix), None)

        if matching_block is not None:
            orig_stage_start = matching_block["start"]
            # If new_start matches the original stage start (within 1 hour),
            # this is a form-based edit (user changed end_date only, not a drag).
            # Recalculate start from the new end_date instead of shifting.
            if abs((new_start - orig_stage_start).total_seconds()) < 3600:
                new_calculated_start = calculate_split_start_date(
                    end_date=new_end,
                    quantity=effective_split_quantity(split),
                    product_params=effective_params,
                    emp=split_emp,
                    work_minutes=work_minutes,
                    holidays=holiday_days,
                    is_outsourced=split_is_fason,
                    component_ready_at=stage_component_ready_at,
                    components_start_at=stage_components_start_at,
                    include_delivery=split_include_delivery,
                )
                split.start_date = new_calculated_start
                split.end_date = new_end
            else:
                delta = new_start - orig_stage_start
                split.start_date = split.start_date + delta
                split.end_date = split.end_date + delta
        else:
            split.start_date = new_start
            split.end_date = new_end
    else:
        split.start_date = new_start
        split.end_date = new_end

    if body.quantity is not None:
        split.quantity = body.quantity
    split.manual_edit = True

    # Audit log
    audit = AuditLog(
        entity_type="delivery_split",
        entity_id=split.id,
        action=AuditAction.DRAG.value,
        old_value=old_values,
        new_value={
            "start_date": new_start.isoformat(),
            "end_date": new_end.isoformat(),
            "manual_edit": True,
            "quantity": split.quantity,
        },
        performed_by=current_user.id,
    )
    db.add(audit)

    await db.commit()
    await db.refresh(split)

    task_out = GanttTaskOut(
        id=task_id,
        text=f"Teslimat — {split.quantity:.0f} adet",
        start_date=split.start_date.isoformat(),
        duration=_calc_duration(split.start_date, split.end_date, holiday_days),
        parent=f"order_{split.order_id}",
        type="task",
        manual_edit=split.manual_edit,
        quantity=split.quantity,
        on_hand_quantity=split.on_hand_quantity,
    )

    # Publish SSE event to all connected clients
    await sse_manager.publish("TASK_UPDATED", {
        "task": task_out.model_dump(),
        "updated_by": current_user.username,
    })

    return task_out


@router.post(
    "/tasks/{task_id}/split-multi",
    status_code=status.HTTP_201_CREATED,
    summary="Split a delivery into multiple custom segments",
)
async def split_delivery_multi(
    task_id: str,
    body: MultiSplitRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> dict:
    if not task_id.startswith("split_") and not task_id.startswith("split_fake_"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only delivery split tasks can be split",
        )

    if not body.segments or len(body.segments) < 2:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="At least 2 segments are required",
        )

    parsed_segments: list[dict] = []
    for seg in body.segments:
        if seg.quantity <= 0:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Each segment quantity must be greater than 0",
            )
        try:
            seg_end = datetime.fromisoformat(seg.end_date.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Invalid segment date format. Use ISO 8601.",
            )
        if seg.start_date is not None:
            try:
                seg_start = datetime.fromisoformat(seg.start_date.replace("Z", "+00:00"))
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="Invalid segment date format. Use ISO 8601.",
                )
            if seg_end <= seg_start:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="Each segment end_date must be after start_date",
                )
        else:
            seg_start = None
        parsed_segments.append(
            {
                "quantity": float(seg.quantity),
                "start_date": seg_start,
                "end_date": seg_end,
                "is_outsourced": seg.is_outsourced,
                "outsource_days": seg.outsource_days,
            }
        )

    parsed_segments.sort(key=lambda x: x["start_date"] or x["end_date"])

    total_qty = round(sum(seg["quantity"] for seg in parsed_segments), 4)

    created = []
    audit_entity_id = None
    warnings: list[str] = []
    # BOM: bölünen bu "real" bir ana split ise (fake dalda eşleştirilecek bir
    # önceki split yok, bkz. aşağıdaki sync çağrısı), component order'ların
    # senkronizasyonu için gereken referanslar — bkz. _sync_component_orders_for_main_split_replace.
    replaced_main_split_id: UUID | None = None
    replaced_main_split_qty: float = 0.0

    if task_id.startswith("split_fake_"):
        order_id = task_id.replace("split_fake_", "")
        try:
            order_uuid = UUID(order_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid task ID format",
            )

        order_result = await db.execute(
            select(Order).where(
                Order.id == order_uuid,
                Order.is_deleted == False,  # noqa: E712
            )
        )
        order = order_result.scalar_one_or_none()
        if not order:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Order not found",
            )

        expected_qty = None
        if order.base_data:
            try:
                expected_qty = round(float(order.base_data.get("quantity", 0)), 4)
            except (ValueError, TypeError):
                expected_qty = None

        if expected_qty and abs(total_qty - expected_qty) > 0.01:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Segment quantities must sum to original quantity ({expected_qty}).",
            )

        # Load data for start_date calculation
        holiday_days_ext = await _get_holiday_days(db)
        wh_per_day = await _get_work_hours_per_day(db)
        wh_minutes = wh_per_day * 60
        emp_map = await _get_step_employee_map(db)
        # BOM: order kendi bileşenlerine sahip bir ana siparişse Dizgi atlanır ve
        # yeni segmentlerin start_date'i buna göre kaydırılmalı (bkz. calculate_split_start_date
        # docstring'i) — aksi halde yeni parçalar bileşenler bitmeden başlamış gibi kaydedilir.
        split_multi_component_ready_at = (
            await get_components_ready_at(db, order.id) if order.parent_order_id is None else None
        )
        split_multi_components_start_at = (
            await get_components_start_at(db, order.id) if order.parent_order_id is None else None
        )
        # BOM bileşen (component) split'lerinde Teslimat adımı hiç yoktur — bkz.
        # calculate_split_start_date docstring'i. include_delivery=False geçilmezse
        # component segmentlerinin start_date'i sessizce ~1 gün erken hesaplanır.
        seg_include_delivery = order.component_product_id is None

        for seg in parsed_segments:
            oid_emp = emp_map.get(str(order.id), {"assembly": 1.0, "production": 1.0, "test": 1.0})
            seg_fason = bool(seg.get("is_outsourced")) or bool(_build_outsourcing_flag(order))
            # Fason işaretli bir segment için girilen gün sayısı, bu segmentin kendi
            # Dizgi (assembly_days) geçersiz kılması olarak saklanır — fason parçalarda
            # Dizgi süresi artık aynı alandan (assembly_days) okunuyor, ayrı bir
            # outsource_days kavramı yok.
            # order.base_data'da eski bir "production_days" varsa date_utils.py'deki
            # `assembly_d = params.get("production_days") or params.get("assembly_days")`
            # bunu assembly_days'in ÖNÜNE koyar — burada girilen fason süresi sessizce
            # göz ardı edilmesin diye gölgeleyen anahtar da geçersiz kılınır (bkz.
            # order_details.py bulk-update'teki aynı guard).
            seg_param_overrides = (
                {"assembly_days": seg["outsource_days"], "production_days": None}
                if seg.get("is_outsourced") and seg.get("outsource_days")
                else None
            )
            seg_params = effective_product_params(order.base_data, seg_param_overrides)
            if seg["start_date"] is None:
                seg["start_date"] = calculate_split_start_date(
                    end_date=seg["end_date"],
                    quantity=seg["quantity"],
                    product_params=seg_params,
                    emp=oid_emp,
                    work_minutes=wh_minutes,
                    holidays=holiday_days_ext,
                    is_outsourced=seg_fason,
                    component_ready_at=split_multi_component_ready_at,
                    include_delivery=seg_include_delivery,
                    components_start_at=split_multi_components_start_at,
                )
            seg["_stage_ranges"] = calculate_split_stage_ranges(
                end_date=seg["end_date"],
                quantity=seg["quantity"],
                product_params=seg_params,
                emp=oid_emp,
                work_minutes=wh_minutes,
                holidays=holiday_days_ext,
                is_outsourced=seg_fason,
                component_ready_at=split_multi_component_ready_at,
                include_delivery=seg_include_delivery,
            )
            new_split = DeliverySplit(
                order_id=order.id,
                quantity=seg["quantity"],
                start_date=seg["start_date"],
                end_date=seg["end_date"],
                manual_edit=True,
                is_outsourced=seg["is_outsourced"],
                created_by=current_user.id,
                param_overrides=seg_param_overrides,
            )
            db.add(new_split)
            created.append(new_split)

        # Collect overlap warnings for non-outsourced segments
        STAGE_LABEL_MAP = {
            "supply": "Tedarik", "assembly": "Dizgi",
            "kalite": "Kalite", "test1": "Test 1",
            "epoxy": "Epoksi", "conformal": "Conformal",
            "test2": "Test 2", "montaj": "Montaj",
            "montaj_kalite": "Montaj Kalite",
            "final_test": "Final Test",
            "delivery": "Teslimat",
        }
        for i in range(len(parsed_segments)):
            for j in range(i + 1, len(parsed_segments)):
                a = parsed_segments[i]
                b = parsed_segments[j]
                if a["is_outsourced"] or b["is_outsourced"]:
                    continue
                if a["start_date"] < b["end_date"] and b["start_date"] < a["end_date"]:
                    overlapping = []
                    for sa in a.get("_stage_ranges", []):
                        for sb in b.get("_stage_ranges", []):
                            if sa["start"] < sb["end"] and sb["start"] < sa["end"]:
                                overlapping.append(
                                    f"{STAGE_LABEL_MAP.get(sa['key'], sa['key'])} ↔ {STAGE_LABEL_MAP.get(sb['key'], sb['key'])}"
                                )
                    if overlapping:
                        warnings.append(
                            f"{i+1}. parça ({a['start_date'].date()} → {a['end_date'].date()}) ile "
                            f"{j+1}. parça ({b['start_date'].date()} → {b['end_date'].date()}) çakışıyor. "
                            f"Çakışan adımlar: {', '.join(overlapping)}."
                        )
                    else:
                        warnings.append(
                            f"{i+1}. parça ({a['start_date'].date()} → {a['end_date'].date()}) ile "
                            f"{j+1}. parça ({b['start_date'].date()} → {b['end_date'].date()}) çakışıyor."
                        )

        _set_auto_delivery_suppressed(order, False)

        # Yeni split'lerin id'si (default=uuid.uuid4) flush olmadan henüz DB'ye
        # yazılmaz — flush olmadan `created[0].id`e erişmek None döner ve aşağıdaki
        # AuditLog INSERT'i (entity_id NOT NULL) çöker.
        await db.flush()
        audit_entity_id = created[0].id if created else order.id
        order_id_for_marking = order.id
    else:
        # accept optional stage suffix: split_<uuid> or split_<uuid>_<stage>
        remainder = task_id.replace("split_", "")
        parts = remainder.split("_")
        split_id = parts[0]
        try:
            split_uuid = UUID(split_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid task ID format",
            )

        result = await db.execute(
            select(DeliverySplit).where(
                DeliverySplit.id == split_uuid,
                DeliverySplit.is_deleted == False,  # noqa: E712
            )
        )
        original = result.scalar_one_or_none()
        if not original:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Delivery split not found",
            )

        original_qty = round(float(original.quantity), 4)
        if abs(total_qty - original_qty) > 0.01:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Segment quantities must sum to original quantity ({original.quantity}).",
            )

        replaced_main_split_id = original.id
        replaced_main_split_qty = original_qty

        original.is_deleted = True
        original.deleted_at = datetime.now(timezone.utc)

        # Load data for start_date calculation
        holiday_days_ext = await _get_holiday_days(db)
        wh_per_day = await _get_work_hours_per_day(db)
        wh_minutes = wh_per_day * 60
        emp_map = await _get_step_employee_map(db)
        # BOM: bölünen sipariş kendi bileşenlerine sahip bir ana siparişse Dizgi
        # atlanır ve yeni segmentlerin start_date'i buna göre kaydırılmalı (bkz.
        # calculate_split_start_date docstring'i ve yukarıdaki "fake" dalındaki aynı guard).
        _order_for_component_check = await db.get(Order, original.order_id)
        split_multi_component_ready_at = (
            await get_components_ready_at(db, original.order_id)
            if _order_for_component_check is not None and _order_for_component_check.parent_order_id is None
            else None
        )
        split_multi_components_start_at = (
            await get_components_start_at(db, original.order_id)
            if _order_for_component_check is not None and _order_for_component_check.parent_order_id is None
            else None
        )

        # Bölünen split'in (original) elde mevcut stoğu (on_hand_quantity), yeni
        # parçalar arasında dağıtılmazsa SESSİZCE KAYBOLURDU (yeni split'ler
        # varsayılan olarak on_hand_quantity=0 ile oluşturulur) — kullanıcının
        # daha önce girdiği fiziksel stok bilgisi split sonrası sıfırlanmış gibi
        # görünürdü. _sync_component_orders_for_main_split_replace'teki (ana
        # sipariş → bileşen kaskad) AYNI FIFO (önce-önce) mantığı burada da
        # uygulanır: en erken başlayan parça stoğun tamamını önce tüketir, kalan
        # sıradaki (daha geç başlayan) parçaya aktarılır. parsed_segments zaten
        # start_date/end_date'e göre sıralı (bkz. yukarıdaki genel sort).
        original_on_hand = original.on_hand_quantity or 0.0
        remaining_on_hand = original_on_hand
        for seg in parsed_segments:
            allocated = min(remaining_on_hand, seg["quantity"])
            seg["on_hand_quantity"] = allocated
            remaining_on_hand -= allocated

        for seg in parsed_segments:
            order_for_split = await db.get(Order, original.order_id)
            # Bölünen parça (original) kendi üretim parametresi geçersiz kılmalarına
            # sahip olabilir — yeni parçalar hâlâ "aynı ürün", sadece yeniden
            # bölünmüş, bu yüzden hem ilk zamanlama hesaplaması hem de aşağıda
            # oluşturulan her yeni split bu override'ları miras alır. Fason işaretli
            # bir segment için ayrıca girilen gün sayısı, bu segmentin kendi Dizgi
            # (assembly_days) geçersiz kılması olarak eklenir/üzerine yazılır.
            seg_param_overrides = dict(original.param_overrides or {})
            if seg.get("is_outsourced") and seg.get("outsource_days"):
                seg_param_overrides["assembly_days"] = seg["outsource_days"]
                # order.base_data veya original.param_overrides'tan miras kalan bir
                # "production_days" assembly_days'i gölgeleyip girilen fason süresini
                # sessizce göz ardı etmesin diye (bkz. order_details.py bulk-update'teki
                # aynı guard).
                seg_param_overrides["production_days"] = None
            seg_param_overrides = seg_param_overrides or None
            product_params = effective_product_params(order_for_split.base_data, seg_param_overrides)
            oid_emp = emp_map.get(str(order_for_split.id), {"assembly": 1.0, "production": 1.0, "test": 1.0})
            seg_fason = bool(seg.get("is_outsourced")) or bool(_build_outsourcing_flag(order_for_split))
            seg_include_delivery = order_for_split.component_product_id is None
            # Elde mevcut stoğu bu segmente düşen payı kadar (bkz. yukarıdaki FIFO
            # dağıtımı), tarih/süre hesabına giren miktar HER ZAMAN efektif (nominal
            # - elde mevcut) olmalı — aksi halde bu segment, zaten elde bulunan
            # stoğu da üretecekmiş gibi olması gerekenden daha uzun sürede biter.
            seg_effective_qty = max(seg["quantity"] - seg.get("on_hand_quantity", 0.0), 0.0001)
            if seg["start_date"] is None:
                seg["start_date"] = calculate_split_start_date(
                    end_date=seg["end_date"],
                    quantity=seg_effective_qty,
                    product_params=product_params,
                    emp=oid_emp,
                    work_minutes=wh_minutes,
                    holidays=holiday_days_ext,
                    is_outsourced=seg_fason,
                    component_ready_at=split_multi_component_ready_at,
                    include_delivery=seg_include_delivery,
                    components_start_at=split_multi_components_start_at,
                )
            seg["_stage_ranges"] = calculate_split_stage_ranges(
                end_date=seg["end_date"],
                quantity=seg_effective_qty,
                product_params=product_params,
                emp=oid_emp,
                work_minutes=wh_minutes,
                holidays=holiday_days_ext,
                is_outsourced=seg_fason,
                component_ready_at=split_multi_component_ready_at,
                include_delivery=seg_include_delivery,
            )
            new_split = DeliverySplit(
                order_id=original.order_id,
                quantity=seg["quantity"],
                on_hand_quantity=seg.get("on_hand_quantity", 0.0),
                start_date=seg["start_date"],
                end_date=seg["end_date"],
                manual_edit=True,
                is_outsourced=seg["is_outsourced"],
                created_by=current_user.id,
                param_overrides=seg_param_overrides,
            )
            db.add(new_split)
            created.append(new_split)

        # Collect overlap warnings for non-outsourced segments
        STAGE_LABEL_MAP = {
            "supply": "Tedarik", "assembly": "Dizgi",
            "kalite": "Kalite", "test1": "Test 1",
            "epoxy": "Epoksi", "conformal": "Conformal",
            "test2": "Test 2", "montaj": "Montaj",
            "montaj_kalite": "Montaj Kalite",
            "final_test": "Final Test",
            "delivery": "Teslimat",
        }
        for i in range(len(parsed_segments)):
            for j in range(i + 1, len(parsed_segments)):
                a = parsed_segments[i]
                b = parsed_segments[j]
                if a["is_outsourced"] or b["is_outsourced"]:
                    continue
                if a["start_date"] < b["end_date"] and b["start_date"] < a["end_date"]:
                    overlapping = []
                    for sa in a.get("_stage_ranges", []):
                        for sb in b.get("_stage_ranges", []):
                            if sa["start"] < sb["end"] and sb["start"] < sa["end"]:
                                overlapping.append(
                                    f"{STAGE_LABEL_MAP.get(sa['key'], sa['key'])} ↔ {STAGE_LABEL_MAP.get(sb['key'], sb['key'])}"
                                )
                    if overlapping:
                        warnings.append(
                            f"{i+1}. parça ({a['start_date'].date()} → {a['end_date'].date()}) ile "
                            f"{j+1}. parça ({b['start_date'].date()} → {b['end_date'].date()}) çakışıyor. "
                            f"Çakışan adımlar: {', '.join(overlapping)}."
                        )
                    else:
                        warnings.append(
                            f"{i+1}. parça ({a['start_date'].date()} → {a['end_date'].date()}) ile "
                            f"{j+1}. parça ({b['start_date'].date()} → {b['end_date'].date()}) çakışıyor."
                        )

        audit_entity_id = original.id
        order_id_for_marking = original.order_id

    db.add(
        AuditLog(
            entity_type="delivery_split",
            entity_id=audit_entity_id,
            action=AuditAction.SPLIT.value,
            old_value={"source": task_id},
            new_value={
                "segments": [
                    {
                        "quantity": seg["quantity"],
                        "start_date": seg["start_date"].isoformat(),
                        "end_date": seg["end_date"].isoformat(),
                        "is_outsourced": seg["is_outsourced"],
                    }
                    for seg in parsed_segments
                ]
            },
            performed_by=current_user.id,
        )
    )

    # Mark the order as explicitly split and store piece count in base_data
    # (order_id_for_marking: "fake" dalda order.id, "real" dalda original.order_id —
    # `original` yalnızca "real" dalda tanımlı olduğu için doğrudan onu kullanmak
    # "fake" yolda NameError'a yol açardı.)
    order = await db.get(Order, order_id_for_marking)
    if order:
        current_base_data = order.base_data or {}
        if isinstance(current_base_data, dict):
            new_base_data = dict(current_base_data)
            new_base_data["is_explicit_split"] = True
            # Store the number of segments created (piece count)
            new_base_data["split_piece_count"] = len(created)
            order.base_data = new_base_data
            db.add(order)

        # BOM: bölünen sipariş bir alt ürün (bileşen) ise, ana siparişin Tedarik'i
        # artık bu bileşenin en geç biten parçasına kadar sürmeli — ana siparişin
        # kendi zamanlaması yeniden hesaplanıp kaydedilir. get_components_ready_at
        # yeni parçaları görebilsin diye önce flush edilir.
        if order.parent_order_id is not None:
            await db.flush()
            await _recompute_and_persist_bom_main_order(db, order.parent_order_id, current_user.id)

        # BOM: bölünen sipariş kendisi bir ANA sipariş ise (bileşen değilse) ve
        # bölünen split'in (replaced_main_split_id) bağlı bileşen split'leri varsa,
        # onları da AYNI oranda N parçaya böl — bkz. _sync_component_orders_for_main_split_replace.
        # "fake" dalda eşleştirilecek bir önceki split yoktur (replaced_main_split_id
        # None kalır), bu durumda sync no-op'tur.
        if order.parent_order_id is None and replaced_main_split_id is not None:
            await db.flush()
            default_comp_emp = {"assembly": 1.0, "production": 1.0, "test": 1.0}
            new_main_segments = [(s.quantity, s.start_date, s.id) for s in created]
            await _sync_component_orders_for_main_split_replace(
                db, order, replaced_main_split_id, replaced_main_split_qty,
                new_main_segments, current_user.id, holiday_days_ext, wh_minutes, default_comp_emp,
            )
            # Sync yeni (orantılı miktarlı) bileşen split'lerini oluşturdu — bunların
            # GERÇEK bitişi, sync'ten ÖNCE (eski, tam miktarlı bileşenlere göre)
            # hesaplanan segment end_date'lerinden farklı olabilir. bkz. fonksiyon
            # docstring'i — bu, sipariş oluşturma akışındaki otomatik uzatmanın
            # bölme akışındaki eşleniği.
            await db.flush()
            warnings.extend(
                await _gate_new_main_segments_against_component_readiness(
                    db, [s.id for s in created], holiday_days_ext, wh_minutes, default_comp_emp,
                )
            )

    await db.commit()
    for split in created:
        await db.refresh(split)

    await sse_manager.publish("TASK_SPLIT", {
        "source_task_id": task_id,
        "segment_count": len(created),
        "split_by": current_user.username,
    })

    return {
        "message": f"Delivery split into {len(created)} segments",
        "segments": [
            {
                "id": f"split_{split.id}",
                "quantity": split.quantity,
                "start_date": split.start_date.isoformat(),
                "end_date": split.end_date.isoformat(),
            }
            for split in created
        ],
        "warnings": warnings,
    }


@router.post(
    "/tasks/{task_id}/split",
    status_code=status.HTTP_201_CREATED,
    summary="Split a delivery into two",
)
async def split_delivery(
    task_id: str,
    body: SplitRequest = SplitRequest(),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> dict:
    """
    Split a Delivery_Split into two child records:
    - Original gets ratio * quantity and first half of duration
    - New child gets (1-ratio) * quantity and second half of duration
    Logs SPLIT action to AuditLog.
    """
    holiday_days = await _get_holiday_days(db)
    split_warnings: list[str] = []

    if not task_id.startswith("split_"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only delivery split tasks can be split",
        )

    # accept optional stage suffix: split_<uuid> or split_<uuid>_<stage>
    remainder = task_id.replace("split_", "")
    parts = remainder.split("_")
    split_id = parts[0]
    try:
        split_uuid = UUID(split_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid task ID format",
        )

    # Validate ratio
    if body.ratio <= 0 or body.ratio >= 1:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Ratio must be between 0 and 1 (exclusive)",
        )

    # Fetch the delivery split
    result = await db.execute(
        select(DeliverySplit).where(
            DeliverySplit.id == split_uuid,
            DeliverySplit.is_deleted == False,  # noqa: E712
        )
    )
    original = result.scalar_one_or_none()
    if not original:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Delivery split not found",
        )

    # Calculate split
    original_qty = original.quantity
    original_duration_days = _calc_duration(original.start_date, original.end_date, holiday_days)
    first_duration = max(1, math.floor(original_duration_days * body.ratio))
    second_duration = max(1, original_duration_days - first_duration)

    first_qty = round(original_qty * body.ratio, 2)
    second_qty = round(original_qty - first_qty, 2)

    mid_date = _add_workdays(original.start_date, first_duration, holiday_days)

    # Store old values for audit
    old_values = {
        "quantity": original_qty,
        "start_date": original.start_date.isoformat(),
        "end_date": original.end_date.isoformat(),
        "is_outsourced": original.is_outsourced,
    }

    # Update original (first half)
    original.quantity = first_qty
    original.end_date = mid_date
    original.manual_edit = True

    # Create new split (second half) — orijinalin üretim parametresi geçersiz
    # kılmaları (varsa) miras alınır, hâlâ "aynı ürün", sadece yeniden bölünmüş.
    new_split = DeliverySplit(
        order_id=original.order_id,
        quantity=second_qty,
        start_date=mid_date,
        end_date=_add_workdays(mid_date, second_duration, holiday_days),
        manual_edit=True,
        created_by=current_user.id,
        is_outsourced=original.is_outsourced,
        param_overrides=dict(original.param_overrides) if original.param_overrides else None,
    )
    db.add(new_split)

    audit_original = AuditLog(
        entity_type="delivery_split",
        entity_id=original.id,
        action=AuditAction.SPLIT.value,
        old_value=old_values,
        new_value={
            "quantity": first_qty,
            "start_date": original.start_date.isoformat(),
            "end_date": mid_date.isoformat(),
            "ratio": body.ratio,
            "is_outsourced": original.is_outsourced,
        },
        performed_by=current_user.id,
    )
    db.add(audit_original)

    # Mark the order as explicitly split and store piece count in base_data
    order = await db.get(Order, original.order_id)
    if order:
        current_base_data = order.base_data or {}
        if isinstance(current_base_data, dict):
            new_base_data = dict(current_base_data)
            new_base_data["is_explicit_split"] = True
            # Count active splits after this operation (original + new = 2 total active minimum)
            active_count_result = await db.execute(
                select(DeliverySplit).where(
                    DeliverySplit.order_id == original.order_id,
                    DeliverySplit.is_deleted == False,  # noqa: E712
                )
            )
            active_count = len(active_count_result.scalars().all()) + 1  # +1 for new_split not yet committed
            new_base_data["split_piece_count"] = active_count
            order.base_data = new_base_data
            db.add(order)

        # BOM: bölünen sipariş bir alt ürün (bileşen) ise, ana siparişin Tedarik'i
        # artık bu bileşenin en geç biten parçasına kadar sürmeli — ana siparişin
        # kendi zamanlaması yeniden hesaplanıp kaydedilir. get_components_ready_at
        # yeni split'i (new_split) görebilsin diye önce flush edilir.
        if order.parent_order_id is not None:
            await db.flush()
            await _recompute_and_persist_bom_main_order(db, order.parent_order_id, current_user.id)

        # BOM: bölünen sipariş kendisi bir ANA sipariş ise (bileşen değilse) ve
        # bölünen split'in (original.id — bu 2'ye bölmede id değişmez, sadece
        # miktarı küçülür) bağlı bileşen split'leri varsa, onları da AYNI oranda
        # (first_qty/second_qty) ikiye böl — bkz. _sync_component_orders_for_main_split_replace.
        if order.parent_order_id is None:
            await db.flush()
            work_hours_for_sync = await _get_work_hours_per_day(db)
            work_minutes_for_sync = work_hours_for_sync * 60
            default_comp_emp = {"assembly": 1.0, "production": 1.0, "test": 1.0}
            new_main_segments = [
                (first_qty, original.start_date, original.id),
                (second_qty, mid_date, new_split.id),
            ]
            await _sync_component_orders_for_main_split_replace(
                db, order, original.id, original_qty,
                new_main_segments, current_user.id, holiday_days, work_minutes_for_sync, default_comp_emp,
            )
            # bkz. split-multi endpoint'indeki aynı çağrı/yorum — sync sonrası
            # oluşan yeni (orantılı miktarlı) bileşen split'lerine göre bu 2
            # segmentin end_date'i hâlâ ulaşılabilir mi diye kontrol edilir.
            await db.flush()
            split_warnings.extend(
                await _gate_new_main_segments_against_component_readiness(
                    db, [original.id, new_split.id], holiday_days, work_minutes_for_sync, default_comp_emp,
                )
            )

    await db.commit()
    await db.refresh(new_split)
    await db.refresh(original)

    # Audit log for new split
    audit_new = AuditLog(
        entity_type="delivery_split",
        entity_id=new_split.id,
        action=AuditAction.CREATE.value,
        old_value=None,
        new_value={
            "quantity": second_qty,
            "start_date": new_split.start_date.isoformat(),
            "end_date": new_split.end_date.isoformat(),
            "split_from": str(original.id),
            "is_outsourced": original.is_outsourced,
        },
        performed_by=current_user.id,
    )
    db.add(audit_new)

    result_data = {
        "message": f"Delivery split into two: {first_qty} + {second_qty}",
        "warnings": split_warnings,
        "original": {
            "id": f"split_{original.id}",
            "quantity": first_qty,
            "start_date": original.start_date.isoformat(),
            "end_date": original.end_date.isoformat(),
        },
        "new": {
            "id": f"split_{new_split.id}",
            "quantity": second_qty,
            "start_date": new_split.start_date.isoformat(),
            "end_date": new_split.end_date.isoformat(),
        },
    }

    # Publish SSE event to all connected clients
    await sse_manager.publish("TASK_SPLIT", {
        **result_data,
        "split_by": current_user.username,
    })

    return result_data


async def _derive_component_orders(
    db: AsyncSession,
    main_order: Order,
    product_name: str,
    quantity: float,
    start_dt: datetime,
    holiday_days: set[date],
    work_minutes: float,
    emp: dict[str, float],
    created_by,
    main_split_id: UUID,
    on_hand_map: dict[str, float] | None = None,
) -> datetime | None:
    """BOM'lu bir ana urun siparisi olusturulunca, urun katalogundaki alt urunler
    (ProductSubProduct) icin otomatik "bilesen siparisi" (Order, parent_order_id ile
    ana siparise bagli, Teslimat asamasi yok) turetir. Her bileseni kendi
    Tedarik->Dizgi->Uretim->Test hattinda ileri yonlu hesaplar. Donen deger en gec
    biten bilesenin bitis tarihidir (ana siparisin Uretim'inin en erken
    baslayabilecegi an) — hic bileseni yoksa None doner, cagiran kod hicbir sey
    degistirmez (BOM'suz urunler icin sifir davranis degisikligi).

    `on_hand_map` (ProductInfo.id -> elde zaten mevcut miktar) verilirse, ihtiyac
    duyulan miktardan (quantity * sub.quantity) dusulur — kalan <= 0 ise (tamami
    stoktan karsilaniyor) o bilesen icin AYRI BIR SIPARIS ACILMAZ, ama bilesen "an
    itibariyle hazir" sayilip start_dt component_ends'e eklenir: ana urun yine de
    kendi Dizgi'sini atlar (Dizgi = bilesenleri birlestirmek, bu hala gecerli —
    sadece bekleme suresi yok).
    """
    result = await db.execute(
        select(ProductInfo)
        .options(selectinload(ProductInfo.sub_products).selectinload(ProductSubProduct.sub_product))
        .where(func.lower(ProductInfo.product_name) == product_name.strip().lower())
    )
    main_product = result.scalar_one_or_none()
    if not main_product or not main_product.sub_products:
        return None

    component_ends: list[datetime] = []
    for sub in main_product.sub_products:
        sub_product = sub.sub_product
        needed_qty = quantity * sub.quantity
        on_hand = max(0.0, (on_hand_map or {}).get(str(sub_product.id), 0.0))
        component_qty = needed_qty - on_hand
        if component_qty <= 0:
            component_ends.append(start_dt)
            continue
        component_base_data = excel_service.build_order_base_data({
            "product_name": sub_product.product_name,
            "supply_days": sub_product.supply_days,
            "assembly_days": sub_product.assembly_days,
            "epoxy_minutes": sub_product.epoxy_minutes,
            "conformal_minutes": sub_product.conformal_minutes,
            "montaj_minutes": sub_product.montaj_minutes,
            "quality_minutes": sub_product.quality_minutes,
            "montaj_kalite_minutes": sub_product.montaj_kalite_minutes,
            "test1_minutes": sub_product.test1_minutes,
            "test2_minutes": sub_product.test2_minutes,
            "final_test_minutes": sub_product.final_test_minutes,
            "duration_mode": sub_product.duration_mode,
            "production_flat_days": sub_product.production_flat_days,
            "test_flat_days": sub_product.test_flat_days,
            "assembly_flat_days": sub_product.assembly_flat_days,
        })

        component_order = Order(
            # "-COMP-" ara eki KASTEN yok: bir siparişin alt ürün olup olmadığı zaten
            # ürün adından ve `parent_order_id` bağından anlaşılıyor, numarayı
            # gereksiz uzatıyordu. Bu metni ayrıştıran hiçbir yer yok — alt ürün
            # tespiti her yerde parent_order_id/component_product_id ile yapılır.
            external_id=f"{main_order.external_id}-{sub_product.product_name}"[:255],
            mapping_template_id=main_order.mapping_template_id,
            base_data=component_base_data,
            order_date=main_order.order_date,
            status=OrderStatus.PENDING.value,
            created_by=created_by,
            parent_order_id=main_order.id,
            component_product_id=sub_product.id,
        )
        db.add(component_order)
        await db.flush()

        component_product_params = _build_product_params(component_order)
        component_end = calculate_component_end_date(
            start_dt, component_qty, component_product_params, emp, work_minutes, holiday_days,
        )
        component_ends.append(component_end)

        component_split = DeliverySplit(
            order_id=component_order.id,
            quantity=needed_qty,
            on_hand_quantity=on_hand,
            start_date=start_dt,
            end_date=component_end,
            manual_edit=False,
            is_outsourced=False,
            created_by=created_by,
            source_main_split_id=main_split_id,
        )
        db.add(component_split)
        await db.flush()

    return max(component_ends) if component_ends else None


async def _rescale_component_split(
    db: AsyncSession,
    comp_split: DeliverySplit,
    new_qty: float,
    holiday_days: set[date],
    work_minutes: float,
    emp: dict[str, float],
) -> None:
    """Mevcut bir component split'in NOMİNAL miktarını (Teslimat Adedi) YENİ değere
    günceller — örn. bağlı ana siparişin miktarı değiştiği için bileşenin fiziksel
    ihtiyacı orantılı olarak değişti. `on_hand_quantity` (elde mevcut stok) buna
    dokunulmadan aynı kalır; end_date, efektif miktar (new_qty - on_hand_quantity)
    üzerinden hesaplanır. manual_edit değilse end_date'i calculate_component_end_date
    ile (start_date SABİT kalarak) yeniden hesaplar — component kendi hattında aynı
    noktadan başlamaya devam eder. manual_edit=True ise miktar yine güncellenir
    (fiziksel gerçek budur) ama tarihe dokunulmaz — _recompute_and_persist_bom_main_order'
    daki "manual_edit'e saygı" kuralıyla tutarlı."""
    comp_split.quantity = new_qty
    if comp_split.manual_edit:
        return
    comp_order = await db.get(Order, comp_split.order_id)
    if comp_order is None:
        return
    comp_product_params = _build_product_params(comp_order)
    effective_qty = max(new_qty - (comp_split.on_hand_quantity or 0.0), 0.0001)
    comp_split.end_date = calculate_component_end_date(
        comp_split.start_date, effective_qty, comp_product_params, emp, work_minutes, holiday_days,
    )
    # Miktar değişince eski özel program (varsa) geçersiz kalır — aynı gerekçe
    # order_details.py bulk-update'teki quantity dalında da uygulanıyor.
    comp_split.stage_schedule = None


async def _apply_component_on_hand(
    db: AsyncSession,
    comp_split: DeliverySplit,
    on_hand_qty: float,
    holiday_days: set[date],
    work_minutes: float,
    emp: dict[str, float],
) -> None:
    """Bir component split'in 'elde mevcut' stok miktarını ABSOLUTE olarak (üzerine
    yazarak, kümülatif DEĞİL) günceller. `quantity` (Teslimat Adedi — nominal ihtiyaç)
    ASLA değiştirilmez; efektif miktar her zaman split.quantity - on_hand_qty olarak
    baştan hesaplanır, bu yüzden ardışık çağrılar (5, sonra 1) birbirini yanlışlıkla
    bileştirmez — her çağrı en son girilen mutlak stok miktarını temsil eder.

    DİKKAT: burada `comp_split.manual_edit` kontrolüne BAKILMAZ (kasıtlı olarak
    kaldırıldı) — split-multi ile oluşturulan HER parça otomatik olarak
    manual_edit=True alır (bkz. split-multi endpoint'i), bu yüzden bir bileşen
    bölündükten SONRA parçalarından birine elde mevcut girmek eskiden sessizce
    hiçbir şey yapmıyordu (yalnızca on_hand_quantity sayısı kaydedilip end_date
    hiç güncellenmiyordu — RightPanel'de "Üretilecek" doğru düşse de Gantt/tarih
    hâlâ TAM miktar üretiliyormuş gibi görünüyordu). manual_edit koruması diğer
    yerlerde (tatil/işçi sayısı değişikliği gibi İLGİSİZ olaylar) kullanıcının
    elle sabitlediği bir tarihi ezmemek için var — ama burası TAM OLARAK o
    split'in kendisine yapılan, doğrudan bir düzenleme, "ilgisiz" bir olay değil."""
    comp_split.on_hand_quantity = on_hand_qty
    comp_order = await db.get(Order, comp_split.order_id)
    if comp_order is None:
        return
    comp_product_params = _build_product_params(comp_order)
    effective_qty = max(comp_split.quantity - on_hand_qty, 0.0001)
    comp_split.end_date = calculate_component_end_date(
        comp_split.start_date, effective_qty, comp_product_params, emp, work_minutes, holiday_days,
    )
    comp_split.stage_schedule = None


async def _create_linked_component_split(
    db: AsyncSession,
    comp_order: Order,
    quantity: float,
    start_date: datetime,
    source_main_split_id: UUID,
    template: DeliverySplit,
    performed_by,
    holiday_days: set[date],
    work_minutes: float,
    emp: dict[str, float],
    on_hand_quantity: float = 0.0,
) -> DeliverySplit:
    """Var olan bir component split'i (template) referans alarak — is_outsourced/
    param_overrides miras alınır — AYNI component order için YENİ, bağımsız bir
    split oluşturur ve belirtilen ana split'e (source_main_split_id) bağlar.
    end_date calculate_component_end_date ile, EFEKTİF miktar (quantity -
    on_hand_quantity) üzerinden hesaplanır (component'in kendi Tedarik->Dizgi->
    Uretim->Test hattı, Teslimat yok — bkz. _derive_component_orders). `quantity`
    kolonuna nominal miktar, `on_hand_quantity`'ye elde mevcut stok payı yazılır."""
    comp_product_params = _build_product_params(comp_order)
    effective_qty = max(quantity - on_hand_quantity, 0.0001)
    end_date = calculate_component_end_date(
        start_date, effective_qty, comp_product_params, emp, work_minutes, holiday_days,
    )
    new_split = DeliverySplit(
        order_id=comp_order.id,
        quantity=quantity,
        on_hand_quantity=on_hand_quantity,
        start_date=start_date,
        end_date=end_date,
        manual_edit=False,
        is_outsourced=template.is_outsourced,
        param_overrides=dict(template.param_overrides) if template.param_overrides else None,
        created_by=performed_by,
        source_main_split_id=source_main_split_id,
    )
    db.add(new_split)
    await db.flush()
    return new_split


async def _sync_component_orders_for_main_split_replace(
    db: AsyncSession,
    main_order: Order,
    replaced_main_split_id: UUID,
    original_main_qty: float,
    new_main_segments: list[tuple[float, datetime, UUID]],
    performed_by,
    holiday_days: set[date],
    work_minutes: float,
    emp: dict[str, float],
) -> None:
    """Ana siparişin BİR split'i (replaced_main_split_id, toplam miktarı
    original_main_qty) N yeni parçaya (new_main_segments: [(quantity, start_date,
    new_split_id), ...]) bölündüğünde, her BOM bileşen (component) order'ının BU
    ana split'e bağlı split'ini AYNI ORANDA N parçaya böler: eski bağlı split
    soft-delete edilir, her yeni ana segment için orantılı miktarda yeni bir
    component split oluşturulur (bkz. _create_linked_component_split). Yalnızca
    `main_order.parent_order_id is None` (yani gerçekten bir ANA sipariş) iken
    çağrılmalı. Bağlı component split bulunamazsa (legacy veri) o component order
    sessizce atlanır — hiçbir şey değiştirilmez."""
    if not original_main_qty:
        return
    comp_orders_result = await db.execute(
        select(Order).where(Order.parent_order_id == main_order.id, Order.is_deleted == False)  # noqa: E712
    )
    comp_orders = comp_orders_result.scalars().all()
    if not comp_orders:
        return

    for comp_order in comp_orders:
        linked_result = await db.execute(
            select(DeliverySplit).where(
                DeliverySplit.order_id == comp_order.id,
                DeliverySplit.source_main_split_id == replaced_main_split_id,
                DeliverySplit.is_deleted == False,  # noqa: E712
            )
        )
        old_comp_split = linked_result.scalar_one_or_none()
        if old_comp_split is None:
            continue

        old_comp_qty = old_comp_split.quantity
        old_on_hand = old_comp_split.on_hand_quantity or 0.0
        old_comp_split.is_deleted = True
        old_comp_split.deleted_at = datetime.now(timezone.utc)

        # Elde mevcut stoğu, en erken başlayan yeni parçadan başlayarak FIFO
        # (önce-önce) dağıt: erken parça kendi ihtiyacına kadar stoğun tamamını
        # önce tüketir, kalanı sıradaki (daha geç başlayan) parçaya aktarılır.
        remaining_on_hand = old_on_hand
        on_hand_by_split_id: dict[UUID, float] = {}
        for seg_qty, seg_start, new_split_id in sorted(new_main_segments, key=lambda s: s[1]):
            comp_seg_qty = round(old_comp_qty * (seg_qty / original_main_qty), 2)
            allocated = min(remaining_on_hand, comp_seg_qty)
            on_hand_by_split_id[new_split_id] = allocated
            remaining_on_hand -= allocated

        for seg_qty, seg_start, new_split_id in new_main_segments:
            comp_seg_qty = round(old_comp_qty * (seg_qty / original_main_qty), 2)
            await _create_linked_component_split(
                db, comp_order, comp_seg_qty, seg_start, new_split_id,
                old_comp_split, performed_by, holiday_days, work_minutes, emp,
                on_hand_quantity=on_hand_by_split_id[new_split_id],
            )


async def _gate_new_main_segments_against_component_readiness(
    db: AsyncSession,
    new_segment_ids: list[UUID],
    holiday_days: set[date],
    work_minutes: float,
    emp: dict[str, float],
) -> list[str]:
    """Bir BOM ana siparişi parçalara bölündüğünde, `split-multi` endpoint'i her
    yeni segmentin start/end'ini, sync ÇAĞRILMADAN ÖNCEKİ (eski, tam miktarlı)
    bileşen split'lerine göre hesaplar — ama sync (`_sync_component_orders_for_main_split_replace`)
    hemen ardından her segment için YENİ, orantılı miktarlı bileşen split'leri
    oluşturur ve bunların GERÇEK bitiş tarihi ilk hesaptan FARKLI olabilir (küçük
    miktarlı bir bileşen segmenti, orijinal tam-miktarlı halinden daha erken/geç
    bitebilir). Bu fonksiyon, sync TAMAMLANDIKTAN SONRA çağrılmalı: her yeni ana
    segmentin KENDİSİNE bağlı (source_main_split_id ile eşleşen) taze bileşen
    bitiş tarihini okuyup, girilen end_date bununla uyumsuzsa (bileşenler daha
    geç bitiyorsa) end_date'i gerçek değere uzatır ve kullanıcıya gösterilecek bir
    uyarı metni döner.

    `_recompute_and_persist_bom_main_order` (holiday/worker-count gibi SONRADAN
    gelen değişikliklerde kullanılır) BİLEREK manual_edit=True olan split'lere
    dokunmaz — burada durum farklı: yeni segmentler split-multi tarafından zaten
    manual_edit=True ile oluşturuluyor (kullanıcı tarih girdiği için), ama bu
    ayarlama kullanıcının AYRI bir sonraki düzenlemesi değil, AYNI isteğin ilk
    hesabını TAMAMLIYOR — dolayısıyla burada manual_edit kontrolüne bakılmaz.
    """
    warnings: list[str] = []
    if not new_segment_ids:
        return warnings
    ready_at_by_split = await get_components_ready_at_by_split_map(db, new_segment_ids)
    if not ready_at_by_split:
        return warnings
    for split_id in new_segment_ids:
        component_ready_at = ready_at_by_split.get(split_id)
        if component_ready_at is None:
            continue
        split = await db.get(DeliverySplit, split_id)
        if split is None:
            continue
        order_for_split = await db.get(Order, split.order_id)
        product_params = effective_product_params(order_for_split.base_data, split.param_overrides)
        blocks = calculate_split_stage_ranges(
            end_date=split.end_date,
            quantity=split.quantity,
            product_params=product_params,
            emp=emp,
            work_minutes=work_minutes,
            holidays=holiday_days,
            is_outsourced=bool(split.is_outsourced),
            component_ready_at=component_ready_at,
            start_date=split.start_date,
        )
        delivery_block = next((b for b in blocks if b["key"] == "delivery"), None)
        supply_block = next((b for b in blocks if b["key"] == "supply"), None)
        if delivery_block is not None and delivery_block["end"] != split.end_date:
            warnings.append(
                f"{split.quantity:.0f} adetlik parça için girilen bitiş tarihi "
                f"({split.end_date.date()}) bileşenlerin hazır olma tarihiyle "
                f"uyumsuz olduğundan {delivery_block['end'].date()} tarihine uzatıldı."
            )
            split.end_date = delivery_block["end"]
        if supply_block is not None and supply_block["start"] != split.start_date:
            split.start_date = supply_block["start"]
    return warnings


async def _close_bom_idle_gap(
    db: AsyncSession,
    main_split: DeliverySplit,
    component_ready_at: datetime,
    blocks: list[dict],
    holiday_days: set[date],
    work_minutes: float,
    emp: dict[str, float],
    performed_by: UUID,
) -> datetime | None:
    """Bilesenler, ana urunun Uretim'inin baslamasi gerekenden DAHA ERKEN bitiyorsa
    aradaki bos zamani kapatir: bilesen parcalarini, en gec biteni tam da Uretim'in
    basladigi gune denk gelecek sekilde ILERI kaydirir.

    Neden: sistemin verdigi plan "en gec ne zaman baslarsam yetistiririm" bilgisidir.
    Bir alt urune elde-mevcut girilince (ya da adet dusurulunce) bilesen hatti kisalir;
    Uretim/Test/Teslimat ise teslim tarihinden GERIYE turetildigi icin yerinde kalir.
    Sonuc: Tedarik erken biter, sonra hicbir adimin olmadigi bos bir aralik, sonra
    Uretim. Kullanicinin gordugu "ana urunun adimlari yok" sikayeti buydu.

    Bitis tarihi (teslim taahhudu) KASITLI OLARAK sabit tutulur — degisen yalnizca
    baslangictir. Erken baslamak gercek hayatta kullanicinin tercihi; sistemin
    soylemesi gereken sey en gec baslama tarihidir.

    Donus: guncellenmis component_ready_at (degisiklik olmadiysa None).
    """
    post_assembly = [b for b in blocks if b["key"] not in ("supply", "assembly")]
    if not post_assembly:
        return None
    target_ready = post_assembly[0]["start"]
    if component_ready_at >= target_ready:
        # Bilesenler zaten Uretim'e yetisemiyor ya da tam zamaninda bitiyor —
        # bu durum yukarida (calculate_split_stage_ranges) ileri kaydirma ile
        # zaten ele aliniyor, burada yapacak bir sey yok.
        return None

    # Kaydirma miktari IS GUNU cinsinden olculur (takvim gunu degil): araya hafta
    # sonu/tatil girdiginde takvim farki gercek is yukunu yansitmaz.
    gap_workdays = 0
    cursor = component_ready_at
    while cursor < target_ready:
        if _is_workday(cursor.date(), holiday_days):
            gap_workdays += 1
        cursor += timedelta(days=1)
    if gap_workdays <= 0:
        return None

    comp_result = await db.execute(
        select(DeliverySplit)
        .join(Order, Order.id == DeliverySplit.order_id)
        .where(
            DeliverySplit.source_main_split_id == main_split.id,
            DeliverySplit.is_deleted == False,  # noqa: E712
            Order.is_deleted == False,  # noqa: E712
        )
        .options(selectinload(DeliverySplit.order))
    )
    comp_splits = list(comp_result.scalars().all())
    if not comp_splits:
        return None

    moved = False
    new_component_starts: list[datetime] = []
    for comp in comp_splits:
        # Elle sabitlenmis bilesen parcasi kaydirilmaz — kullanicinin kararina
        # saygi (ana split'teki manual_edit kuralinin aynisi). Bu durumda bosluk
        # tamamen kapanmayabilir; bu bilincli bir odundur.
        if comp.manual_edit:
            continue
        comp_order = comp.order or await db.get(Order, comp.order_id)
        if comp_order is None:
            continue
        # _add_workdays N is gunu TUKETIR ama sonucu is gunune yuvarlamaz —
        # hafta sonuna/tatile denk gelebilir. Kaydedilen start_date bir tatil
        # gunu olursa Gantt'ta bar yanlis gunden basliyormus gibi gorunur
        # (hesap dogru kalir, cunku ileri yonlu hesaplar zaten ilk is gunune
        # atliyor) — bu yuzden burada acikca ileri hizalanir.
        new_start = _add_workdays(comp.start_date, gap_workdays, holiday_days)
        while not _is_workday(new_start.date(), holiday_days):
            new_start += timedelta(days=1)
        comp_params = _build_product_params(comp_order)
        effective_qty = max(comp.quantity - (comp.on_hand_quantity or 0.0), 0.0001)
        comp.start_date = new_start
        comp.end_date = calculate_component_end_date(
            new_start, effective_qty, comp_params, emp, work_minutes, holiday_days,
        )
        # Kaydirilan parcanin eski ozel takvimi artik yanlis tarihleri gosterir.
        comp.stage_schedule = None
        new_component_starts.append(new_start)
        moved = True

    if not moved:
        return None

    # Ana siparisin Tedarik'i bilesenlerle PARALEL calisir ve onlarla AYNI GUN
    # baslar (bkz. _derive_component_orders: bilesenler main split'in start_dt'si
    # ile olusturulur). Bu yuzden ana baslangic, bilesenlerin YENI baslangicindan
    # TURETILIR — ana split'in o anki start_date'i uzerine ayni delta EKLENMEZ.
    #
    # Neden onemli: bu fonksiyon calismadan once baska bir blok (order_details.py
    # splits_needing_start_recalc) ana split'in start_date'ini zaten geriye-dogru
    # yeniden hesaplamis olabilir. O durumda delta'yi bir de onun uzerine eklemek
    # kaydirmayi IKI KEZ uygular ve baslangic bitis tarihinin bile otesine gecer
    # (canli olarak goruldu: 02.11 -> 09.12 -> 11.01.2027). Bilesenlerin yeni
    # baslangicini esas almak bu sirali-etki sorununu tamamen ortadan kaldirir.
    old_main_start = main_split.start_date
    main_split.start_date = min(new_component_starts)

    await db.flush()
    new_ready = await get_component_ready_at_for_split(db, main_split.id)
    db.add(AuditLog(
        entity_type="delivery_split",
        entity_id=main_split.id,
        action=AuditAction.UPDATE.value,
        old_value={
            "component_ready_at": component_ready_at.isoformat(),
            "start_date": old_main_start.isoformat(),
        },
        new_value={
            "component_ready_at": (new_ready or component_ready_at).isoformat(),
            "start_date": main_split.start_date.isoformat(),
            "reason": "bom_idle_gap_closed",
            "shifted_workdays": gap_workdays,
        },
        performed_by=performed_by,
    ))
    return new_ready


async def _recompute_and_persist_bom_main_order(db: AsyncSession, main_order_id: UUID, performed_by: UUID) -> None:
    """Bir BOM ana siparişinin bileşenlerinden biri değişince (parçalı teslimata
    bölünmesi, tarihinin değişmesi, bir parçasının silinmesi vb.) bu fonksiyon
    çağrılmalı: ana siparişin KENDİ DeliverySplit'ini (component_ready_at'in artık
    daha geç — ya da daha erken — olabileceğini varsayarak) yeniden hesaplayıp
    GERÇEKTEN KAYDEDER.

    Neden gerekli: /gantt/tasks ve önizleme ekranının zaman çizelgesi zaten HER
    İSTEKTE component_ready_at'i taze hesaplayıp Üretim/Test/Teslimat'ı buna göre
    kaydırıyor (bkz. calculate_split_stage_ranges) — ama bu SADECE EKRANDAKİ
    GÖSTERİMİ düzeltir. DeliverySplit.end_date DB'de eski kalırsa Excel'e aktarım,
    aylık efor toplamı, promised_date karşılaştırması gibi DOĞRUDAN DB okuyan
    yerler yanlış/eksik kalır. Promised_date'e (kullanıcının orijinal taahhüdü)
    KASITLI OLARAK dokunulmaz — sadece hesaplanan end_date kayar.
    """
    result = await db.execute(
        select(Order)
        .where(Order.id == main_order_id, Order.is_deleted == False)  # noqa: E712
        .options(selectinload(Order.delivery_splits))
    )
    main_order = result.scalar_one_or_none()
    if main_order is None:
        return
    active_splits = [s for s in main_order.delivery_splits if not s.is_deleted]
    if not active_splits:
        return

    # Parça-bazlı gating: her split, YALNIZCA KENDİSİNE (source_main_split_id ile)
    # bağlı bileşen split'lerinin bitişine göre gate'lenir — bağlantısı olmayan
    # (legacy) split'ler eski sipariş-geneli (TÜM bileşenlerin global MAX'ı) davranışa
    # düşer. Bkz. get_components_ready_at_by_split_map/get_components_ready_at.
    component_ready_at_by_split = await get_components_ready_at_by_split_map(
        db, [s.id for s in active_splits]
    )
    order_level_component_ready_at = await get_components_ready_at(db, main_order_id)
    if not component_ready_at_by_split and order_level_component_ready_at is None:
        return

    holiday_days = await _get_holiday_days(db)
    work_hours = await _get_work_hours_per_day(db)
    work_minutes = work_hours * 60
    default_emp = {"assembly": 1.0, "production": 1.0, "test": 1.0}
    product_params = _build_product_params(main_order)

    for split in active_splits:
        component_ready_at = component_ready_at_by_split.get(split.id) or order_level_component_ready_at
        if component_ready_at is None:
            continue
        recomputed_blocks = calculate_split_stage_ranges(
            end_date=split.end_date,
            quantity=split.quantity,
            product_params=product_params,
            emp=default_emp,
            work_minutes=work_minutes,
            holidays=holiday_days,
            is_outsourced=bool(split.is_outsourced),
            component_ready_at=component_ready_at,
            start_date=split.start_date,
        )

        # Bilesenler Uretim'in baslamasi gerekenden erken bitiyorsa (ör. bir alt
        # urune elde-mevcut girildi, adet dusuruldu) aradaki bos aralik kapatilir:
        # bilesenler ileri kaydirilir, bitis tarihi SABIT kalir.
        #
        # Kapi `manual_edit` DEGIL `stage_schedule`: manual_edit "tarihler bir insan
        # tarafindan belirlendi" demektir ve "Teslimat Ekle" ile olusturulan HER
        # siparis onu True alir (bkz. create_manual_task) — o kapiya baglansaydi
        # duzeltme neredeyse hicbir sipariste calismazdi. Kullanicinin "Özel Program"
        # dedigi sey ise zaman cizelgesini elle duzenlemektir; ekranda da bu
        # `stage_schedule` uzerinden gosterilir (bkz. order_details.py
        # has_custom_schedule). Elle duzenlenmis bir cizelge kaydirilmaz.
        if split.stage_schedule is None:
            new_ready = await _close_bom_idle_gap(
                db, split, component_ready_at, recomputed_blocks,
                holiday_days, work_minutes, default_emp, performed_by,
            )
            if new_ready is not None:
                component_ready_at = new_ready
                recomputed_blocks = calculate_split_stage_ranges(
                    end_date=split.end_date,
                    quantity=split.quantity,
                    product_params=product_params,
                    emp=default_emp,
                    work_minutes=work_minutes,
                    holidays=holiday_days,
                    is_outsourced=bool(split.is_outsourced),
                    component_ready_at=component_ready_at,
                    start_date=split.start_date,
                )

        delivery_block = next((b for b in recomputed_blocks if b["key"] == "delivery"), None)
        supply_block = next((b for b in recomputed_blocks if b["key"] == "supply"), None)

        if split.manual_edit:
            # Kullanıcı bu parçayı Gantt'ta elle sabitlemiş (manual_edit=True) —
            # bir bileşenin tarihi değişip fiziksel olarak çakışsa bile bu tarihi
            # SESSİZCE EZMEYİZ (kullanıcının kararına saygı). Yalnızca çakışmayı
            # audit log'a not düşeriz; kullanıcı Audit Log sayfasından görüp
            # gerekirse elle çözer.
            conflicts: dict[str, dict[str, str]] = {}
            if delivery_block is not None and delivery_block["end"] != split.end_date:
                conflicts["end_date"] = {
                    "current": split.end_date.isoformat(),
                    "would_be": delivery_block["end"].isoformat(),
                }
            if supply_block is not None and supply_block["start"] != split.start_date:
                conflicts["start_date"] = {
                    "current": split.start_date.isoformat(),
                    "would_be": supply_block["start"].isoformat(),
                }
            if conflicts:
                db.add(AuditLog(
                    entity_type="delivery_split",
                    entity_id=split.id,
                    action=AuditAction.UPDATE.value,
                    old_value=None,
                    new_value={
                        "reason": "bom_component_schedule_conflict_manual_edit_kept",
                        "component_ready_at": component_ready_at.isoformat(),
                        "conflicts": conflicts,
                    },
                    performed_by=performed_by,
                ))
            continue

        if delivery_block is not None and delivery_block["end"] != split.end_date:
            old_end = split.end_date
            split.end_date = delivery_block["end"]
            db.add(AuditLog(
                entity_type="delivery_split",
                entity_id=split.id,
                action=AuditAction.UPDATE.value,
                old_value={"end_date": old_end.isoformat()},
                new_value={
                    "end_date": split.end_date.isoformat(),
                    "reason": "bom_component_schedule_changed",
                    "component_ready_at": component_ready_at.isoformat(),
                },
                performed_by=performed_by,
            ))

        # Tedarik (supply) bloğunun başlangıcı da component_ready_at'e göre kaymış
        # olabilir (bkz. calculate_split_stage_ranges'teki supply uzatma mantığı) —
        # yalnızca end_date güncellenip start_date eski kalırsa, ana siparişin Gantt'ta
        # gösterilen başlangıcı (bkz. min(split.start_date)) gerçek Tedarik barından sapar.
        if supply_block is not None and supply_block["start"] != split.start_date:
            old_start = split.start_date
            split.start_date = supply_block["start"]
            db.add(AuditLog(
                entity_type="delivery_split",
                entity_id=split.id,
                action=AuditAction.UPDATE.value,
                old_value={"start_date": old_start.isoformat()},
                new_value={
                    "start_date": split.start_date.isoformat(),
                    "reason": "bom_component_schedule_changed",
                    "component_ready_at": component_ready_at.isoformat(),
                },
                performed_by=performed_by,
            ))


@router.post(
    "/tasks",
    response_model=GanttTaskOut,
    status_code=status.HTTP_201_CREATED,
    summary="Manually create a new delivery",
)
async def create_manual_task(
    body: GanttManualCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> GanttTaskOut:
    """
    Create a new Order and a primary DeliverySplit manually.
    Satisfies 'Teslimat Ekle' (Add Delivery) feature.
    """
    try:
        holiday_days = await _get_holiday_days(db)

        # Parse dates
        try:
            start_dt = datetime.fromisoformat(body.start_date.replace("Z", "+00:00"))
            end_dt = datetime.fromisoformat(body.end_date.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Invalid date format. Use ISO 8601.",
            )

        if end_dt <= start_dt:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="end_date must be after start_date",
            )

        # Ensure mapping template exists
        tpl_result = await db.execute(select(MappingTemplate).limit(1))
        template = tpl_result.scalar_one_or_none()
        if not template:
            template = MappingTemplate(
                name="System Default",
                column_map={},
                created_by=current_user.id,
            )
            db.add(template)
            await db.flush()

        # Build compact operational base_data. Fason (dış dizgi) siparişlerde girilen
        # outsource_days'in gerçek zamanlama alanı olan assembly_days'e dönüştürülmesi
        # build_order_base_data içinde merkezi olarak yapılır (bkz. o fonksiyondaki
        # yorum) — Excel içe aktarma ile aynı kuralı kullanır.
        base_data = excel_service.build_order_base_data({
            "product_name": body.text,
            "customer_name": body.customer_name,
            "responsible_personnel": body.responsible_personnel,
            "order_date": body.order_date,
            "promised_date": body.promised_date,
            "requirement_date": body.requirement_date,
            "penalty_date": body.penalty_date,
            "is_outsourced": body.is_outsourced,
            "outsource_days": body.outsource_days,
            "supply_days": body.supply_days,
            "production_days": body.production_days,
            "assembly_days": body.assembly_days if body.assembly_days is not None else body.production_days,
            "epoxy_minutes": body.epoxy_minutes,
            "conformal_minutes": body.conformal_minutes,
            "montaj_minutes": body.montaj_minutes,
            "quality_minutes": body.quality_minutes,
            "montaj_kalite_minutes": body.montaj_kalite_minutes,
            "test1_minutes": body.test1_minutes,
            "test2_minutes": body.test2_minutes,
            "final_test_minutes": body.final_test_minutes,
            "delivery_days": body.delivery_days,
            "duration_mode": body.duration_mode,
            "production_flat_days": body.production_flat_days,
            "test_flat_days": body.test_flat_days,
            "assembly_flat_days": body.assembly_flat_days,
        })

        # Validate required scheduling fields
        missing = excel_service.get_missing_required_fields(base_data)
        if missing:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="; ".join(missing),
            )

        # Create Order
        new_order = Order(
            # Kullanıcı Sipariş No'yu boş bıraktıysa "MANUAL-<zaman damgası>" gibi
            # teknik bir kod yerine sade "?" yazılır — atanmamış bir sipariş no
            # olduğunu gösteren okunur bir yer tutucu.
            external_id=body.external_id or "?",
            mapping_template_id=template.id,
            base_data=base_data,
            customer_name=body.customer_name,
            responsible_personnel=body.responsible_personnel,
            order_date=datetime.fromisoformat(body.order_date).date() if body.order_date else None,
            # Söz verilen tarih hiç girilmemişse (frontend normalde bunu teslimat
            # tarihiyle otomatik dolduruyor, ama API doğrudan da çağrılabilir) bu
            # alan boş kalmasın diye kullanıcının girdiği teslimat tarihi kullanılır.
            promised_date=datetime.fromisoformat(body.promised_date).date() if body.promised_date else end_dt.date(),
            requirement_date=datetime.fromisoformat(body.requirement_date).date() if body.requirement_date else None,
            penalty_date=datetime.fromisoformat(body.penalty_date).date() if body.penalty_date else None,
            status=OrderStatus.PENDING.value,
            created_by=current_user.id,
        )
        db.add(new_order)
        await db.flush()

        # Create initial DeliverySplit
        initial_split = DeliverySplit(
            order_id=new_order.id,
            quantity=body.quantity,
            start_date=start_dt,
            end_date=end_dt,
            manual_edit=True,
            is_outsourced=bool(body.is_outsourced),
            created_by=current_user.id,
        )
        db.add(initial_split)
        await db.flush()

        # BOM: eger urunun katalogda kayitli alt urunleri varsa, onlar icin otomatik
        # "bilesen siparisi" turet ve ana siparisin Dizgi'sini atlayip Uretim'ini
        # bilesenlerin bitisine gore (gerekirse ileri kaydirarak) yeniden hesapla.
        # BOM'suz urunlerde components_ready_at hep None doner, hicbir sey degismez.
        work_hours = await _get_work_hours_per_day(db)
        work_minutes = work_hours * 60
        default_emp = {"assembly": 1.0, "production": 1.0, "test": 1.0}
        components_ready_at = await _derive_component_orders(
            db, new_order, body.text, body.quantity, start_dt, holiday_days,
            work_minutes, default_emp, current_user.id, initial_split.id,
            on_hand_map=body.sub_product_on_hand,
        )
        if components_ready_at is not None:
            main_product_params = _build_product_params(new_order)
            recomputed_blocks = calculate_split_stage_ranges(
                end_dt, body.quantity, main_product_params, default_emp, work_minutes, holiday_days,
                is_outsourced=bool(body.is_outsourced), component_ready_at=components_ready_at,
                start_date=start_dt,
            )
            delivery_block = next((b for b in recomputed_blocks if b["key"] == "delivery"), None)
            if delivery_block is not None and delivery_block["end"] != initial_split.end_date:
                initial_split.end_date = delivery_block["end"]
                end_dt = delivery_block["end"]
                await db.flush()

        # Audit logs
        db.add(
            AuditLog(
                entity_type="order",
                entity_id=new_order.id,
                action=AuditAction.CREATE.value,
                old_value=None,
                new_value={"external_id": new_order.external_id, "base_data": new_order.base_data},
                performed_by=current_user.id,
            )
        )
        db.add(
            AuditLog(
                entity_type="delivery_split",
                entity_id=initial_split.id,
                action=AuditAction.CREATE.value,
                old_value=None,
                new_value={"quantity": body.quantity, "start_date": start_dt.isoformat(), "end_date": end_dt.isoformat()},
                performed_by=current_user.id,
            )
        )

        await db.flush()
        await db.refresh(new_order)
        await db.refresh(initial_split)
        await db.commit()

        # Build response for created split
        product_params = _build_product_params(new_order)
        task_out = GanttTaskOut(
            id=f"split_{initial_split.id}",
            text=f"{body.text} — {initial_split.quantity:.0f} adet",
            start_date=initial_split.start_date.isoformat(),
            end_date=initial_split.end_date.isoformat(),
            duration=_calc_duration(initial_split.start_date, initial_split.end_date, holiday_days),
            parent=f"order_{initial_split.order_id}",
            type="task",
            manual_edit=initial_split.manual_edit,
            quantity=initial_split.quantity,
            is_outsourced=body.is_outsourced,
            customer_name=body.customer_name,
            responsible_personnel=body.responsible_personnel,
            order_date=body.order_date,
            promised_date=body.promised_date,
            requirement_date=body.requirement_date,
            penalty_date=body.penalty_date,
            **product_params,
            created_by_username=current_user.username,
        )

        await sse_manager.publish("TASK_CREATED", {
            "task": task_out.model_dump(),
            "created_by": current_user.username,
        })

        return task_out
    except Exception as e:
        await db.rollback()
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Backend Error: {type(e).__name__}: {str(e)}",
        )


@router.delete(
    "/tasks/{task_id}",
    summary="Delete a delivery split",
)
async def delete_gantt_task(
    task_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> dict:
    """Soft-delete a delivery split task and publish realtime update."""
    if task_id.startswith("split_fake_"):
        order_id = task_id.replace("split_fake_", "")
        try:
            order_uuid = UUID(order_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid task ID format",
            )

        order_result = await db.execute(
            select(Order).where(
                Order.id == order_uuid,
                Order.is_deleted == False,  # noqa: E712
            )
        )
        order = order_result.scalar_one_or_none()
        if not order:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Order not found",
            )

        _set_auto_delivery_suppressed(order, True)
        order.is_deleted = True
        deleted_at_fake = datetime.now(timezone.utc)
        order.deleted_at = deleted_at_fake

        # BOM: bu siparişin (varsa) alt ürün bileşenlerini de sil — aksi halde
        # ana sipariş silindikten sonra bileşenler is_deleted=False kalıp Gantt/adım
        # takviminde "yetim" olarak görünmeye devam eder.
        deleted_component_count = await cascade_soft_delete_components(db, order.id, deleted_at_fake)

        db.add(
            AuditLog(
                entity_type="order",
                entity_id=order.id,
                action=AuditAction.DELETE.value,
                old_value={"source": task_id, "auto_delivery_suppressed": False, "is_deleted": False},
                new_value={
                    "auto_delivery_suppressed": True,
                    "is_deleted": True,
                    "deleted_component_count": deleted_component_count,
                },
                performed_by=current_user.id,
            )
        )

        # BOM: silinen sipariş kendisi bir alt ürüne (bileşene) aitse, ana siparişin
        # component_ready_at'i artık bu bileşen olmadan hesaplanmalı (get_components_ready_at
        # is_deleted=False filtresi sayesinde bu bileşeni artık saymayacak) — aksi halde
        # ana siparişin tarihi var olmayan bir bileşene göre bayat kalır.
        if order.parent_order_id is not None:
            await db.flush()
            await _recompute_and_persist_bom_main_order(db, order.parent_order_id, current_user.id)

        await db.commit()

        await sse_manager.publish("TASK_DELETED", {
            "task_id": task_id,
            "deleted_by": current_user.username,
        })

        return {
            "message": "Main delivery removed",
            "task_id": task_id,
        }

    if not task_id.startswith("split_"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only delivery split tasks can be deleted",
        )

    # accept optional stage suffix: split_<uuid> or split_<uuid>_<stage>
    remainder = task_id.replace("split_", "")
    parts = remainder.split("_")
    split_id = parts[0]
    try:
        split_uuid = UUID(split_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid task ID format",
        )

    result = await db.execute(
        select(DeliverySplit).where(
            DeliverySplit.id == split_uuid,
            DeliverySplit.is_deleted == False,  # noqa: E712
        )
    )
    split = result.scalar_one_or_none()
    if not split:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Delivery split not found",
        )

    sibling_result = await db.execute(
        select(DeliverySplit).where(
            DeliverySplit.order_id == split.order_id,
            DeliverySplit.is_deleted == False,  # noqa: E712
        )
    )
    active_splits = sibling_result.scalars().all()

    deleted_at = datetime.now(timezone.utc)

    # Only delete the single requested split, not all siblings
    split.is_deleted = True
    split.deleted_at = deleted_at

    old_vals = {
        "quantity": split.quantity,
        "start_date": split.start_date.isoformat(),
        "end_date": split.end_date.isoformat(),
        "manual_edit": split.manual_edit,
    }
    db.add(
        AuditLog(
            entity_type="delivery_split",
            entity_id=split.id,
            action=AuditAction.DELETE.value,
            old_value=old_vals,
            new_value={"is_deleted": True, "deleted_at": deleted_at.isoformat()},
            performed_by=current_user.id,
        )
    )

    # If this was the last remaining active split, suppress auto-delivery
    remaining = [s for s in active_splits if s.id != split.id]
    if not remaining:
        order_result = await db.execute(
            select(Order).where(Order.id == split.order_id).options(selectinload(Order.serial_numbers))
        )
        order = order_result.scalar_one_or_none()
        if order:
            previous_suppressed = bool((order.base_data or {}).get("_auto_delivery_suppressed", False))
            was_order_deleted = order.is_deleted

            _set_auto_delivery_suppressed(order, True)
            order.is_deleted = True
            order.deleted_at = deleted_at

            # BOM: bu siparişin (varsa) alt ürün bileşenlerini de sil — aksi halde
            # ana sipariş silindikten sonra bileşenler is_deleted=False kalıp
            # Gantt/adım takviminde "yetim" olarak görünmeye devam eder.
            deleted_component_count = await cascade_soft_delete_components(db, order.id, deleted_at)

            db.add(
                AuditLog(
                    entity_type="order",
                    entity_id=order.id,
                    action=AuditAction.DELETE.value,
                    old_value={
                        "source": task_id,
                        "auto_delivery_suppressed": previous_suppressed,
                        "is_deleted": was_order_deleted,
                    },
                    new_value={
                        "auto_delivery_suppressed": True,
                        "is_deleted": True,
                        "deleted_at": deleted_at.isoformat(),
                        "deleted_component_count": deleted_component_count,
                    },
                    performed_by=current_user.id,
                )
            )

            # BOM: silinen siparişin son parçası kendisi bir alt ürüne (bileşene)
            # aitse, ana siparişin component_ready_at'i bu bileşen artık is_deleted=True
            # olduğu için değişmiş olabilir (bkz. "remaining" dalındaki aynı çağrı) —
            # bu dal olmadan ana sipariş, artık var olmayan bir bileşene göre bayat kalırdı.
            if order.parent_order_id is not None:
                await db.flush()
                await _recompute_and_persist_bom_main_order(db, order.parent_order_id, current_user.id)

    # Decrement split_piece_count in order base_data
    if remaining:
        # Still has remaining pieces: just decrement counter
        order_result = await db.execute(
            select(Order).where(Order.id == split.order_id)
        )
        order = order_result.scalar_one_or_none()
        if order:
            current_base_data = order.base_data or {}
            if isinstance(current_base_data, dict):
                new_base_data = dict(current_base_data)
                current_count = int(new_base_data.get("split_piece_count", len(active_splits)))
                new_base_data["split_piece_count"] = max(1, current_count - 1)
                new_base_data["is_explicit_split"] = True
                order.base_data = new_base_data
                db.add(order)

            # BOM: silinen parça bir alt ürüne (bileşene) aitse, ana siparişin
            # Tedarik/Üretim'i bu bileşenin artık daha erken bitebilecek olmasına
            # göre yeniden hesaplanıp kaydedilir.
            if order.parent_order_id is not None:
                await db.flush()
                await _recompute_and_persist_bom_main_order(db, order.parent_order_id, current_user.id)
            elif order.parent_order_id is None:
                # BOM: silinen parça bir ANA siparişin (bileşen değil) parçasıysa,
                # bu parçaya bağlı (source_main_split_id ile eşleşen) bileşen
                # parçaları da soft-delete edilir — aksi halde "sahipsiz" bir
                # bileşen üretimi kalırdı (bkz. cascade_soft_delete_linked_component_splits).
                await cascade_soft_delete_linked_component_splits(db, split.id, deleted_at)

    await db.commit()

    await sse_manager.publish("TASK_DELETED", {
        "task_id": task_id,
        "order_id": str(split.order_id),
        "deleted_split_ids": [str(split.id)],
        "deleted_by": current_user.username,
    })

    return {
        "message": "Delivery split deleted",
        "task_id": task_id,
        "order_id": str(split.order_id),
        "deleted_split_ids": [str(split.id)],
    }


@router.post(
    "/tasks/{task_id}/restore",
    summary="Restore a previously deleted delivery task",
)
async def restore_gantt_task(
    task_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> dict:
    """Restore soft-deleted split tasks or suppressed split_fake main deliveries."""
    if task_id.startswith("split_fake_"):
        order_id = task_id.replace("split_fake_", "")
        try:
            order_uuid = UUID(order_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid task ID format",
            )

        order_result = await db.execute(
            select(Order).where(
                Order.id == order_uuid,
            )
        )
        order = order_result.scalar_one_or_none()
        if not order:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Order not found",
            )

        _set_auto_delivery_suppressed(order, False)
        order_deleted_at_for_restore = order.deleted_at
        order.is_deleted = False
        order.deleted_at = None

        # BOM: bu sipariş silinirken bileşenleri de cascade ile silinmiş olabilir
        # (bkz. cascade_soft_delete_components) — geri alırken onları da (yalnızca
        # AYNI silme işleminde silinmiş olanları) geri getir, aksi halde bileşenler
        # kalıcı olarak "silinmiş" kalıp Gantt/adım takviminde kayıp gibi görünür.
        await cascade_restore_components(db, order.id, order_deleted_at_for_restore)

        db.add(
            AuditLog(
                entity_type="order",
                entity_id=order.id,
                action=AuditAction.UPDATE.value,
                old_value={"source": task_id, "auto_delivery_suppressed": True, "is_deleted": True},
                new_value={"auto_delivery_suppressed": False, "is_deleted": False},
                performed_by=current_user.id,
            )
        )

        await db.commit()

        await sse_manager.publish("TASK_UPDATED", {
            "task_id": task_id,
            "updated_by": current_user.username,
            "action": "restore",
        })

        return {
            "message": "Main delivery restored",
            "task_id": task_id,
        }

    if not task_id.startswith("split_"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only delivery split tasks can be restored",
        )

    # accept optional stage suffix: split_<uuid> or split_<uuid>_<stage>
    remainder = task_id.replace("split_", "")
    parts = remainder.split("_")
    split_id = parts[0]
    try:
        split_uuid = UUID(split_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid task ID format",
        )

    result = await db.execute(
        select(DeliverySplit).where(
            DeliverySplit.id == split_uuid,
            DeliverySplit.is_deleted == True,  # noqa: E712
        )
    )
    split = result.scalar_one_or_none()
    if not split:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Deleted delivery split not found",
        )

    # Only restore the single requested split, not all siblings
    split_deleted_at_for_restore = split.deleted_at
    split.is_deleted = False
    split.deleted_at = None

    db.add(
        AuditLog(
            entity_type="delivery_split",
            entity_id=split.id,
            action=AuditAction.UPDATE.value,
            old_value={"is_deleted": True},
            new_value={"is_deleted": False},
            performed_by=current_user.id,
        )
    )

    # If the order was deleted (no active splits remaining), restore it too
    order_result = await db.execute(
        select(Order).where(
            Order.id == split.order_id,
        )
    )
    order = order_result.scalar_one_or_none()
    if order and order.is_deleted:
        previous_suppressed = bool((order.base_data or {}).get("_auto_delivery_suppressed", False))
        _set_auto_delivery_suppressed(order, False)
        order_deleted_at_for_restore = order.deleted_at
        order.is_deleted = False
        order.deleted_at = None

        # BOM: bu sipariş silinirken bileşenleri de cascade ile silinmiş olabilir —
        # geri alırken onları da (yalnızca AYNI silme işleminde silinmiş olanları) geri getir.
        await cascade_restore_components(db, order.id, order_deleted_at_for_restore)

        db.add(
            AuditLog(
                entity_type="order",
                entity_id=order.id,
                action=AuditAction.UPDATE.value,
                old_value={"source": task_id, "auto_delivery_suppressed": previous_suppressed, "is_deleted": True},
                new_value={"auto_delivery_suppressed": False, "is_deleted": False},
                performed_by=current_user.id,
            )
        )

    # BOM: restore edilen split bir ANA siparişin (bileşen değil) parçasıysa,
    # silinirken bu parçaya cascade ile bağlı bileşen parçaları da (bkz.
    # cascade_soft_delete_linked_component_splits, delete_gantt_task) — TAM O
    # ANDA silinmiş olanlar — geri getirilir.
    if order and order.parent_order_id is None:
        await cascade_restore_linked_component_splits(db, split.id, split_deleted_at_for_restore)

    await db.commit()

    await sse_manager.publish("TASK_UPDATED", {
        "task_id": task_id,
        "order_id": str(split.order_id),
        "restored_split_ids": [str(split.id)],
        "updated_by": current_user.username,
        "action": "restore",
    })

    return {
        "message": "Delivery split restored",
        "task_id": task_id,
        "order_id": str(split.order_id),
        "restored_split_ids": [str(split.id)],
    }
