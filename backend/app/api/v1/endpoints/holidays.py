"""
Official holiday endpoints.
"""

from datetime import date, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, require_role
from app.api.v1.endpoints.gantt import (
    _get_holiday_days,
    _get_work_hours_per_day,
    _get_step_employee_map,
)
from app.core.date_utils import (
    calculate_split_start_date,
    effective_product_params,
    effective_split_quantity,
    is_outsourced_from_base_data,
)
from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.delivery_split import DeliverySplit
from app.models.enums import AuditAction
from app.models.official_holiday import OfficialHoliday
from app.models.order import Order
from app.models.user import User, UserRole
from app.services.bom_scheduling import get_components_ready_at_map, get_components_start_at_map
from app.services.sse_service import sse_manager

router = APIRouter(prefix="/holidays", tags=["Holidays"])


async def _recompute_active_splits_for_schedule_change(db: AsyncSession, performed_by: UUID) -> int:
    """Zamanlamayı etkileyen bir GENEL ayar değiştiğinde (tatil eklendi/silindi,
    çalışma saati/gün değişti — bkz. app_settings.py update_work_hours_per_day)
    TÜM aktif DeliverySplit'lerin start_date'ini (end_date SABİT kalarak, GERİYE
    doğru) güncel ayarlarla yeniden hesaplayıp kaydeder.

    Neden gerekli: /gantt/tasks zaten HER istekte 5 alt-bloğu güncel tatil/saat
    ayarıyla yeniden konumlandırıyor (bkz. calculate_split_stage_ranges) — ama
    bu SADECE EKRANDAKİ GÖSTERİMİ düzeltir. DeliverySplit.start_date DB'de eski
    ayarla hesaplanmış kalırsa, alt-bloklar bu (artık yanlış) dış sınırların
    dışına taşabilir; Excel'e aktarım, aylık efor toplamı gibi DOĞRUDAN DB
    okuyan yerler de yanlış kalır.

    manual_edit=True olan split'lere (kullanıcının Gantt'ta elle sabitlediği)
    DOKUNULMAZ — yalnızca gerçek bir çakışma varsa audit log'a not düşülür
    (bkz. gantt.py _recompute_and_persist_bom_main_order'daki aynı kural).
    """
    holidays = await _get_holiday_days(db)
    work_hours_per_day = await _get_work_hours_per_day(db)
    work_minutes = work_hours_per_day * 60
    employee_map = await _get_step_employee_map(db)

    result = await db.execute(
        select(Order)
        .where(Order.is_deleted == False)  # noqa: E712
        .options(selectinload(Order.delivery_splits))
    )
    orders = result.scalars().unique().all()
    order_ids = [o.id for o in orders]
    components_ready_at_map = await get_components_ready_at_map(db, order_ids)
    components_start_at_map = await get_components_start_at_map(db, order_ids)

    updated_count = 0
    for order in orders:
        active_splits = [s for s in order.delivery_splits if not s.is_deleted]
        if not active_splits:
            continue
        component_ready_at = (
            components_ready_at_map.get(order.id) if order.parent_order_id is None else None
        )
        order_outsourced_flag = bool(is_outsourced_from_base_data(order.base_data))
        oid_str = str(order.id)
        for split in active_splits:
            effective_params = effective_product_params(order.base_data, split.param_overrides)
            sid_str = str(split.id)
            split_emp = employee_map.get(
                sid_str, employee_map.get(oid_str, {"assembly": 1.0, "production": 1.0, "test": 1.0})
            )
            split_is_fason = bool(split.is_outsourced) or order_outsourced_flag

            new_start = calculate_split_start_date(
                end_date=split.end_date,
                quantity=effective_split_quantity(split),
                product_params=effective_params,
                emp=split_emp,
                work_minutes=work_minutes,
                holidays=holidays,
                is_outsourced=split_is_fason,
                component_ready_at=component_ready_at,
                include_delivery=order.component_product_id is None,
                components_start_at=(
                    components_start_at_map.get(order.id) if order.parent_order_id is None else None
                ),
            )
            if new_start == split.start_date:
                continue

            if split.manual_edit:
                db.add(AuditLog(
                    entity_type="delivery_split",
                    entity_id=split.id,
                    action=AuditAction.UPDATE.value,
                    old_value=None,
                    new_value={
                        "reason": "schedule_setting_change_conflict_manual_edit_kept",
                        "current_start_date": split.start_date.isoformat(),
                        "would_be_start_date": new_start.isoformat(),
                    },
                    performed_by=performed_by,
                ))
                continue

            old_start = split.start_date
            split.start_date = new_start
            if split.stage_schedule:
                # Onaylanmış özel takvim, eski tatil/çalışma saati ayarına göre
                # hesaplanmış blok sürelerini taşıyor — ayar değişince geçersiz
                # kalır (bkz. order_details.py'deki aynı gerekçe), bu yüzden temizlenir.
                split.stage_schedule = None
            db.add(AuditLog(
                entity_type="delivery_split",
                entity_id=split.id,
                action=AuditAction.UPDATE.value,
                old_value={"start_date": old_start.isoformat()},
                new_value={"start_date": new_start.isoformat(), "reason": "schedule_setting_change"},
                performed_by=performed_by,
            ))
            updated_count += 1

    return updated_count


class HolidayOut(BaseModel):
    id: UUID
    holiday_date: date
    name: str
    is_active: bool

    model_config = {"from_attributes": True}


class HolidayCreate(BaseModel):
    holiday_date: date
    name: str = Field(default="Resmi Tatil", min_length=1, max_length=120)


class MessageResponse(BaseModel):
    message: str


class HolidaySeedResponse(BaseModel):
    message: str
    added_count: int


# ---------------------------------------------------------------------------
# Dini bayram tarihleri — Umm al-Qura Hicri takvimine göre hesaplanır.
# Ramazan Bayrami: 1 Sevval (10. ay, 1. gün) — 3 gün
# Kurban Bayrami: 10 Zilhicce (12. ay, 10. gün) — 4 gün
# ---------------------------------------------------------------------------

def _get_islamic_holidays(gregorian_year: int) -> list[tuple[date, str]]:  # noqa: C901
    """
    Return all Turkish religious holiday dates (Ramazan + Kurban Bayramı)
    that fall within *gregorian_year*.

    Uses the ``hijridate`` library which implements the Umm al-Qura calendar
    (Saudi Arabia official calendar, widely used for astronomical estimation).
    Dates may differ ±1 day from official Turkish declarations due to local
    moon-sighting rulings.
    """
    try:
        from hijridate import Hijri  # type: ignore
    except ImportError:
        # hijridate not installed – return empty list gracefully
        return []

    results: list[tuple[date, str]] = []

    # Hijri yıl yaklaşımı: Hicri takvim yılı 354.37 gün, Miladi 365.25 gün
    # Bu nedenle Hicri yıllar daha hızlı ilerler (oran: 365.25/354.37 ≈ 1.0307)
    # Örnek: 2026 CE → (2026 - 622) * 1.0307 ≈ 1447 AH (dogru)
    #         2026 CE → 2026 - 622 = 1404 AH        (YANLIS - ~43 yil geri)
    approx_hijri_year = int((gregorian_year - 622) * 1.0307)
    # ±1 tampon: ay sınırlarında iki Hicri yıl aynı Miladi yıla denk gelebilir
    hijri_years_to_check = [approx_hijri_year - 1, approx_hijri_year, approx_hijri_year + 1]

    for hy in hijri_years_to_check:
        if hy < 1 or hy > 1600:
            continue

        # --- Ramazan Bayrami: 1-2-3 Sevval (Shawwal = month 10) ---
        ramazan_bayram_names = [
            "Ramazan Bayrami 1. Gunu",
            "Ramazan Bayrami 2. Gunu",
            "Ramazan Bayrami 3. Gunu",
        ]
        try:
            first_shawwal = Hijri(hy, 10, 1).to_gregorian()
            for day_offset, name in enumerate(ramazan_bayram_names):
                d = first_shawwal + timedelta(days=day_offset)
                if d.year == gregorian_year:
                    results.append((d, name))
        except Exception:  # noqa: BLE001
            pass

        # --- Kurban Bayrami: 10-11-12-13 Zilhicce (Dhu al-Hijja = month 12) ---
        kurban_bayram_names = [
            "Kurban Bayrami 1. Gunu",
            "Kurban Bayrami 2. Gunu",
            "Kurban Bayrami 3. Gunu",
            "Kurban Bayrami 4. Gunu",
        ]
        try:
            tenth_dhul_hijja = Hijri(hy, 12, 10).to_gregorian()
            for day_offset, name in enumerate(kurban_bayram_names):
                d = tenth_dhul_hijja + timedelta(days=day_offset)
                if d.year == gregorian_year:
                    results.append((d, name))
        except Exception:  # noqa: BLE001
            pass

    # De-duplicate by date (keep first occurrence)
    seen: set[date] = set()
    unique: list[tuple[date, str]] = []
    for d, name in results:
        if d not in seen:
            seen.add(d)
            unique.append((d, name))

    unique.sort(key=lambda x: x[0])
    return unique


@router.get(
    "/",
    response_model=list[HolidayOut],
    summary="List official holidays",
)
async def list_holidays(
    year: int | None = Query(None, ge=2000, le=2100),
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[HolidayOut]:
    query = select(OfficialHoliday).where(OfficialHoliday.is_active == True)  # noqa: E712
    if year is not None:
        start = date(year, 1, 1)
        end = date(year + 1, 1, 1)
        query = query.where(
            OfficialHoliday.holiday_date >= start,
            OfficialHoliday.holiday_date < end,
        )

    result = await db.execute(query.order_by(OfficialHoliday.holiday_date))
    rows = result.scalars().all()
    return [HolidayOut.model_validate(row) for row in rows]


@router.post(
    "/",
    response_model=HolidayOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create an official holiday (Admin/Planner)",
)
async def create_holiday(
    body: HolidayCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> HolidayOut:
    existing_result = await db.execute(
        select(OfficialHoliday).where(OfficialHoliday.holiday_date == body.holiday_date)
    )
    existing = existing_result.scalar_one_or_none()

    if existing and existing.is_active:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Holiday already exists for this date",
        )

    if existing and not existing.is_active:
        existing.is_active = True
        existing.name = body.name
        await db.flush()
        await _recompute_active_splits_for_schedule_change(db, current_user.id)
        await db.commit()
        await db.refresh(existing)
        # Tatil listesi frontend'de sayfa açılışında bir kez yükleyip cache'leniyor
        # (hiç yenilenmiyordu) — SSE ile bildirim, açık sayfaların listeyi taze
        # tutmasını sağlar (bkz. GanttChart.tsx/StageView.tsx/DeliveryCalendarPage.tsx
        # HOLIDAY_UPDATED dinleyicisi).
        await sse_manager.publish("HOLIDAY_UPDATED", {"updated_by": current_user.username})
        return HolidayOut.model_validate(existing)

    holiday = OfficialHoliday(
        holiday_date=body.holiday_date,
        name=body.name,
        is_active=True,
    )
    db.add(holiday)
    await db.flush()
    await _recompute_active_splits_for_schedule_change(db, current_user.id)
    await db.commit()
    await db.refresh(holiday)
    await sse_manager.publish("HOLIDAY_UPDATED", {"updated_by": current_user.username})
    return HolidayOut.model_validate(holiday)


@router.delete(
    "/{holiday_id}",
    response_model=MessageResponse,
    summary="Delete an official holiday (Admin/Planner)",
)
async def delete_holiday(
    holiday_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> MessageResponse:
    result = await db.execute(select(OfficialHoliday).where(OfficialHoliday.id == holiday_id))
    holiday = result.scalar_one_or_none()
    if not holiday:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Holiday not found",
        )

    holiday.is_active = False
    await db.flush()
    await _recompute_active_splits_for_schedule_change(db, current_user.id)
    await db.commit()
    await sse_manager.publish("HOLIDAY_UPDATED", {"updated_by": current_user.username})

    return MessageResponse(message="Holiday removed")


@router.post(
    "/seed-tr",
    response_model=HolidaySeedResponse,
    summary="Seed Turkish official holidays (fixed + religious) for current and next 2 years (Admin/Planner)",
)
async def seed_tr_holidays(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> HolidaySeedResponse:
    current_year = date.today().year

    # Seed current year + next 2 years so users have enough runway
    years = [current_year, current_year + 1, current_year + 2]

    # ------------------------------------------------------------------
    # 1) Fixed (secular) national holidays — same date every year
    # ------------------------------------------------------------------
    fixed_holiday_specs = [
        ((1, 1), "Yilbasi"),
        ((4, 23), "23 Nisan Ulusal Egemenlik ve Cocuk Bayrami"),
        ((5, 1), "Emek ve Dayanisma Gunu"),
        ((5, 19), "19 Mayis Ataturk'u Anma Genclik ve Spor Bayrami"),
        ((7, 15), "15 Temmuz Demokrasi ve Milli Birlik Gunu"),
        ((8, 30), "30 Agustos Zafer Bayrami"),
        ((10, 29), "29 Ekim Cumhuriyet Bayrami"),
    ]

    target_dates: list[tuple[date, str]] = [
        (date(year, month, day), name)
        for year in years
        for (month, day), name in fixed_holiday_specs
    ]

    # ------------------------------------------------------------------
    # 2) Religious holidays — computed from Hijri calendar (Umm al-Qura)
    #    Ramazan Bayrami (3 days) + Kurban Bayrami (4 days)
    # ------------------------------------------------------------------
    for year in years:
        islamic_dates = _get_islamic_holidays(year)
        target_dates.extend(islamic_dates)

    # Remove duplicates (same date may appear from different year scans)
    seen_dedup: set[date] = set()
    deduped: list[tuple[date, str]] = []
    for d, name in target_dates:
        if d not in seen_dedup:
            seen_dedup.add(d)
            deduped.append((d, name))
    target_dates = deduped

    # ------------------------------------------------------------------
    # Persist — zaten AKTİF olan tarihler atlanır; daha önce silinmiş
    # (is_active=False) bir tarih varsa create_holiday ile TUTARLI şekilde
    # reaktive edilir (eskiden bu sorgu is_active filtrelemediği için "tarih
    # DB'de var" sayılıp atlanıyor, silinmiş tatil hiç geri gelmiyordu).
    # ------------------------------------------------------------------
    existing_result = await db.execute(
        select(OfficialHoliday).where(
            OfficialHoliday.holiday_date.in_([d for d, _ in target_dates])
        )
    )
    existing_by_date = {row.holiday_date: row for row in existing_result.scalars().all()}

    added_count = 0
    for holiday_date, holiday_name in sorted(target_dates, key=lambda x: x[0]):
        existing = existing_by_date.get(holiday_date)
        if existing is not None:
            if not existing.is_active:
                existing.is_active = True
                existing.name = holiday_name
                added_count += 1
            continue
        db.add(
            OfficialHoliday(
                holiday_date=holiday_date,
                name=holiday_name,
                is_active=True,
            )
        )
        added_count += 1

    await db.flush()
    await _recompute_active_splits_for_schedule_change(db, current_user.id)
    await db.commit()
    if added_count:
        await sse_manager.publish("HOLIDAY_UPDATED", {"updated_by": current_user.username})

    return HolidaySeedResponse(
        message="TR resmi ve dini tatilleri yuklendi",
        added_count=added_count,
    )
