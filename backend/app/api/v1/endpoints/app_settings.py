"""
App settings endpoints — global configuration and step-employee assignments.
"""

import json
from uuid import UUID
from datetime import datetime, timedelta, date
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, require_role
from app.api.v1.endpoints.holidays import _recompute_active_splits_for_schedule_change
from app.database import get_db
from app.models.app_setting import AppSetting
from app.models.order import Order
from app.models.step_employee_assignment import StepEmployeeAssignment
from app.models.official_holiday import OfficialHoliday
from app.models.user import User, UserRole
from app.models.delivery_split import DeliverySplit
from app.core.date_utils import (
    is_workday as _is_workday,
    calculate_split_start_date,
    calculate_split_stage_ranges,
    effective_product_params,
    effective_split_quantity,
    is_outsourced_from_base_data,
)
from app.services.bom_scheduling import get_components_ready_at_map, get_components_start_at_map
from app.services.sse_service import sse_manager

router = APIRouter(prefix="/settings", tags=["Settings"])

EMPLOYEE_NAMES_SETTING_KEY = "employee_names"


# ─────────────── Shared helpers (mirror gantt.py logic) ───────────────

async def _get_work_hours_per_day(db: AsyncSession) -> float:
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


async def _get_setting_float(db: AsyncSession, key: str, default: float) -> float:
    result = await db.execute(select(AppSetting).where(AppSetting.key == key))
    setting = result.scalar_one_or_none()
    if setting is not None:
        try:
            return float(setting.value)
        except (ValueError, TypeError):
            pass
    return default


def _normalize_employee_names(employees: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for employee in employees:
        name = " ".join(employee.strip().split())
        if not name:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Calisan adi bos olamaz.",
            )
        if len(name) > 100:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Calisan adi en fazla 100 karakter olabilir.",
            )
        if len(name.split()) < 2:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Calisan adi isim ve soyisim olarak girilmelidir.",
            )
        lookup = name.casefold()
        if lookup in seen:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Tekrarlanan calisan adi: {name}",
            )
        seen.add(lookup)
        normalized.append(name)
    return normalized


async def _get_employee_names(db: AsyncSession) -> list[str]:
    result = await db.execute(
        select(AppSetting).where(AppSetting.key == EMPLOYEE_NAMES_SETTING_KEY)
    )
    setting = result.scalar_one_or_none()
    if setting is None:
        return []
    try:
        value = json.loads(setting.value)
    except (TypeError, json.JSONDecodeError):
        return []
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _build_product_params(order: Order) -> dict:
    base = order.base_data or {}
    return base


def _order_is_fason(base_data: dict | None) -> bool:
    """Order-level fason (dış dizgi) flag from base_data — thin wrapper around the
    shared `is_outsourced_from_base_data` (date_utils.py) so this capacity calc
    agrees with gantt.py's main view and order_details.py's preview modal."""
    return bool(is_outsourced_from_base_data(base_data))


async def _load_holidays(db: AsyncSession) -> set[date]:
    result = await db.execute(
        select(OfficialHoliday).where(OfficialHoliday.is_active == True)
    )
    return {h.holiday_date for h in result.scalars().all()}


async def _load_employee_map(
    db: AsyncSession,
) -> dict[str, dict[str, float]]:
    """Return {order_id|split_id: {step_key: employee_count}} with default 1.

    Entries keyed by split_id are per-split overrides.
    Entries keyed by order_id are order-level defaults (split_id IS NULL).
    Lookup: try split_id first, then fall back to order_id.
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
    # Fill defaults for orders that have no order-level rows
    order_result = await db.execute(
        select(Order).where(Order.is_deleted == False)
    )
    for order in order_result.scalars().all():
        oid = str(order.id)
        if oid not in order_ids_with_rows and oid not in emp_map:
            emp_map[oid] = {"assembly": 1.0, "production": 1.0, "test": 1.0}
    return emp_map


# ─────────────── Work Hours ───────────────

class WorkHoursResponse(BaseModel):
    value: float = Field(..., description="Daily working hours")


class WorkHoursUpdate(BaseModel):
    value: float = Field(..., ge=1, le=24, description="Daily working hours")


@router.get(
    "/work-hours-per-day",
    response_model=WorkHoursResponse,
    summary="Get daily working hours",
)
async def get_work_hours_per_day(
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> WorkHoursResponse:
    result = await db.execute(
        select(AppSetting).where(AppSetting.key == "work_hours_per_day")
    )
    setting = result.scalar_one_or_none()
    if setting is not None:
        try:
            return WorkHoursResponse(value=float(setting.value))
        except (ValueError, TypeError):
            pass
    return WorkHoursResponse(value=8.0)


@router.put(
    "/work-hours-per-day",
    response_model=WorkHoursResponse,
    summary="Update daily working hours",
)
async def update_work_hours_per_day(
    body: WorkHoursUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> WorkHoursResponse:
    await db.merge(AppSetting(key="work_hours_per_day", value=str(body.value)))
    await db.flush()
    # Çalışma saati/gün değişince, dakika bazlı (per_unit) hesaplanan aktif
    # split'lerin süresi de değişir — aksi halde eski ve yeni saatle hesaplanmış
    # split'ler DB'de karışık kalır (bkz. holidays.py'deki aynı gerekçe/fonksiyon,
    # tatil ekleme/silmede de aynı sorun için kullanılıyor).
    await _recompute_active_splits_for_schedule_change(db, current_user.id)
    await db.commit()
    return WorkHoursResponse(value=body.value)


# ─────────────── Max Concurrent Employees ───────────────

class MaxEmployeesResponse(BaseModel):
    value: float = Field(..., description="Max concurrent employees")


class MaxEmployeesUpdate(BaseModel):
    value: float = Field(..., ge=1, le=200, description="Max concurrent employees")


@router.get(
    "/max-concurrent-employees",
    response_model=MaxEmployeesResponse,
    summary="Get max concurrent employees",
)
async def get_max_concurrent_employees(
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> MaxEmployeesResponse:
    result = await db.execute(
        select(AppSetting).where(AppSetting.key == "max_concurrent_employees")
    )
    setting = result.scalar_one_or_none()
    if setting is not None:
        try:
            return MaxEmployeesResponse(value=float(setting.value))
        except (ValueError, TypeError):
            pass
    return MaxEmployeesResponse(value=10.0)


@router.put(
    "/max-concurrent-employees",
    response_model=MaxEmployeesResponse,
    summary="Update max concurrent employees",
)
async def update_max_concurrent_employees(
    body: MaxEmployeesUpdate,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> MaxEmployeesResponse:
    await db.merge(
        AppSetting(key="max_concurrent_employees", value=str(body.value))
    )
    await db.commit()
    return MaxEmployeesResponse(value=body.value)


# ─────────────── Employee Names ───────────────

class EmployeeNamesResponse(BaseModel):
    employees: list[str] = Field(default_factory=list, description="Employee full names")


class EmployeeNamesUpdate(BaseModel):
    employees: list[str] = Field(default_factory=list, max_length=500)


@router.get(
    "/employee-names",
    response_model=EmployeeNamesResponse,
    summary="Get configured employee names",
)
async def get_employee_names(
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> EmployeeNamesResponse:
    return EmployeeNamesResponse(employees=await _get_employee_names(db))


@router.put(
    "/employee-names",
    response_model=EmployeeNamesResponse,
    summary="Update configured employee names",
)
async def update_employee_names(
    body: EmployeeNamesUpdate,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> EmployeeNamesResponse:
    employees = _normalize_employee_names(body.employees)
    await db.merge(
        AppSetting(
            key=EMPLOYEE_NAMES_SETTING_KEY,
            value=json.dumps(employees, ensure_ascii=False),
        )
    )
    await db.commit()
    return EmployeeNamesResponse(employees=employees)


# ─────────────── Step Employee Assignments ───────────────

class StepAssignmentItem(BaseModel):
    order_id: str = Field(..., description="Order UUID")
    split_id: str | None = Field(default=None, description="NULL = order-level, set = per-split override")
    order_name: str = Field(default="", description="Product name")
    order_number: str = Field(default="", description="Siparis no / external ID")
    delivery_date: str | None = Field(default=None, description="Teslim tarihi")
    quantity: float | None = Field(default=None, description="Adet")
    split_quantity: float | None = Field(default=None, description="Split-specific adet (only if split_id is set)")
    split_start_date: str | None = Field(default=None, description="Split baslangic tarihi")
    split_end_date: str | None = Field(default=None, description="Split teslim tarihi")
    supply_days: int | float | None = None
    assembly_days: int | float | None = None
    quality_minutes: int | float | None = None
    epoxy_minutes: int | float | None = None
    conformal_minutes: int | float | None = None
    montaj_minutes: int | float | None = None
    montaj_kalite_minutes: int | float | None = None
    test1_minutes: int | float | None = None
    test2_minutes: int | float | None = None
    final_test_minutes: int | float | None = None
    delivery_days: int | float | None = None
    outsource_days: int | float | None = None
    assembly: float = Field(default=1.0, ge=0.5, le=100)
    production: float = Field(default=1.0, ge=0.5, le=100)
    test: float = Field(default=1.0, ge=0.5, le=100)
    has_multiple_splits: bool = Field(default=False, description="True if order has >1 active split")
    is_outsourced: bool = Field(default=False, description="True if the split is outsourced (fason)")


class StepAssignmentsResponse(BaseModel):
    assignments: list[StepAssignmentItem]


class StepAssignmentUpdate(BaseModel):
    order_id: str
    split_id: str | None = Field(default=None, description="NULL = order-level, set = per-split override")
    step_key: str = Field(..., pattern="^(assembly|production|test)$")
    employee_count: float = Field(..., ge=0.5, le=100)


class StepAssignmentsBatchUpdate(BaseModel):
    assignments: list[StepAssignmentUpdate]


@router.get(
    "/step-employees",
    response_model=StepAssignmentsResponse,
    summary="Get employee assignments per order per step",
)
async def get_step_employees(
    order_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> StepAssignmentsResponse:
    """Optionally scoped to a single ``order_id`` (e.g. from the Order Details
    preview) so callers don't have to fetch every order's assignments just to
    show one split's employee counts."""
    emp_map = await _load_employee_map(db)

    order_query = select(Order).where(Order.is_deleted == False).options(selectinload(Order.delivery_splits))
    if order_id:
        try:
            order_query = order_query.where(Order.id == UUID(order_id))
        except ValueError:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid order_id")

    order_result = await db.execute(order_query)
    orders = order_result.scalars().all()

    items: list[StepAssignmentItem] = []
    for order in orders:
        oid = str(order.id)
        base = order.base_data or {}
        order_name = _build_order_name(order)
        order_number = base.get("siparis_no") or order.external_id or ""
        delivery_date: str | None = None
        if order.delivery_splits:
            max_end = max(
                (ds.end_date for ds in order.delivery_splits if not ds.is_deleted),
                default=None,
            )
            if max_end is not None:
                delivery_date = max_end.date().isoformat()
        if not delivery_date:
            if order.promised_date:
                delivery_date = order.promised_date.isoformat()
            elif order.requirement_date:
                delivery_date = order.requirement_date.isoformat()
        quantity = sum(
            (ds.quantity for ds in order.delivery_splits if not ds.is_deleted),
            start=0,
        ) or None
        active_splits = [ds for ds in order.delivery_splits if not ds.is_deleted]
        has_multi = len(active_splits) > 1
        params = _build_product_params(order)
        # Fason (dış dizgi) flag — order-level base_data değeri
        order_is_fason = _order_is_fason(base)

        # Order-level row (no inputs if order has multiple splits)
        if has_multi:
            # Sipariş-geneli işçi sayısı DB'de gerçekten farklı (ör. 3.0) olsa bile
            # bu satır eskiden her zaman sabit 1.0/1.0/1.0 gösteriyordu — kullanıcı
            # ekranda yanlış bir sayı görürken, arkada (gantt.py/date_utils.py
            # hesaplamalarında) gerçek DB değeri kullanılmaya devam ediyordu.
            order_emp = emp_map.get(oid, {"assembly": 1.0, "production": 1.0, "test": 1.0})
            items.append(StepAssignmentItem(
                order_id=oid,
                split_id=None,
                order_name=order_name,
                order_number=order_number,
                delivery_date=delivery_date,
                quantity=quantity,
                has_multiple_splits=True,
                is_outsourced=order_is_fason,
                supply_days=params.get("supply_days"),
                assembly_days=params.get("production_days") or params.get("assembly_days"),
                outsource_days=params.get("outsource_days"),
                quality_minutes=params.get("quality_minutes"),
                epoxy_minutes=params.get("epoxy_minutes"),
                conformal_minutes=params.get("conformal_minutes"),
                montaj_minutes=params.get("montaj_minutes"),
                montaj_kalite_minutes=params.get("montaj_kalite_minutes"),
                test1_minutes=params.get("test1_minutes"),
                test2_minutes=params.get("test2_minutes"),
                final_test_minutes=params.get("final_test_minutes"),
                delivery_days=params.get("delivery_days"),
                assembly=order_emp.get("assembly", 1.0),
                production=order_emp.get("production", 1.0),
                test=order_emp.get("test", 1.0),
            ))
        else:
            single_split = active_splits[0] if active_splits else None
            emp = emp_map.get(oid, {"assembly": 1.0, "production": 1.0, "test": 1.0})
            single_params = effective_product_params(order.base_data, single_split.param_overrides if single_split else None)
            items.append(StepAssignmentItem(
                order_id=oid,
                split_id=None,
                order_name=order_name,
                order_number=order_number,
                delivery_date=delivery_date,
                quantity=quantity,
                has_multiple_splits=False,
                is_outsourced=(single_split.is_outsourced if single_split else False) or order_is_fason,
                supply_days=single_params.get("supply_days"),
                assembly_days=single_params.get("production_days") or single_params.get("assembly_days"),
                outsource_days=single_params.get("outsource_days"),
                quality_minutes=single_params.get("quality_minutes"),
                epoxy_minutes=single_params.get("epoxy_minutes"),
                conformal_minutes=single_params.get("conformal_minutes"),
                montaj_minutes=single_params.get("montaj_minutes"),
                montaj_kalite_minutes=single_params.get("montaj_kalite_minutes"),
                test1_minutes=single_params.get("test1_minutes"),
                test2_minutes=single_params.get("test2_minutes"),
                final_test_minutes=single_params.get("final_test_minutes"),
                delivery_days=single_params.get("delivery_days"),
                assembly=emp.get("assembly", 1.0),
                production=emp.get("production", 1.0),
                test=emp.get("test", 1.0),
            ))

        # Split-level rows (only if order has multiple splits)
        if has_multi:
            for ds in active_splits:
                sid_str = str(ds.id)
                split_emp = emp_map.get(sid_str, {"assembly": 1.0, "production": 1.0, "test": 1.0})
                # Bu parçanın kendi geçersiz kılmaları (varsa) — modal/ana Gantt ile
                # tutarlı olsun diye, sipariş genelinde değil bu parçaya özel değer
                # gösterilir.
                ds_params = effective_product_params(order.base_data, ds.param_overrides)
                items.append(StepAssignmentItem(
                    order_id=oid,
                    split_id=sid_str,
                    order_name=order_name,
                    order_number=order_number,
                    delivery_date=ds.end_date.date().isoformat(),
                    quantity=ds.quantity,
                    split_quantity=ds.quantity,
                    split_start_date=ds.start_date.date().isoformat(),
                    split_end_date=ds.end_date.date().isoformat(),
                    has_multiple_splits=has_multi,
                    is_outsourced=ds.is_outsourced or order_is_fason,
                    supply_days=ds_params.get("supply_days"),
                    assembly_days=ds_params.get("production_days") or ds_params.get("assembly_days"),
                    outsource_days=ds_params.get("outsource_days"),
                    quality_minutes=ds_params.get("quality_minutes"),
                    epoxy_minutes=ds_params.get("epoxy_minutes"),
                    conformal_minutes=ds_params.get("conformal_minutes"),
                    montaj_minutes=ds_params.get("montaj_minutes"),
                    montaj_kalite_minutes=ds_params.get("montaj_kalite_minutes"),
                    test1_minutes=ds_params.get("test1_minutes"),
                    test2_minutes=ds_params.get("test2_minutes"),
                    final_test_minutes=ds_params.get("final_test_minutes"),
                    delivery_days=ds_params.get("delivery_days"),
                    assembly=split_emp.get("assembly", 1.0),
                    production=split_emp.get("production", 1.0),
                    test=split_emp.get("test", 1.0),
                ))

    return StepAssignmentsResponse(assignments=items)


@router.put(
    "/step-employees",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Batch upsert step employee assignments",
)
async def update_step_employees(
    body: StepAssignmentsBatchUpdate,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> None:
    updated_split_ids: set[str] = set()
    # split_id=None girdiler (bölünmemiş siparişin tek teslimatı) için, atama DB'de
    # split_id=NULL olarak saklanır ama zamanlamayı yeniden hesaplayacağımız/SSE
    # yayınlayacağımız şey gerçek DeliverySplit satırıdır — order_id'sini burada
    # toplayıp aşağıda tek seferde gerçek split id'lerine çeviriyoruz.
    order_ids_needing_split_lookup: set[str] = set()
    for item in body.assignments:
        order = await db.get(Order, item.order_id)
        if not order:
            raise HTTPException(
                status_code=404,
                detail=f"Order {item.order_id} not found",
            )
        filters = [
            StepEmployeeAssignment.order_id == item.order_id,
            StepEmployeeAssignment.step_key == item.step_key,
        ]
        if item.split_id:
            filters.append(StepEmployeeAssignment.split_id == UUID(item.split_id))
        else:
            filters.append(StepEmployeeAssignment.split_id.is_(None))
        existing = await db.execute(
            select(StepEmployeeAssignment).where(*filters)
        )
        row = existing.scalar_one_or_none()
        if row:
            row.employee_count = item.employee_count
        else:
            db.add(StepEmployeeAssignment(
                order_id=item.order_id,
                split_id=UUID(item.split_id) if item.split_id else None,
                step_key=item.step_key,
                employee_count=item.employee_count,
            ))
        if item.split_id:
            updated_split_ids.add(item.split_id)
        else:
            order_ids_needing_split_lookup.add(item.order_id)

    if order_ids_needing_split_lookup:
        result = await db.execute(
            select(DeliverySplit.id, DeliverySplit.order_id).where(
                DeliverySplit.order_id.in_(UUID(oid) for oid in order_ids_needing_split_lookup),
                DeliverySplit.is_deleted == False,  # noqa: E712
            )
        )
        splits_by_order: dict[str, list[str]] = {}
        for sid, oid in result.all():
            splits_by_order.setdefault(str(oid), []).append(str(sid))
        for oid, sids in splits_by_order.items():
            # `split_id=None` istekleri, o siparişin BÖLÜNMEMİŞ (tek split'li)
            # olduğu varsayımıyla gönderilir. Bu istek yola çıktıktan sonra sipariş
            # başka biri tarafından çok parçalı hâle getirildiyse (nadir bir yarış
            # durumu), hangi parçanın kastedildiği artık belirsizdir — yanlış bir
            # tahminle TÜM kardeş parçaları aynı (muhtemelen alakasız) sayıyla
            # yeniden hesaplayıp SSE yayınlamak yerine, bu belirsiz siparişi
            # olduğu gibi atlarız.
            if len(sids) == 1:
                updated_split_ids.add(sids[0])

    # Flush so new values are visible in same transaction
    await db.flush()

    # Recalculate start_date for any updated splits
    if updated_split_ids:
        work_hours_per_day = await _get_work_hours_per_day(db)
        work_minutes = work_hours_per_day * 60
        holidays = await _load_holidays(db)
        emp_map = await _load_employee_map(db)
        # BOM: ana siparişin (parent_order_id yok) kendi bileşenleri varsa Dizgi
        # atlanır ve start_date buna göre hesaplanmalı — bkz. holidays.py'deki
        # _recompute_active_splits_for_schedule_change'deki AYNI kural. Bu çağrı
        # ÖNCEDEN component_ready_at hiç geçirmiyordu: BOM ana siparişlerinde
        # Dizgi'nin ATLANMASI gerekirken tam (component'ten bağımsız, per-unit×adet)
        # bir Dizgi süresiyle hesaplanıyordu — canlı testte bunun start_date'i
        # siparişten BİR YILDAN FAZLA ÖNCEYE (!) fırlattığı doğrulandı.
        splits_for_recalc = [await db.get(DeliverySplit, UUID(sid)) for sid in updated_split_ids]
        order_ids_for_recalc = [s.order_id for s in splits_for_recalc if s is not None and s.end_date is not None]
        components_ready_at_map = await get_components_ready_at_map(db, order_ids_for_recalc)
        components_start_at_map = await get_components_start_at_map(db, order_ids_for_recalc)
        for sid in updated_split_ids:
            split = await db.get(DeliverySplit, UUID(sid))
            if not split or split.end_date is None:
                continue
            oid = str(split.order_id)
            split_emp = emp_map.get(sid, emp_map.get(oid, {"assembly": 1.0, "production": 1.0, "test": 1.0}))
            order = split.order
            product_params = effective_product_params(order.base_data, split.param_overrides)
            _fason = bool(split.is_outsourced) or _order_is_fason(order.base_data)
            component_ready_at = (
                components_ready_at_map.get(split.order_id) if order.parent_order_id is None else None
            )
            new_start = calculate_split_start_date(
                end_date=split.end_date,
                quantity=effective_split_quantity(split),
                product_params=product_params,
                emp=split_emp,
                work_minutes=work_minutes,
                holidays=holidays,
                is_outsourced=_fason,
                component_ready_at=component_ready_at,
                include_delivery=order.component_product_id is None,
                components_start_at=(
                    components_start_at_map.get(split.order_id) if order.parent_order_id is None else None
                ),
            )
            if new_start != split.start_date:
                split.start_date = new_start
                split.manual_edit = True

    # Check concurrency — same transaction sees flushed data
    try:
        max_emp = await _get_setting_float(db, "max_concurrent_employees", 10.0)
        work_hours_per_day = await _get_work_hours_per_day(db)
        work_minutes = work_hours_per_day * 60
        holidays = await _load_holidays(db)
        conflicts, _ = await _compute_concurrency_conflicts(db, max_emp, work_minutes, holidays)
    except Exception as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": f"Sistem hatasi: {exc}",
                "conflicts": [],
            },
        )

    if conflicts:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Bu degerler kaydedilemez, carpisma var.",
                "max_concurrent_employees": max_emp,
                "conflicts": [c.model_dump() for c in conflicts],
            },
        )

    await db.commit()

    # Publish SSE for updated splits
    for sid in updated_split_ids:
        split = await db.get(DeliverySplit, UUID(sid))
        if split:
            await sse_manager.publish("TASK_UPDATED", {
                "task_id": f"split_{sid}",
                "updated_by": _current_user.username,
                "action": "employees_updated",
            })


def _build_order_name(order: Order) -> str:
    base = order.base_data or {}
    for key in ("product_name", "name", "description", "ürün", "urun",
                "siparis_no", "product_code", "proje"):
        if key in base and base[key]:
            return str(base[key])
    return f"Sipariş #{order.external_id[:8]}"


# ─────────────── Employee Concurrency Report ───────────────

class ConflictStepInfo(BaseModel):
    order_id: str
    split_id: str | None = None
    order_name: str
    order_number: str = ""
    step_key: str
    stage_label: str
    employees: float
    quantity: float | None = None
    delivery_date: str | None = None
    stage_start: str
    stage_end: str


class ConcurrencyConflict(BaseModel):
    date: str
    total_employees: float
    max_allowed: float
    exceeds_by: float
    steps: list[ConflictStepInfo]
    suggestion: str


class ConcurrencyReportResponse(BaseModel):
    max_concurrent_employees: float
    conflicts: list[ConcurrencyConflict]
    remaining_capacity: dict[str, dict[str, float]] = {}


@router.get(
    "/employee-concurrency-report",
    response_model=ConcurrencyReportResponse,
    summary="Get date-wise employee concurrency conflicts",
)
async def get_employee_concurrency_report(
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> ConcurrencyReportResponse:
    max_emp = await _get_setting_float(db, "max_concurrent_employees", 10)
    work_hours_per_day = await _get_work_hours_per_day(db)
    work_minutes = work_hours_per_day * 60
    holidays = await _load_holidays(db)
    conflicts, _ = await _compute_concurrency_conflicts(db, max_emp, work_minutes, holidays)
    return ConcurrencyReportResponse(
        max_concurrent_employees=max_emp,
        conflicts=conflicts,
    )


# ─────────────── Live Concurrency Check (no save) ───────────────

class CheckConcurrencyRequest(BaseModel):
    assignments: list[StepAssignmentUpdate]


@router.post(
    "/check-concurrency",
    response_model=ConcurrencyReportResponse,
    summary="Check concurrency with proposed values without saving",
)
async def check_concurrency(
    body: CheckConcurrencyRequest,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> ConcurrencyReportResponse:
    """Accept proposed step-employee counts and return concurrency conflicts
    without persisting anything."""
    # Kayıtlı atamalardan başla, isteğin önerdiği değerleri üzerine yaz — böylece
    # bu proaktif kontrol, PUT'un kayıt sırasındaki 409 kontrolüyle birebir aynı
    # sonucu verir (eskiden istekte olmayan siparişler 1'er kişi varsayılıyordu).
    emp_map = await _load_employee_map(db)
    body_keys: set[str] = set()
    for item in body.assignments:
        key = item.split_id or item.order_id
        body_keys.add(key)
        entry = emp_map.setdefault(key, {"assembly": 1.0, "production": 1.0, "test": 1.0})
        entry[item.step_key] = item.employee_count

    # Body'de explicit override edilmeyen split-level entry'leri kaldır —
    # aksi halde DB'den gelen eski split-level değerler order-level
    # override'ları gölgeler ve kullanıcının girdiği değerler kullanılmaz.
    order_ids = {item.order_id for item in body.assignments}
    if order_ids:
        split_rows = await db.execute(
            select(DeliverySplit.id)
            .where(DeliverySplit.order_id.in_(order_ids))
            .where(DeliverySplit.is_deleted == False)
        )
        for (sid,) in split_rows.all():
            sk = str(sid)
            if sk not in body_keys:
                emp_map.pop(sk, None)

    max_emp = await _get_setting_float(db, "max_concurrent_employees", 10.0)
    work_hours_per_day = await _get_work_hours_per_day(db)
    work_minutes = work_hours_per_day * 60
    holidays = await _load_holidays(db)
    conflicts, daily_data = await _compute_concurrency_conflicts(
        db, max_emp, work_minutes, holidays, emp_map_override=emp_map,
    )

    # Per-adim kalan kapasite: bu adimin dustugu gunlerde diger siparislerin/
    # parcalarin kullandigi calisan sayisini max'tan cikar. Coklu-parcali
    # siparislerde split_id ile eslestirilir — aksi halde kardes parcalarin
    # gunleri "ayni siparis" sayilip kalan kapasite yanlis hesaplanirdi.
    remaining_capacity: dict[str, dict[str, float]] = {}
    for item in body.assignments:
        key = item.split_id or item.order_id  # emp_map anahtari
        block_key = item.step_key
        order_id = item.order_id
        split_id = item.split_id

        def _matches(step: "ConflictStepInfo") -> bool:
            if split_id:
                return step.split_id == split_id
            return step.order_id == order_id

        block_days: set[date] = set()
        for d, info in daily_data.items():
            for step in info["steps"]:
                if step.step_key == block_key and _matches(step):
                    block_days.add(d)

        if not block_days:
            continue

        other_peak = 0.0
        for d in block_days:
            info = daily_data[d]
            same_total = sum(s.employees for s in info["steps"] if _matches(s))
            other = info["total"] - same_total
            if other > other_peak:
                other_peak = other

        rem = max(0.0, max_emp - other_peak)
        remaining_capacity.setdefault(key, {})[block_key] = rem

    return ConcurrencyReportResponse(
        max_concurrent_employees=max_emp,
        conflicts=conflicts,
        remaining_capacity=remaining_capacity,
    )


async def _compute_concurrency_conflicts(
    db: AsyncSession,
    max_emp: float,
    work_minutes: float,
    holidays: set[date],
    emp_map_override: dict[str, dict[str, float]] | None = None,
) -> tuple[list[ConcurrencyConflict], dict]:
    """Run backward scheduling and return (conflicts, daily_data).
    If emp_map_override is provided, use it instead of loading from DB.
    """
    if emp_map_override is not None:
        emp_map = emp_map_override
    else:
        emp_map = await _load_employee_map(db)

    order_result = await db.execute(
        select(Order)
        .where(Order.is_deleted == False)
        .options(selectinload(Order.delivery_splits))
    )
    orders = order_result.scalars().all()
    # BOM: ana siparişlerin (parent_order_id yok) kendi bileşenleri varsa Dizgi
    # atlanır — asıl zamanlama motoruyla (date_utils.py) aynı kural, aksi halde
    # bu kapasite/çakışma kontrolü var olmayan bir Dizgi adımını da işçi
    # kapasitesine dahil edip hayalet bir çakışma raporlayabilir.
    components_ready_at_map = await get_components_ready_at_map(db, [o.id for o in orders])

    # Collect per-day employee counts and step details
    daily_data: dict[date, dict] = defaultdict(
        lambda: {"total": 0, "steps": []}
    )

    for order in orders:
        oid = str(order.id)
        emp = emp_map.get(oid, {"assembly": 1.0, "production": 1.0, "test": 1.0})
        order_name = _build_order_name(order)
        base = order.base_data or {}
        order_number = base.get("siparis_no") or order.external_id or ""
        order_is_fason = _order_is_fason(base)
        active_splits = [ds for ds in order.delivery_splits if not ds.is_deleted]
        order_qty = sum(
            (ds.quantity for ds in active_splits if ds.quantity is not None),
            start=0,
        ) or None
        order_delivery: str | None = None
        max_end = max(
            (ds.end_date for ds in active_splits if ds.end_date is not None),
            default=None,
        )
        if max_end is not None:
            order_delivery = max_end.date().isoformat()

        component_ready_at = (
            components_ready_at_map.get(order.id) if order.parent_order_id is None else None
        )
        for split in active_splits:
            if split.end_date is None:
                continue
            is_outsourced = split.is_outsourced or order_is_fason
            qty = max(1, effective_split_quantity(split) or 1)

            # Bu parçaya özel üretim parametresi geçersiz kılmaları (varsa) sipariş
            # değerinin üzerine yazılır — çalışan yük/kapasite hesabı da her parçanın
            # kendi bağımsız süresini yansıtmalı (order_details.py/gantt.py ile tutarlı).
            split_effective_params = effective_product_params(order.base_data, split.param_overrides)

            # Per-split employee override (fall back to order-level). `or` yerine
            # `is not None` kullanılır — aksi halde işçi sayısı gerçekten 0 olarak
            # kaydedilmiş olsaydı (API şu an bunu engelliyor ama başka bir yazma
            # yolu engellemeyebilir), Python'da "0.0 or X" sessizce X'e (sipariş
            # geneli varsayılana) düşer.
            _split_emp = emp_map.get(str(split.id))
            if _split_emp is not None:
                a_emp_val = _split_emp.get("assembly")
                p_emp_val = _split_emp.get("production")
                t_emp_val = _split_emp.get("test")
                a_emp = a_emp_val if a_emp_val is not None else emp.get("assembly", 1.0)
                p_emp = p_emp_val if p_emp_val is not None else emp.get("production", 1.0)
                t_emp = t_emp_val if t_emp_val is not None else emp.get("test", 1.0)
            else:
                a_emp = emp.get("assembly", 1.0)
                p_emp = emp.get("production", 1.0)
                t_emp = emp.get("test", 1.0)
            split_emp_dict = {"assembly": a_emp, "production": p_emp, "test": t_emp}

            # Bloklar artık BAĞIMSIZ bir kopya yerine asıl zamanlama motoruyla
            # (date_utils.py calculate_split_stage_ranges) hesaplanıyor — aksi
            # halde bu kontrol, motor değişince senkron dışı kalıp yanlış
            # çakışma tespiti (ya da kaçırma) yapabilir (bkz. gantt.py
            # update_gantt_task'taki aynı düzeltme/gerekçe).
            computed_blocks = calculate_split_stage_ranges(
                end_date=split.end_date,
                quantity=qty,
                product_params=split_effective_params,
                emp=split_emp_dict,
                work_minutes=work_minutes,
                holidays=holidays,
                is_outsourced=is_outsourced,
                component_ready_at=component_ready_at,
                include_delivery=order.component_product_id is None,
            )

            for block in computed_blocks:
                stage_key = block["key"]
                # Tedarik/Teslimat, işçi kapasitesine dahil edilmez (yalnızca
                # Dizgi/Üretim/Test için işçi ataması var). Fason (dış dizgi)
                # bir Dizgi de dahil edilmez — iş dışarıda yapılıyor, kendi
                # atölyenizin kapasitesini işgal etmiyor.
                if stage_key in ("supply", "delivery"):
                    continue
                if stage_key == "assembly" and is_outsourced:
                    continue
                step_emp = split_emp_dict.get(stage_key)
                if step_emp is None:
                    continue
                _record_stage_range(block["start"], block["end"], stage_key,
                                    step_emp, oid, str(split.id), order_name, order_number,
                                    order_qty, order_delivery, holidays, daily_data)

    # Find and build conflicts
    today = date.today()
    conflicts: list[ConcurrencyConflict] = []
    for d in sorted(daily_data.keys()):
        if d < today:
            # Geçmiş bir tarihte "çakışma" artık aksiyona dönüştürülemez (o günün
            # planlaması değiştirilemez) — bunu raporlamak yalnızca gürültü/yanlış
            # alarm olur, bu yüzden yalnızca bugün ve sonrası raporlanır.
            continue
        info = daily_data[d]
        if info["total"] > max_emp:
            grouped: dict[tuple[str, str, str], float] = {}
            for step in info["steps"]:
                key = (step.order_number, step.order_name, step.stage_label)
                grouped[key] = grouped.get(key, 0) + step.employees
            deduped: list[tuple[str, str, str, float, float | None, str | None]] = []
            seen: set[tuple[str, str, str]] = set()
            for step in info["steps"]:
                key = (step.order_number, step.order_name, step.stage_label)
                if key not in seen:
                    seen.add(key)
                    deduped.append((
                        step.order_number, step.order_name, step.stage_label,
                        grouped[key], step.quantity, step.delivery_date,
                    ))
            deduped.sort(key=lambda x: -x[3])

            def _fmt(on: str, name: str, label: str, emp: float, qty: float | None, dlv: str | None) -> str:
                detay = f"({name}, Adet: {qty}, Teslim: {dlv})" if qty and dlv else f"({name})"
                return f"{on} {detay} - {label} ({emp})"

            exceeds = info["total"] - max_emp
            if len(deduped) == 1:
                on, name, label, emp, qty, dlv = deduped[0]
                suggestion = (
                    f"{_fmt(on, name, label, emp, qty, dlv)} tek basina "
                    f"limit olan {max_emp}'i asiyor. "
                    f"{exceeds} kisi azaltmaniz önerilir."
                )
            elif len(deduped) == 2:
                (on1, n1, l1, e1, q1, d1), (on2, n2, l2, e2, q2, d2) = deduped
                suggestion = (
                    f"{_fmt(on1, n1, l1, e1, q1, d1)} ile "
                    f"{_fmt(on2, n2, l2, e2, q2, d2)} "
                    f"cakisiyor. Toplam {info['total']}, maksimum {max_emp}. "
                    f"{exceeds} kisi azaltmaniz önerilir."
                )
            else:
                parts = [_fmt(*x) for x in deduped]
                suggestion = (
                    f"{', '.join(parts)} cakisiyor. "
                    f"Toplam {info['total']}, maksimum {max_emp}. "
                    f"{exceeds} kisi azaltmaniz önerilir."
                )

            conflicts.append(ConcurrencyConflict(
                date=d.isoformat(),
                total_employees=info["total"],
                max_allowed=max_emp,
                exceeds_by=exceeds,
                steps=info["steps"],
                suggestion=suggestion,
            ))

    return conflicts, daily_data


def _record_stage_range(
    stage_start: datetime, stage_end: datetime,
    stage_key: str, emp_count: float,
    oid: str, split_id: str, order_name: str, order_number: str,
    quantity: float | None, delivery_date: str | None,
    holidays: set[date],
    daily_data: dict,
) -> None:
    """Mark each workday in [stage_start, stage_end) with employee count."""
    STAGE_LABEL_MAP = {
        "assembly": "Dizgi", "production": "Üretim", "test": "Test",
        "supply": "Tedarik", "delivery": "Teslimat",
        "kalite": "Üretim", "epoxy": "Üretim", "conformal": "Üretim",
        "montaj": "Üretim", "montaj_kalite": "Üretim",
        "test1": "Test", "test2": "Test", "final_test": "Test",
    }
    stage_label = STAGE_LABEL_MAP.get(stage_key, stage_key)

    cur = stage_start.date()
    end_d = stage_end.date()
    step_info = ConflictStepInfo(
        order_id=oid,
        split_id=split_id,
        order_name=order_name,
        order_number=order_number,
        step_key=stage_key,
        stage_label=stage_label,
        employees=emp_count,
        quantity=quantity,
        delivery_date=delivery_date,
        stage_start=stage_start.date().isoformat(),
        stage_end=stage_end.date().isoformat(),
    )
    while cur < end_d:
        if _is_workday(cur, holidays):
            daily_data[cur]["total"] += emp_count
            daily_data[cur]["steps"].append(step_info.model_copy(deep=True))
        cur += timedelta(days=1)

