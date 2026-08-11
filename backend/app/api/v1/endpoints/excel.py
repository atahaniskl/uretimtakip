"""
Excel Upload, Diff & Apply API.
Key Logic: Excel Diff & Merge.
"""

import io
import math
from uuid import UUID
from datetime import datetime, timezone, timedelta, date

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.app_setting import AppSetting
from app.models.user import User, UserRole
from app.models.mapping_template import MappingTemplate
from app.models.order import Order
from app.models.order_serial_number import OrderSerialNumber
from app.models.delivery_split import DeliverySplit
from app.models.audit_log import AuditLog
from app.models.product_info import ProductInfo
from app.models.enums import OrderStatus, AuditAction
from app.core.date_utils import (
    is_workday as _is_workday,
    subtract_workdays as _subtract_workdays,
    calculate_split_stage_ranges,
)
from app.schemas.excel import (
    ExcelUploadResponse,
    ExcelPreviewResponse,
    DiffResponse,
    DiffApplyRequest,
    DiffApplyResponse,
    ImportProductInfoResponse,
    ExportSiparisPlanResponse,
)
from app.schemas.order import OrderRead, OrderListResponse
from app.services.minio_service import minio_service
from app.services.excel_service import excel_service
from app.services.completion_metrics import calculate_completion_metrics
from app.api.deps import get_current_user, require_role
# BOM (alt ürün) bileşen türetme — manuel sipariş oluşturmayla (gantt.py) AYNI
# tek kaynak. gantt.py bu modülü hiç import ETMEDİĞİ için (yalnızca excel_service'i
# kullanıyor) burada tersten import etmek döngüsel import riski taşımaz.
from app.api.v1.endpoints.gantt import (
    _derive_component_orders,
    _build_product_params,
    _get_work_hours_per_day,
    _get_holiday_days,
    _rescale_component_split,
)
from app.services.bom_scheduling import cascade_soft_delete_components

router = APIRouter(prefix="/excel", tags=["Excel Engine"])

# Store pending diff results in memory (keyed by file_key).
# In production, consider Redis or DB-backed storage.
_pending_diffs: dict[str, dict] = {}

_START_DATE_KEYS = (
    "start_date",
    "date",
    "start",
    "baslangic",
    "başlangıç",
    "baslangic_tarihi",
    "başlangıç_tarihi",
    "baslangic tarihi",
    "başlangıç tarihi",
)

_END_DATE_KEYS = (
    "delivery_date",
    "end_date",
    "end",
    "delivery",
    "teslimat_tarihi",
    "teslim_tarihi",
    "teslim tarihi",
    "bitis_tarihi",
    "bitiş_tarihi",
    "bitis tarihi",
    "bitiş tarihi",
    "due_date",
)


def _coerce_datetime(value: object) -> datetime | None:
    """Best-effort datetime parser for flexible Excel date values."""
    if value is None:
        return None

    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, date):
        dt = datetime(value.year, value.month, value.day)
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        # Excel serial date support (origin 1899-12-30)
        serial = float(value)
        if 1 <= serial <= 80000:
            dt = datetime(1899, 12, 30) + timedelta(days=serial)
        else:
            return None
    else:
        text = str(value).strip()
        if not text:
            return None

        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            dt = None
            for fmt in (
                "%Y-%m-%d",
                "%d.%m.%Y",
                "%d/%m/%Y",
                "%m/%d/%Y",
                "%Y/%m/%d",
                "%d-%m-%Y",
            ):
                try:
                    dt = datetime.strptime(text, fmt)
                    break
                except ValueError:
                    continue
            if dt is None:
                return None

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _coerce_date(value: object) -> date | None:
    """Best-effort date parser for imported order fields."""
    dt = _coerce_datetime(value)
    if dt is None:
        return None
    return dt.date()


def _apply_order_fields(order: Order, row_data: dict) -> None:
    """Populate first-class order columns from imported row data.

    Tarih alanlari icin: Excel satirinda o hucre BOSSA (_coerce_date None doner),
    mevcut deger DOKUNULMAZ — aksi halde Gantt/sipariş detayinda elle girilmiş bir
    tarih (ör. requirement_date), ilgisiz bir alani guncellemek icin yapilan
    yeniden ice aktarmada sessizce NULL'a duserdi. Ayni gerekce birkac satir
    asagida DeliverySplit.manual_edit==False filtresiyle split'ler icin zaten
    uygulaniyor; burada da tutarli olmasi icin ayni kural date alanlarina da uygulandi.
    """
    fields = excel_service.extract_order_fields(row_data)
    order.customer_name = fields.get("customer_name")
    order.responsible_personnel = fields.get("responsible_personnel")
    new_order_date = _coerce_date(fields.get("order_date"))
    if new_order_date is not None:
        order.order_date = new_order_date
    new_promised_date = _coerce_date(fields.get("promised_date"))
    if new_promised_date is not None:
        order.promised_date = new_promised_date
    new_requirement_date = _coerce_date(fields.get("requirement_date"))
    if new_requirement_date is not None:
        order.requirement_date = new_requirement_date
    new_penalty_date = _coerce_date(fields.get("penalty_date"))
    if new_penalty_date is not None:
        order.penalty_date = new_penalty_date


def _resolve_split_window(base_data: dict, default_start: datetime) -> tuple[datetime | None, datetime | None, bool, list[str]]:
    """
    Resolve split start/end from imported row.
    Returns (start, end, has_explicit, warnings).
    If neither start nor end date is provided, returns (None, None, False, warnings).
    The caller MUST check for None and skip creation if dates are missing.
    """
    warnings: list[str] = []
    start_raw = next((base_data.get(k) for k in _START_DATE_KEYS if base_data.get(k) is not None), None)
    end_raw = next((base_data.get(k) for k in _END_DATE_KEYS if base_data.get(k) is not None), None)

    start_dt = _coerce_datetime(start_raw)
    end_dt = _coerce_datetime(end_raw)
    has_explicit = start_dt is not None or end_dt is not None

    if start_dt and end_dt:
        # Treat Excel end date as inclusive day; convert to exclusive bound.
        end_exclusive = end_dt + timedelta(days=1)
        if end_exclusive <= start_dt:
            warnings.append(
                f"Bitiş tarihi ({end_dt.date()}) başlangıçtan ({start_dt.date()}) önce. "
                f"Bitiş, başlangıç + 1 gün olarak düzeltildi."
            )
            end_exclusive = start_dt + timedelta(days=1)
        return start_dt, end_exclusive, has_explicit, warnings

    if start_dt:
        warnings.append(
            f"Bitiş tarihi belirtilmemiş. Varsayılan: {start_dt.date()} + 7 gün = "
            f"{(start_dt + timedelta(days=7)).date()}"
        )
        return start_dt, start_dt + timedelta(days=7), has_explicit, warnings

    if end_dt:
        warnings.append(
            f"Başlangıç tarihi belirtilmemiş. Teslimat gününe ({end_dt.date()}) "
            f"konumlandırıldı, süre 1 gün."
        )
        return end_dt, end_dt + timedelta(days=1), has_explicit, warnings

    warnings.append(
        "Başlangıç ve bitiş tarihi belirtilmemiş. Tarih zorunludur — bu kayıt atlanacak."
    )
    return None, None, False, warnings


@router.post(
    "/upload",
    response_model=ExcelUploadResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Upload an Excel file to MinIO",
)
async def upload_excel(
    file: UploadFile = File(..., description="Excel file (.xlsx)"),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> ExcelUploadResponse:
    """
    Upload an .xlsx file to MinIO object storage.
    Returns the file key for subsequent diff operations.
    """
    # Validate file type
    if not file.filename or not file.filename.endswith(".xlsx"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only .xlsx files are accepted",
        )

    # Validate content type
    allowed_types = [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/octet-stream",
    ]
    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid content type: {file.content_type}",
        )

    # Read file content
    file_data = await file.read()

    # Validate file size (max 50MB)
    max_size = 50 * 1024 * 1024
    if len(file_data) > max_size:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="File size exceeds 50MB limit",
        )

    # Upload to MinIO
    file_key = await minio_service.upload_file(
        file_data=file_data,
        original_filename=file.filename,
    )

    # Detect if it's a uretim_Planlamadolu format
    is_uretim_plan = excel_service.detect_uretim_planlamadolu(file_data)
    product_count = 0
    order_count = 0
    calisma_saati = 8

    if is_uretim_plan:
        try:
            products = excel_service.parse_urun_sure(file_data)
            product_count = len(products)
        except Exception:
            product_count = 0
        try:
            orders = excel_service.parse_siparis_plan_input(file_data)
            order_count = len(orders)
        except Exception:
            order_count = 0
        try:
            calisma_saati = excel_service.read_calisma_saati(file_data)
        except Exception:
            calisma_saati = 8

    return ExcelUploadResponse(
        file_key=file_key,
        filename=file.filename,
        message="File uploaded successfully",
        is_uretim_plan=is_uretim_plan,
        product_count=product_count,
        order_count=order_count,
        calisma_saati=calisma_saati,
    )


@router.get(
    "/preview",
    response_model=ExcelPreviewResponse,
    summary="Preview Excel headers and sample rows",
)
async def preview_excel(
    file_key: str = Query(..., description="MinIO file key from upload response"),
    header_mode: str = Query("ROW", pattern="^(ROW|COLUMN)$", description="Header orientation mode"),
    header_row_index: int = Query(1, ge=1, le=50, description="1-based row index where headers start"),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> ExcelPreviewResponse:
    """Return candidate fields and sample rows for guided template creation."""
    _ = current_user

    try:
        file_data = await minio_service.download_file(file_key)
    except FileNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"File not found in storage: {file_key}",
        )

    try:
        preview = excel_service.preview_excel(
            file_data,
            header_mode=header_mode,
            header_row_index=header_row_index,
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Failed to preview Excel file: {str(e)}",
        )

    return ExcelPreviewResponse(**preview)


@router.post(
    "/diff",
    response_model=DiffResponse,
    summary="Generate diff between uploaded Excel and DB",
)
async def generate_diff(
    file_key: str = Query(..., description="MinIO file key from upload response"),
    template_id: UUID = Query(..., description="Mapping template ID to use"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> DiffResponse:
    """
    Step 2-4 of Excel Diff & Merge:
    - Download file from MinIO
    - Parse with Pandas using MappingTemplate
    - Compare with current DB state
    - Return Delta (ADD/REMOVE/UPDATE)
    """
    # Fetch mapping template
    result = await db.execute(
        select(MappingTemplate).where(MappingTemplate.id == template_id)
    )
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Mapping template not found",
        )

    # Download file from MinIO
    try:
        file_data = await minio_service.download_file(file_key)
    except FileNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"File not found in storage: {file_key}",
        )

    # Parse Excel with mapping template
    parse_result = excel_service.parse_excel(file_data, template)

    if parse_result.errors and not parse_result.rows:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "message": "Failed to parse Excel file",
                "errors": parse_result.errors,
            },
        )

    # Pre-load ProductInfo master data for auto-filling scheduling fields
    product_info_result = await db.execute(select(ProductInfo))
    all_product_infos = product_info_result.scalars().all()
    product_info_lookup: dict[str, dict] = {}
    product_names_lower: dict[str, str] = {}
    for pi in all_product_infos:
        product_info_lookup[pi.product_name] = {
            "supply_days": pi.supply_days,
            "assembly_days": pi.assembly_days,
            "delivery_days": pi.delivery_days,
            "epoxy_minutes": pi.epoxy_minutes,
            "conformal_minutes": pi.conformal_minutes,
            "montaj_minutes": pi.montaj_minutes,
            "quality_minutes": pi.quality_minutes,
            "montaj_kalite_minutes": pi.montaj_kalite_minutes,
            "test1_minutes": pi.test1_minutes,
            "test2_minutes": pi.test2_minutes,
            "final_test_minutes": pi.final_test_minutes,
            "duration_mode": pi.duration_mode,
            "production_flat_days": pi.production_flat_days,
            "test_flat_days": pi.test_flat_days,
            "assembly_flat_days": pi.assembly_flat_days,
        }
        product_names_lower[pi.product_name.lower()] = pi.product_name

    # Diff with DB
    diff_result = await excel_service.diff_with_db(
        parsed_rows=parse_result.rows,
        mapping_template_id=template_id,
        db=db,
        product_info_lookup=product_info_lookup,
    )

    # Validate required scheduling fields for ADD/UPDATE entries using ProductInfo lookup
    for entry in diff_result.add + diff_result.update:
        row_data = {**entry.get("data", {}), **entry.get("base_data", {})}
        computed_base = excel_service.build_order_base_data(row_data, product_info_lookup=product_info_lookup)
        product_name = row_data.get("product_name", "Bilinmeyen Ürün")
        missing = excel_service.get_missing_required_fields(computed_base)
        for msg in missing:
            entry.setdefault("warnings", []).append(f"'{product_name}': {msg}")

    # Store diff for later apply
    diff_dict = diff_result.to_dict()
    _pending_diffs[file_key] = {
        "diff": diff_dict,
        "template_id": str(template_id),
        "user_id": str(current_user.id),
        "parsed_rows": parse_result.rows,
        "parse_warnings": parse_result.errors,
        "created_at": datetime.now(timezone.utc),
    }

    # Collect global import warnings/errors from parsed rows and diff entries
    import_warnings: list[str] = []
    import_errors: list[str] = []
    for row in parse_result.rows:
        row_warnings = row.get("_warnings", [])
        row_errors = row.get("_errors", [])
        import_warnings.extend(row_warnings)
        import_errors.extend(row_errors)
    for entry in diff_result.add + diff_result.update:
        import_warnings.extend(entry.get("warnings", []))
        import_errors.extend(entry.get("errors", []))

    # Build response
    response_data = diff_dict.copy()
    response_data["import_warnings"] = import_warnings
    response_data["import_errors"] = import_errors
    if parse_result.errors:
        response_data["parse_warnings"] = parse_result.errors

    return DiffResponse(**response_data)


@router.post(
    "/apply",
    response_model=DiffApplyResponse,
    summary="Apply diff results to the database",
)
async def apply_diff(
    file_key: str = Query(..., description="MinIO file key used in diff"),
    body: DiffApplyRequest = DiffApplyRequest(),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> DiffApplyResponse:
    """
    Apply the previously generated diff to the database.
    - ADD: Create new Order records
    - REMOVE: Soft-delete existing Orders (is_deleted=True, deleted_at=NOW)
    - UPDATE: Update existing Orders' base_data
    """
    # pop (not get): atomically claims this pending diff so a concurrent/retried
    # apply call for the SAME file_key (double-click, network retry, two tabs)
    # can't also read it — a second call arriving even a moment later finds it
    # already gone and gets a clean 404 instead of re-processing (and thus
    # duplicating) the same ADD/UPDATE/REMOVE rows. Safe without extra locking:
    # this process runs a single event loop (no --workers), so dict.pop() here
    # can't be interleaved with another request's dict.pop() on the same key.
    pending = _pending_diffs.pop(file_key, None)
    if not pending:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No pending diff found for this file. Run /diff first.",
        )

    diff = pending["diff"]
    template_id = UUID(pending["template_id"])
    exclude_ids = set(body.exclude_external_ids)

    # Pre-load ProductInfo master data for auto-filling scheduling fields
    product_info_result = await db.execute(select(ProductInfo))
    all_product_infos = product_info_result.scalars().all()
    product_info_lookup: dict[str, dict] = {}
    product_names_lower: dict[str, str] = {}
    for pi in all_product_infos:
        product_info_lookup[pi.product_name] = {
            "supply_days": pi.supply_days,
            "assembly_days": pi.assembly_days,
            "delivery_days": pi.delivery_days,
            "epoxy_minutes": pi.epoxy_minutes,
            "conformal_minutes": pi.conformal_minutes,
            "montaj_minutes": pi.montaj_minutes,
            "quality_minutes": pi.quality_minutes,
            "montaj_kalite_minutes": pi.montaj_kalite_minutes,
            "test1_minutes": pi.test1_minutes,
            "test2_minutes": pi.test2_minutes,
            "final_test_minutes": pi.final_test_minutes,
            "duration_mode": pi.duration_mode,
            "production_flat_days": pi.production_flat_days,
            "test_flat_days": pi.test_flat_days,
            "assembly_flat_days": pi.assembly_flat_days,
        }
        product_names_lower[pi.product_name.lower()] = pi.product_name

    added = 0
    removed = 0
    updated = 0
    skipped = 0

    now = datetime.now(timezone.utc)

    # BOM (alt ürün) türetimi için paylaşılan girdiler — döngü içinde satır
    # başına değil, tek seferde yüklenir (gantt.py'deki manuel sipariş
    # oluşturmayla aynı varsayılan: yeni siparişte henüz çalışan ataması yok).
    work_hours_per_day = await _get_work_hours_per_day(db)
    work_minutes = work_hours_per_day * 60
    holiday_days = await _get_holiday_days(db)
    default_emp = {"assembly": 1.0, "production": 1.0, "test": 1.0}

    # --- Apply ADDs ---
    if body.apply_adds:
        for entry in diff["add"]:
            if entry["external_id"] in exclude_ids:
                skipped += 1
                continue

            row_data = {**entry.get("data", {}), **entry.get("base_data", {})}
            existing_warnings = list(entry.get("warnings", []))

            # Check ProductInfo match for product_name
            product_name_raw = row_data.get("product_name")
            if product_name_raw:
                product_name_lower = str(product_name_raw).lower().strip()
                if product_name_lower not in product_names_lower:
                    existing_warnings.append(
                        f"Ürün '{product_name_raw}' master listede bulunamadı. "
                        f"Aşama süreleri (Tedarik/Dizgi/Kalite/Test/Teslimat) otomatik dolmayacak."
                    )

            # Resolve split window first — dates are mandatory
            split_start, split_end, _, split_warnings = _resolve_split_window(row_data, now)
            existing_warnings.extend(split_warnings)

            if split_start is None or split_end is None:
                skipped += 1
                continue

            base_data_dict = excel_service.build_order_base_data(row_data, product_info_lookup=product_info_lookup)

            # Validate required scheduling fields
            product_name = row_data.get("product_name", "Bilinmeyen Ürün")
            missing = excel_service.get_missing_required_fields(base_data_dict)
            if missing:
                for msg in missing:
                    existing_warnings.append(f"'{product_name}': {msg}")
                skipped += 1
                continue

            order_fields = excel_service.extract_order_fields(row_data)
            # split_end, Excel'deki (dahil) teslim tarihinin zamanlama için "hariç
            # tutan" (exclusive) sınırıdır (bkz. _resolve_split_window: end_dt+1).
            # Sipariş/teslim tarihi alanları için gerçek girilen günü kullanmak
            # üzere bir gün geri alınır; aksi halde promised_date her zaman
            # kullanıcının girdiği tarihten 1 gün ileri kaydedilir.
            resolved_promised_date = (split_end - timedelta(days=1)).date()
            # Söz verilen tarih hiç girilmemişse (Excel'de bu sütun yoksa/boşsa) bu
            # alan boş kalmasın diye kullanıcının girdiği teslimat tarihi kullanılır.
            promised_date = _coerce_date(order_fields.get("promised_date")) or resolved_promised_date
            # order_date hiç girilmemişse (Excel'de "order_date"/"siparis_tarihi"
            # sütunu yoksa) alan boş kalmasın diye üretim başlangıç tarihi (varsa)
            # sipariş tarihi olarak kullanılır.
            order_date = _coerce_date(order_fields.get("order_date")) or split_start.date()
            order = Order(
                external_id=entry["external_id"],
                mapping_template_id=template_id,
                base_data=base_data_dict,
                customer_name=order_fields.get("customer_name"),
                responsible_personnel=order_fields.get("responsible_personnel"),
                order_date=order_date,
                promised_date=promised_date,
                requirement_date=_coerce_date(order_fields.get("requirement_date")),
                penalty_date=_coerce_date(order_fields.get("penalty_date")),
                status=OrderStatus.PENDING.value,
                created_by=current_user.id,
            )
            db.add(order)
            await db.flush()

            # Extract quantity for DeliverySplit
            try:
                qty = float(row_data.get("quantity", 1.0))
                if qty <= 0:
                    existing_warnings.append(f"Miktar 0 veya negatif ({qty}). Varsayılan: 1 kullanıldı.")
                    qty = 1.0
            except (ValueError, TypeError):
                existing_warnings.append(f"Miktar geçersiz ('{row_data.get('quantity')}'). Varsayılan: 1 kullanıldı.")
                qty = 1.0
            
            # Create initial DeliverySplit
            initial_split = DeliverySplit(
                order_id=order.id,
                quantity=qty,
                start_date=split_start,
                end_date=split_end,
                manual_edit=False,
                created_by=current_user.id,
            )
            db.add(initial_split)
            await db.flush()

            # BOM: ürünün ProductInfo kataloğunda kayıtlı alt ürünleri varsa, onlar
            # için otomatik "bileşen siparişi" türet — gantt.py'deki manuel sipariş
            # oluşturmayla AYNI kural. Bu adım eskiden Excel importunda hiç
            # ÇALIŞMIYORDU: BOM'lu bir ürün Excel'den eklendiğinde alt ürünlerin
            # üretilmesi gerektiği sistem tarafından tamamen unutuluyordu (bkz.
            # ilgili kullanıcı bildirimi). BOM'suz ürünlerde components_ready_at hep
            # None döner, hiçbir şey değişmez.
            components_ready_at = await _derive_component_orders(
                db, order, product_name, qty, split_start, holiday_days,
                work_minutes, default_emp, current_user.id, initial_split.id,
            )
            if components_ready_at is not None:
                main_product_params = _build_product_params(order)
                recomputed_blocks = calculate_split_stage_ranges(
                    split_end, qty, main_product_params, default_emp, work_minutes, holiday_days,
                    is_outsourced=excel_service._coerce_bool(base_data_dict.get("is_outsourced")),
                    component_ready_at=components_ready_at,
                    start_date=split_start,
                )
                delivery_block = next((b for b in recomputed_blocks if b["key"] == "delivery"), None)
                if delivery_block is not None and delivery_block["end"] != initial_split.end_date:
                    initial_split.end_date = delivery_block["end"]
                    await db.flush()

            # Audit log
            audit = AuditLog(
                entity_type="order",
                entity_id=order.id,
                action=AuditAction.CREATE.value,
                old_value=None,
                new_value={"external_id": entry["external_id"], "base_data": order.base_data},
                performed_by=current_user.id,
            )
            db.add(audit)
            added += 1

    # --- Apply REMOVEs (soft-delete) ---
    if body.apply_removes:
        for entry in diff["remove"]:
            if entry["external_id"] in exclude_ids:
                skipped += 1
                continue

            order_id = UUID(entry["order_id"])
            result = await db.execute(
                select(Order)
                .where(Order.id == order_id)
                .options(selectinload(Order.delivery_splits))
            )
            order = result.scalar_one_or_none()

            if order and not order.is_deleted:
                old_data = {"status": order.status, "base_data": order.base_data}
                order.is_deleted = True
                order.deleted_at = now

                # Also soft-delete all active delivery splits
                # (ORM cascade only fires on db.delete(), not soft-delete)
                for ds in order.delivery_splits:
                    if not ds.is_deleted:
                        ds.is_deleted = True
                        ds.deleted_at = now

                # BOM: bu siparişin (varsa) türetilmiş alt ürün bileşenleri de
                # silinmeli — order_details.py/gantt.py'deki manuel silme ile AYNI
                # kural (bkz. cascade_soft_delete_components docstring). Bu adım
                # atlanırsa, Excel'den REMOVE edilen bir BOM ana siparişinin
                # bileşenleri is_deleted=False kalıp Gantt/adım takviminde "yetim"
                # olarak görünmeye devam eder.
                deleted_component_count = await cascade_soft_delete_components(db, order.id, now)

                # Audit log
                audit = AuditLog(
                    entity_type="order",
                    entity_id=order.id,
                    action=AuditAction.DELETE.value,
                    old_value=old_data,
                    new_value={
                        "is_deleted": True,
                        "deleted_at": now.isoformat(),
                        "deleted_component_count": deleted_component_count,
                    },
                    performed_by=current_user.id,
                )
                db.add(audit)
                removed += 1


    # --- Apply UPDATEs ---
    if body.apply_updates:
        for entry in diff["update"]:
            if entry["external_id"] in exclude_ids:
                skipped += 1
                continue

            order_id = UUID(entry["order_id"])
            result = await db.execute(select(Order).where(Order.id == order_id))
            order = result.scalar_one_or_none()

            if order:
                old_data = {"base_data": order.base_data}
                row_data = {**entry.get("data", {}), **entry.get("base_data", {})}

                existing_warnings = list(entry.get("warnings", []))
                product_name_raw = row_data.get("product_name")
                if product_name_raw:
                    product_name_lower = str(product_name_raw).lower().strip()
                    if product_name_lower not in product_names_lower:
                        existing_warnings.append(
                            f"Ürün '{product_name_raw}' master listede bulunamadı. "
                            f"Aşama süreleri güncellenmeyebilir."
                        )

                new_base_data = excel_service.build_order_base_data(row_data, order.base_data, product_info_lookup=product_info_lookup)

                # Warn about missing required fields (don't skip — order already exists)
                product_name = row_data.get("product_name", "Bilinmeyen Ürün")
                missing = excel_service.get_missing_required_fields(new_base_data)
                for msg in missing:
                    existing_warnings.append(f"'{product_name}': {msg}")

                order.base_data = new_base_data
                _apply_order_fields(order, row_data)

                split_start, split_end, has_explicit_date, split_warnings = _resolve_split_window(row_data, now)
                existing_warnings.extend(split_warnings)
                split_result = await db.execute(
                    select(DeliverySplit).where(
                        DeliverySplit.order_id == order.id,
                        DeliverySplit.is_deleted == False,  # noqa: E712
                        DeliverySplit.manual_edit == False,  # noqa: E712
                    )
                )
                auto_splits = split_result.scalars().all()
                if has_explicit_date and split_start is not None and split_end is not None:
                    for ds in auto_splits:
                        ds.start_date = split_start
                        ds.end_date = split_end

                # Miktar (quantity) — Order.base_data'da DEĞİL DeliverySplit'te tutulur,
                # bu yüzden yukarıdaki base_data/_apply_order_fields güncellemeleri onu
                # hiç etkilemez. _detect_changes'teki AYNI kısıtlama: yalnızca siparişin
                # tam olarak BİR "otomatik" split'i varsa güncellenir (birden fazla/hiç
                # yoksa — kullanıcı elle bölmüş/düzenlemişse — dokunulmaz). Bu adım
                # eskiden TAMAMEN eksikti: Excel'de yalnızca miktarı değişmiş bir satır
                # ne önizlemede görünüyor ne de uygulanınca DeliverySplit.quantity'ye
                # yazılıyordu (bkz. ilgili kullanıcı bildirimi/inceleme).
                new_qty_raw = row_data.get("quantity")
                if new_qty_raw is not None and str(new_qty_raw).strip() != "" and len(auto_splits) == 1:
                    try:
                        new_qty = float(new_qty_raw)
                        if new_qty > 0:
                            main_split = auto_splits[0]
                            old_qty = main_split.quantity or 0.0
                            if abs(new_qty - old_qty) > 1e-9 and main_split.stage_schedule:
                                # Onaylanmış özel takvim (varsa), eski miktara göre
                                # hesaplanmış blok sürelerini taşıyor — miktar değişince
                                # geçersiz kalır (bkz. order_details.py bulk-update
                                # "quantity" dalındaki AYNI gerekçe). manual_edit=False
                                # (Excel'in "otomatik" saydığı) bir split'in YİNE DE ayrı
                                # bir alan olan stage_schedule'ı dolu olabilir — kullanıcı
                                # tarih/miktarı elle değiştirmemiş ama iç aşama
                                # dökümünü özelleştirmiş olabilir.
                                main_split.stage_schedule = None
                            main_split.quantity = new_qty
                            # BOM: bağlı bileşen (component) split'lerin miktarı da AYNI
                            # ORANDA güncellenir — order_details.py bulk-update'teki
                            # (elle hücre düzenleme) AYNI kural/fonksiyon. Aksi halde
                            # Excel'den gelen yeni miktar, bileşen üretimiyle senkron
                            # kalmazdı (bileşen eski miktarda "yetim" kalırdı).
                            if old_qty > 0 and abs(new_qty - old_qty) > 1e-9:
                                comp_result = await db.execute(
                                    select(DeliverySplit).where(
                                        DeliverySplit.source_main_split_id == main_split.id,
                                        DeliverySplit.is_deleted == False,  # noqa: E712
                                    )
                                )
                                comp_splits = comp_result.scalars().all()
                                if comp_splits:
                                    ratio = new_qty / old_qty
                                    for comp_split in comp_splits:
                                        new_comp_qty = round(comp_split.quantity * ratio, 2)
                                        await _rescale_component_split(
                                            db, comp_split, new_comp_qty, holiday_days, work_minutes, default_emp,
                                        )
                        else:
                            existing_warnings.append(f"Miktar 0 veya negatif ({new_qty}). Güncellenmedi.")
                    except (ValueError, TypeError):
                        existing_warnings.append(f"Miktar geçersiz ('{new_qty_raw}'). Güncellenmedi.")

                # Audit log
                audit = AuditLog(
                    entity_type="order",
                    entity_id=order.id,
                    action=AuditAction.UPDATE.value,
                    old_value=old_data,
                    new_value={"base_data": new_base_data, "changes": entry.get("changes", [])},
                    performed_by=current_user.id,
                )
                db.add(audit)
                updated += 1

    # Commit all changes
    await db.commit()

    # Pending diff for this file_key was already removed at the top of this
    # function (see the pop() there) — nothing left to clean up here.

    # Opportunistically clean up stale pending diffs older than 2 hours
    stale_threshold = datetime.now(timezone.utc) - timedelta(hours=2)
    stale_keys = [
        k for k, v in list(_pending_diffs.items())
        if v.get("created_at", datetime.now(timezone.utc)) < stale_threshold
    ]
    for k in stale_keys:
        _pending_diffs.pop(k, None)

    return DiffApplyResponse(
        added=added,
        removed=removed,
        updated=updated,
        skipped=skipped,
        message=f"Diff applied: {added} added, {removed} removed, {updated} updated, {skipped} skipped",
    )



@router.get(
    "/orders",
    response_model=OrderListResponse,
    summary="List orders with pagination",
)
async def list_orders(
    template_id: UUID | None = Query(None, description="Filter by mapping template"),
    include_deleted: bool = Query(False, description="Include soft-deleted orders"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> OrderListResponse:
    """List orders with optional filtering and pagination."""
    # BOM bileşen siparişleri (parent_order_id dolu) bu listede görünmez — sadece
    # ana siparişlerin altında Gantt'ta nested olarak gösterilirler.
    query = select(Order).where(Order.parent_order_id.is_(None))

    if template_id:
        query = query.where(Order.mapping_template_id == template_id)

    if not include_deleted:
        query = query.where(Order.is_deleted == False)  # noqa: E712

    # Total count
    count_query = select(func.count()).select_from(query.subquery())
    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0

    # Pagination
    query = query.options(selectinload(Order.serial_numbers)).order_by(Order.created_at.desc())
    query = query.offset((page - 1) * page_size).limit(page_size)

    result = await db.execute(query)
    orders = result.scalars().all()

    # BOM: bir ana siparişin tamamlanma yüzdesi/aşama sayıları yalnızca KENDİ seri
    # numaralarına değil, aktif bileşenlerinin (varsa) seri numaralarına da bakmalı —
    # aksi halde bileşenler henüz üretimdeyken bile ana sipariş "%100 tamamlandı"
    # gösterebilir (bkz. gantt.py get_gantt_tasks / order_completion_email.py'deki
    # aynı kural). Sayfadaki siparişler için tek sorguda topluca çekilir (N+1 önlenir).
    page_order_ids = [o.id for o in orders]
    component_serials_by_parent: dict[UUID, list] = {}
    if page_order_ids:
        component_serials_result = await db.execute(
            select(Order.parent_order_id, OrderSerialNumber)
            .join(OrderSerialNumber, OrderSerialNumber.order_id == Order.id)
            .where(Order.parent_order_id.in_(page_order_ids), Order.is_deleted == False)  # noqa: E712
        )
        for parent_id, sn in component_serials_result.all():
            component_serials_by_parent.setdefault(parent_id, []).append(sn)

    # Build OrderRead list with completion metrics
    order_reads = []
    for o in orders:
        order_data = o.__dict__.copy()
        order_data.pop('_sa_instance_state', None)
        combined_serials = list(o.serial_numbers) + component_serials_by_parent.get(o.id, [])
        completion_percentage, stage_counts = calculate_completion_metrics(combined_serials)
        order_data['completion_percentage'] = completion_percentage
        order_data['stage_counts'] = stage_counts
        order_reads.append(OrderRead(**order_data))

    return OrderListResponse(
        orders=order_reads,
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post(
    "/import-product-info",
    response_model=ImportProductInfoResponse,
    status_code=status.HTTP_200_OK,
    summary="Import URUN_SURE sheet from uretim_Planlamadolu Excel into ProductInfo",
)
async def import_product_info(
    file: UploadFile = File(..., description="uretim_Planlamadolu.xlsx file"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
) -> ImportProductInfoResponse:
    """Parse URUN_SURE sheet and upsert into ProductInfo master data."""
    if not file.filename or not file.filename.endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="Only .xlsx files are accepted")

    file_data = await file.read()
    if len(file_data) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 50MB)")

    # Verify it's the expected format
    if not excel_service.detect_uretim_planlamadolu(file_data):
        raise HTTPException(
            status_code=422,
            detail="Excel formatı tanınmadı. Lütfen uretim_Planlamadolu şablonunu kullanın.",
        )

    products = excel_service.parse_urun_sure(file_data)
    if not products:
        raise HTTPException(status_code=422, detail="URUN_SURE sayfasında ürün bulunamadı.")

    added = 0
    updated = 0

    for prod in products:
        product_name = prod["product_name"]

        # Check if product already exists by product_name
        existing_result = await db.execute(
            select(ProductInfo).where(
                func.lower(ProductInfo.product_name) == product_name.lower()
            )
        )
        existing = existing_result.scalar_one_or_none()

        if existing:
            # Update existing product with URUN_SURE fields
            for key, val in prod.items():
                if val is not None and key not in ("_source", "supply_days", "delivery_days"):
                    setattr(existing, key, val)
            # Also update assembly_days if it was 0
            if prod.get("assembly_days") is not None:
                existing.assembly_days = prod["assembly_days"]
            updated += 1
        else:
            clean_prod = {k: v for k, v in prod.items() if k != "_source"}
            db.add(ProductInfo(**clean_prod))
            added += 1

    await db.commit()

    return ImportProductInfoResponse(
        added=added,
        updated=updated,
        total=len(products),
        message=f"URUN_SURE içe aktarıldı: {added} yeni eklendi, {updated} güncellendi.",
    )


@router.post(
    "/export-siparis-plan",
    summary="Export SIPARIS_PLAN with calculated production planning data",
)
async def export_siparis_plan(
    file: UploadFile = File(..., description="Original uretim_Planlamadolu.xlsx file"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
):
    """Generate a filled SIPARIS_PLAN Excel from existing order data."""
    if not file.filename or not file.filename.endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="Only .xlsx files are accepted")

    file_data = await file.read()
    if len(file_data) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 50MB)")

    if not excel_service.detect_uretim_planlamadolu(file_data):
        raise HTTPException(
            status_code=422,
            detail="Excel formatı tanınmadı. Lütfen uretim_Planlamadolu şablonunu kullanın.",
        )

    # Read working hours from KAPASITE
    calisma_saati = excel_service.read_calisma_saati(file_data)

    # Parse order input (columns A-I) from SIPARIS_PLAN
    orders = excel_service.parse_siparis_plan_input(file_data)
    if not orders:
        raise HTTPException(status_code=422, detail="SIPARIS_PLAN sayfasında sipariş bulunamadı.")

    # Parse URUN_SURE from the uploaded file (use its data directly, not from DB)
    urun_products = excel_service.parse_urun_sure(file_data)
    product_info_map: dict[str, dict] = {}
    for prod in urun_products:
        name = (prod.get("product_name") or "").strip().lower()
        if name:
            product_info_map[name] = {
                "assembly_days": prod.get("assembly_days", 0) or 0,
                "quality_minutes": prod.get("quality_minutes") or 0,
                "epoxy_minutes": prod.get("epoxy_minutes") or 0,
                "conformal_minutes": prod.get("conformal_minutes") or 0,
                "montaj_minutes": prod.get("montaj_minutes") or 0,
                "montaj_kalite_minutes": prod.get("montaj_kalite_minutes") or 0,
                "test1_minutes": prod.get("test1_minutes") or 0,
                "test2_minutes": prod.get("test2_minutes") or 0,
                "final_test_minutes": prod.get("final_test_minutes") or 0,
            }

    # Match orders to product info by product_name (exact match first, then prefix)
    for order in orders:
        pc = str(order.get("product_code", "")).strip().lower()
        if pc in product_info_map:
            order["_product_info"] = product_info_map[pc]
        else:
            matched = None
            for pname, data in product_info_map.items():
                if pc and (pname.startswith(pc) or pc.startswith(pname)):
                    matched = data
                    break
            order["_product_info"] = matched

    # Load holidays
    from app.models.official_holiday import OfficialHoliday
    holiday_result = await db.execute(select(OfficialHoliday))
    holidays_list = holiday_result.scalars().all()
    holidays = {h.holiday_date for h in holidays_list if h.holiday_date}

    import base64

    # Generate the filled Excel
    output_bytes, warnings, matched_count, unmatched_count = excel_service.generate_siparis_plan_export(
        file_data=file_data,
        orders=orders,
        product_info_map=product_info_map,
        holidays=holidays,
        calisma_saati=calisma_saati,
    )

    file_b64 = base64.b64encode(output_bytes).decode()

    return {
        "file_base64": file_b64,
        "file_name": "siparis_plan_dolu.xlsx",
        "warnings": warnings,
        "matched_count": matched_count,
        "unmatched_count": unmatched_count,
    }


@router.post(
    "/confirm-siparis-plan",
    status_code=status.HTTP_200_OK,
    summary="Import URUN_SURE + save SIPARIS_PLAN orders to DB after user confirmation",
)
async def confirm_siparis_plan(
    file: UploadFile = File(..., description="Original uretim_Planlamadolu.xlsx file"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
):
    """Import URUN_SURE into ProductInfo + save orders from SIPARIS_PLAN."""
    if not file.filename or not file.filename.endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="Only .xlsx files are accepted")

    file_data = await file.read()
    if len(file_data) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 50MB)")

    if not excel_service.detect_uretim_planlamadolu(file_data):
        raise HTTPException(
            status_code=422,
            detail="Excel formatı tanınmadı. Lütfen uretim_Planlamadolu şablonunu kullanın.",
        )

    # Load holidays for business-day calculations
    from app.models.official_holiday import OfficialHoliday
    holiday_result = await db.execute(select(OfficialHoliday))
    holidays_list = holiday_result.scalars().all()
    holidays = {h.holiday_date for h in holidays_list if h.holiday_date}

    # Read daily working hours
    calisma_saati = excel_service.read_calisma_saati(file_data)
    work_minutes = calisma_saati * 60

    # Persist work_hours_per_day for Gantt scheduling
    await db.merge(AppSetting(key="work_hours_per_day", value=str(float(calisma_saati))))
    await db.flush()

    # --- Step 1: Import URUN_SURE → ProductInfo ---
    products = excel_service.parse_urun_sure(file_data)
    added_products = 0
    updated_products = 0

    # Build product_info_map for auto-filling order base_data
    product_info_map: dict[str, dict] = {}
    for prod in products:
        pname = (prod.get("product_name") or "").strip().lower()
        if pname:
            product_info_map[pname] = {
                "supply_days": prod.get("supply_days", 0) or 0,
                "assembly_days": prod.get("assembly_days", 0) or 0,
                "delivery_days": prod.get("delivery_days", 0) or 0,
                "epoxy_minutes": prod.get("epoxy_minutes"),
                "conformal_minutes": prod.get("conformal_minutes"),
                "montaj_minutes": prod.get("montaj_minutes"),
                "quality_minutes": prod.get("quality_minutes"),
                "montaj_kalite_minutes": prod.get("montaj_kalite_minutes"),
                "test1_minutes": prod.get("test1_minutes"),
                "test2_minutes": prod.get("test2_minutes"),
                "final_test_minutes": prod.get("final_test_minutes"),
            }

    for prod in products:
        product_name = prod["product_name"]
        existing_result = await db.execute(
            select(ProductInfo).where(
                func.lower(ProductInfo.product_name) == product_name.lower()
            )
        )
        existing = existing_result.scalar_one_or_none()

        if existing:
            for key, val in prod.items():
                if val is not None and key not in ("_source", "supply_days", "delivery_days"):
                    setattr(existing, key, val)
            if prod.get("assembly_days") is not None:
                existing.assembly_days = prod["assembly_days"]
            updated_products += 1
        else:
            clean_prod = {k: v for k, v in prod.items() if k != "_source"}
            db.add(ProductInfo(**clean_prod))
            added_products += 1

    # --- Step 1.5: Parse TEDARIK sheet for supply_days ---
    tedarik_map = excel_service.parse_tedarik(file_data)
    tedarik_updated_products = 0

    # --- Step 2: Save SIPARIS_PLAN orders to DB ---
    orders = excel_service.parse_siparis_plan_input(file_data)
    created_orders = 0
    warnings: list[str] = []
    # BOM (alt ürün) türetimi için: yeni siparişte henüz çalışan ataması yok,
    # excel.py'nin ana ADD yoluyla ve gantt.py'deki manuel oluşturmayla aynı varsayılan.
    default_emp = {"assembly": 1.0, "production": 1.0, "test": 1.0}
    for order_data in orders:
        ext_id = str(order_data.get("siparis_no", "")).strip()
        # Clean float-style IDs: "231036.0" → "231036"
        if ext_id.endswith(".0") and ext_id.count(".") == 1:
            try:
                int(float(ext_id))
                ext_id = str(int(float(ext_id)))
            except ValueError:
                pass
        if not ext_id:
            continue

        product_code_raw = str(order_data.get("product_code") or "").strip()
        if not product_code_raw:
            continue

        # Match order to product info for auto-fill
        pc = product_code_raw.lower()
        pi_data = product_info_map.get(pc)
        # matched_product_name: eşleşen GERÇEK ürün adı (product_info_map anahtarı,
        # zaten küçük harfli) — pi_data yalnızca süre DEĞERLERİni taşıdığı için ayrıca
        # saklanmazsa BOM bileşen türetmesi (aşağıda) hangi ProductInfo kaydına
        # bakacağını bilemez. pc'nin kendisi kullanılamaz çünkü ön-ek eşleşmesinde
        # (startswith) product_code_raw ile gerçek ürün adı birebir aynı olmayabilir.
        matched_product_name = pc if pi_data else None
        if not pi_data:
            for pname, data in product_info_map.items():
                if pc and (pname.startswith(pc) or pc.startswith(pname)):
                    pi_data = data
                    matched_product_name = pname
                    break

        # Skip order if product not found in URUN_SURE
        if not pi_data:
            warnings.append(
                f"{ext_id} nolu sipariş ({product_code_raw}) ürün eşleşmesi olmadığı için eklenmedi."
            )
            continue

        base_data: dict = {
            "product_code": product_code_raw,
            "quantity": order_data.get("quantity"),
            "siparis_ss": order_data.get("siparis_ss"),
            "sevk_adet": order_data.get("sevk_adet"),
            "kalan_adet": order_data.get("kalan_adet"),
            "delivery_date": order_data.get("delivery_date"),
            "order_date": order_data.get("order_date"),
        }

        # Auto-fill product info fields from URUN_SURE
        for k, v in pi_data.items():
            if v is not None:
                base_data[k] = v

        # Override supply_days from TEDARIK sheet if matching row exists
        tedarik_key = (ext_id, product_code_raw)
        tedarik_supply_days = tedarik_map.get(tedarik_key)
        if tedarik_supply_days is not None:
            # +1 day for material preparation after supply arrives
            tedarik_supply_days += 1
            base_data["supply_days"] = tedarik_supply_days
            pi_data["supply_days"] = tedarik_supply_days

            # Update ProductInfo DB record for this product
            for t_prod in products:
                t_pname = t_prod["product_name"].lower()
                if t_pname.startswith(pc.lower()) or pc.lower().startswith(t_pname):
                    t_pi_result = await db.execute(
                        select(ProductInfo).where(
                            func.lower(ProductInfo.product_name) == t_prod["product_name"].lower()
                        )
                    )
                    t_pi = t_pi_result.scalar_one_or_none()
                    if t_pi and (t_pi.supply_days is None or t_pi.supply_days != tedarik_supply_days):
                        t_pi.supply_days = tedarik_supply_days
                        tedarik_updated_products += 1
                    break

        pc = product_code_raw

        # Find existing order with same external_id, product_code, and delivery_date.
        # BOM bileşen siparişleri (parent_order_id dolu) hariç tutulur — Excel eşleştirme
        # mantığı onları hiç görmemeli.
        existing_result = await db.execute(
            select(Order).where(
                Order.external_id == ext_id, Order.is_deleted == False, Order.parent_order_id.is_(None)
            )
        )
        existing_orders = existing_result.scalars().all()
        existing_order = None
        for eo in existing_orders:
            eo_pc = str((eo.base_data or {}).get("product_code", "") or "").strip()
            eo_dd = str((eo.base_data or {}).get("delivery_date", "") or "").strip()
            if eo_pc == pc and eo_dd == str(order_data.get("delivery_date", "") or "").strip():
                existing_order = eo
                break

        if existing_order:
            existing_order.is_deleted = False
            existing_order.customer_name = order_data.get("customer")
            existing_order.base_data = existing_order.base_data or {}
            existing_order.base_data.update(base_data)
            # Clear old split-related flags from previous lifecycle
            existing_order.base_data.pop("is_explicit_split", None)
            existing_order.base_data.pop("_auto_delivery_suppressed", None)
            existing_order.base_data.pop("split_piece_count", None)
            order_for_split = existing_order
            # BOM bileşen türetme YALNIZCA gerçekten yeni oluşturulan siparişlerde
            # tetiklenir (aşağıda) — var olan bir siparişte tekrar tetiklenirse
            # _derive_component_orders idempotent olmadığı için (her çağrıda
            # koşulsuz yeni Order satırları ekler) aynı bileşenler yinelenerek
            # mükerrer kayıt oluşturur.
            is_new_order = False

            # Check if order already has active splits
            split_check = await db.execute(
                select(DeliverySplit).where(
                    DeliverySplit.order_id == existing_order.id,
                    DeliverySplit.is_deleted == False,
                ).limit(1)
            )
            active_split = split_check.scalar_one_or_none()
            if active_split:
                # Already has a split, skip creating another
                continue

        else:
            new_order = Order(
                external_id=ext_id,
                customer_name=order_data.get("customer"),
                base_data=base_data,
                status=OrderStatus.PENDING.value,
                mapping_template_id=None,
                created_by=current_user.id,
            )
            db.add(new_order)
            created_orders += 1
            order_for_split = new_order
            is_new_order = True

            # Force flush so new_order.id is available
            await db.flush()

        # --- Create DeliverySplit with backward scheduling ---
        delivery_date_str = order_data.get("delivery_date")
        quantity = float(order_data.get("quantity", 1) or 1)
        delivery_dt = None

        if delivery_date_str:
            try:
                delivery_dt = datetime.fromisoformat(
                    str(delivery_date_str).replace("Z", "+00:00")
                )
            except ValueError:
                delivery_dt = None

        if delivery_dt:
            # Söz verilen tarih hiç girilmemişse (Excel'de bu sütun yoksa/boşsa) bu
            # alan boş kalmasın diye kullanıcının girdiği teslimat tarihi kullanılır.
            if not order_for_split.promised_date:
                order_for_split.promised_date = delivery_dt.date()

            qty = max(1, quantity)

            # Calculate total production workdays (same logic as Gantt chart)
            if pi_data:
                supply_d = pi_data.get("supply_days", 0) or 0
                assembly_d = pi_data.get("assembly_days", 0) or 0
                epoxy_m = pi_data.get("epoxy_minutes")
                conformal_m = pi_data.get("conformal_minutes")
                montaj_m = pi_data.get("montaj_minutes")
                kalite_m = pi_data.get("quality_minutes")
                montaj_kalite_m = pi_data.get("montaj_kalite_minutes")
                test1_m = pi_data.get("test1_minutes")
                test2_m = pi_data.get("test2_minutes")
                final_test_m = pi_data.get("final_test_minutes")
                delivery_d = pi_data.get("delivery_days", 0) or 0

                stage_days: list[int | None] = [
                    supply_d,
                    math.ceil(assembly_d * qty) if assembly_d else None,
                    math.ceil(kalite_m * qty / work_minutes) if kalite_m else None,
                    math.ceil(test1_m * qty / work_minutes) if test1_m else None,
                    math.ceil(epoxy_m * qty / work_minutes) if epoxy_m else None,
                    math.ceil(conformal_m * qty / work_minutes) if conformal_m else None,
                    math.ceil(test2_m * qty / work_minutes) if test2_m else None,
                    math.ceil(montaj_m * qty / work_minutes) if montaj_m else None,
                    math.ceil(montaj_kalite_m * qty / work_minutes) if montaj_kalite_m else None,
                    math.ceil(final_test_m * qty / work_minutes) if final_test_m else None,
                    delivery_d,
                ]
                total_days = sum(d for d in stage_days if d)
            else:
                total_days = 7  # fallback: 1 workweek

            # Backward schedule from delivery date
            start_dt = _subtract_workdays(delivery_dt, total_days, holidays)

            split = DeliverySplit(
                order_id=order_for_split.id,
                quantity=quantity,
                start_date=start_dt,
                end_date=delivery_dt,
                manual_edit=False,
                created_by=current_user.id,
            )
            db.add(split)
            await db.flush()

            # BOM: ürünün ProductInfo kataloğunda kayıtlı alt ürünleri varsa, onlar
            # için otomatik "bileşen siparişi" türet — excel.py'nin ana Excel ADD
            # yoluyla (ve gantt.py'deki manuel sipariş oluşturmayla) AYNI kural. Bu
            # adım eskiden bu (uretim_Planlamadolu) formatta da hiç ÇALIŞMIYORDU.
            # Yalnızca gerçekten yeni oluşturulan siparişte tetiklenir (bkz.
            # is_new_order tanımındaki gerekçe).
            if is_new_order and matched_product_name:
                components_ready_at = await _derive_component_orders(
                    db, order_for_split, matched_product_name, qty, start_dt, holidays,
                    work_minutes, default_emp, current_user.id, split.id,
                )
                if components_ready_at is not None:
                    main_product_params = _build_product_params(order_for_split)
                    recomputed_blocks = calculate_split_stage_ranges(
                        delivery_dt, qty, main_product_params, default_emp, work_minutes, holidays,
                        is_outsourced=excel_service._coerce_bool(order_for_split.base_data.get("is_outsourced")),
                        component_ready_at=components_ready_at,
                        start_date=start_dt,
                    )
                    delivery_block = next((b for b in recomputed_blocks if b["key"] == "delivery"), None)
                    if delivery_block is not None and delivery_block["end"] != split.end_date:
                        split.end_date = delivery_block["end"]
                        await db.flush()

    await db.commit()

    warning_text = " ".join(warnings) if warnings else ""
    if warning_text:
        warning_text = "\n" + warning_text

    tedarik_msg = f" Tedarikten {tedarik_updated_products} ürün güncellendi." if tedarik_updated_products else ""

    return {
        "message": f"Ürün bilgileri içe aktarıldı: {added_products} yeni, {updated_products} güncellendi. "
                   f"Siparişler kaydedildi: {created_orders} yeni sipariş.{tedarik_msg}{warning_text}",
        "added_products": added_products,
        "updated_products": updated_products,
        "created_orders": created_orders,
        "warnings": warnings,
    }
