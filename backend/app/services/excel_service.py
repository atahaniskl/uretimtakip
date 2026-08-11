"""
Excel Engine — Parse, Map, Diff & Merge.
Key Logic: Excel Diff & Merge.

Step 1: Upload .xlsx to MinIO (handled by minio_service)
Step 2: Pandas reads file. Use MappingTemplates to align columns.
        If unique_id_strategy is HASH, generate SHA-256(Configured_Columns).
Step 3: Compare with current DB state using external_id.
Step 4: Return Delta object:
        - ADD: New rows.
        - REMOVE: Missing rows (is_deleted=True, set deleted_at).
        - UPDATE: Changed cells (highlighted in UI).
"""

import hashlib
import io
import math
from datetime import date, datetime, timedelta, timezone
from uuid import UUID

import numpy as np
import pandas as pd
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.order import Order
from app.models.mapping_template import MappingTemplate
from app.models.delivery_split import DeliverySplit
from app.models.enums import UniqueIdStrategy

_START_DATE_KEYS = (
    "start_date", "date", "start",
    "baslangic", "başlangıç",
    "baslangic_tarihi", "başlangıç_tarihi",
    "baslangic tarihi", "başlangıç tarihi",
)

_END_DATE_KEYS = (
    "delivery_date", "end_date", "end", "delivery",
    "teslimat_tarihi", "teslim_tarihi", "teslim tarihi",
    "bitis_tarihi", "bitiş_tarihi", "bitis tarihi", "bitiş tarihi",
    "due_date",
)


class ExcelParseResult:
    """Result of parsing an Excel file with a mapping template."""

    def __init__(self, rows: list[dict], errors: list[str]):
        self.rows = rows
        self.errors = errors


class DiffResult:
    """
    Result of comparing Excel data with current DB state.
    Each entry contains the row data plus its external_id.
    """

    def __init__(self):
        self.add: list[dict] = []       # New rows not in DB
        self.remove: list[dict] = []    # Rows in DB but not in Excel
        self.update: list[dict] = []    # Rows with changed fields
        self.unchanged: int = 0         # Count of unchanged rows

    def to_dict(self) -> dict:
        # Helper to recursively clean NaN values for JSON serialization
        def clean_nan(obj):
            if isinstance(obj, dict):
                return {k: clean_nan(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                return [clean_nan(item) for item in obj]
            elif isinstance(obj, float):
                if np.isnan(obj):
                    return None
                return obj
            elif pd.isna(obj):
                return None
            return obj

        return {
            "add": clean_nan(self.add),
            "remove": clean_nan(self.remove),
            "update": clean_nan(self.update),
            "unchanged": self.unchanged,
            "summary": {
                "total_add": len(self.add),
                "total_remove": len(self.remove),
                "total_update": len(self.update),
                "total_unchanged": self.unchanged,
            },
        }


class ExcelService:
    """Service responsible for Excel file parsing, mapping, and diffing."""

    @staticmethod
    def _clean_nan_recursive(obj):
        """
        Recursively replace all NaN and numpy NaN values with None for JSON serialization.
        Handles dicts, lists, and primitive values.
        """
        if isinstance(obj, dict):
            return {k: ExcelService._clean_nan_recursive(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [ExcelService._clean_nan_recursive(item) for item in obj]
        elif isinstance(obj, float):
            # Check for NaN (both math.nan and np.nan)
            if np.isnan(obj):
                return None
            return obj
        elif pd.isna(obj):
            return None
        return obj

    ORDER_FIELD_ALIASES = {
        "customer_name": ("customer_name", "customer", "musteri", "musteri_adi", "müşteri", "müşteri_adı"),
        "responsible_personnel": ("responsible_personnel", "order_responsible", "responsible", "sorumlu", "siparis_sorumlusu"),
        "order_date": ("order_date", "siparis_tarihi", "sipariş_tarihi"),
        "promised_date": ("promised_date", "soz_verilen_tarih", "söz_verilen_tarih"),
        "requirement_date": ("requirement_date", "ihtiyac_tarihi", "ihtiyaç_tarihi"),
        "penalty_date": ("penalty_date", "ceza_tarihi", "cezaya_konu_tarih"),
    }

    BASE_DATA_FIELD_ALIASES = {
        "product_code": ("product_code", "urun_kodu", "ürün_kodu", "stok_kodu"),
        "product_name": ("product_name", "urun_adi", "ürün_adı", "name", "description"),
        "supply_days": ("supply_days", "tedarik_suresi", "tedarik_süresi", "lead_time", "lead_time_days"),
        "assembly_days": ("assembly_days", "dizgi_suresi", "dizgi_süresi", "assembly_time"),
        "epoxy_minutes": ("epoxy_minutes", "epoxy", "epoxy_dk"),
        "conformal_minutes": ("conformal_minutes", "conformal", "conformal_dk"),
        "montaj_minutes": ("montaj_minutes", "montaj", "montaj_dk"),
        "quality_minutes": ("quality_minutes", "kalite", "kalite_dk"),
        "montaj_kalite_minutes": ("montaj_kalite_minutes", "montaj_kalite", "montaj_kalite_dk"),
        "test1_minutes": ("test1_minutes", "test1", "test1_dk"),
        "test2_minutes": ("test2_minutes", "test2", "test2_dk"),
        "final_test_minutes": ("final_test_minutes", "final_test", "final_test_dk"),
        "delivery_days": ("delivery_days", "teslimat_suresi", "teslimat_süresi", "delivery_time"),
        "production_days": ("production_days", "uretim_suresi", "üretim_süresi", "production_time"),
        "outsource_days": ("outsource_days", "fason_days", "fason_suresi", "fason_süresi"),
        "is_outsourced": ("is_outsourced", "outsourced", "fason", "fason_mu", "fason_mi"),
        "production_mode": ("production_mode", "production_type", "uretim_tipi", "uretim_turu", "uretim_sekli"),
        "duration_mode": ("duration_mode", "sure_modu", "süre_modu"),
        "production_flat_days": ("production_flat_days", "uretim_toplam_gun", "üretim_toplam_gün"),
        "test_flat_days": ("test_flat_days", "test_toplam_gun", "test_toplam_gün"),
        "assembly_flat_days": ("assembly_flat_days", "dizgi_toplam_gun", "dizgi_toplam_gün"),
    }

    INTERNAL_BASE_DATA_KEYS = ("_manual_steps", "_auto_delivery_suppressed")

    REQUIRED_BASE_DATA_FIELDS = (
        "supply_days",
        "assembly_days",
        "delivery_days",
    )

    FIELD_LABELS: dict[str, str] = {
        "supply_days": "Tedarik (gün)",
        "assembly_days": "Dizgi (gün/adet)",
        "epoxy_minutes": "Epoxy (dk/adet)",
        "conformal_minutes": "Conformal (dk/adet)",
        "montaj_minutes": "Montaj (dk/adet)",
        "quality_minutes": "Kalite (dk/adet)",
        "montaj_kalite_minutes": "M.Kalite (dk/adet)",
        "test1_minutes": "Test1 (dk/adet)",
        "test2_minutes": "Test2 (dk/adet)",
        "final_test_minutes": "F.Test (dk/adet)",
        "delivery_days": "Teslimat (gün)",
    }

    PER_UNIT_FIELDS = ("assembly_days",)

    @classmethod
    def get_missing_required_fields(cls, base_data: dict) -> list[str]:
        errors: list[str] = []
        # Fason (dış dizgi): dizgi adımı dış firmada yapılır; assembly_days yerine
        # outsource_days (fason süresi) zorunludur.
        is_fason = cls._coerce_bool(base_data.get("is_outsourced"))
        for field in cls.REQUIRED_BASE_DATA_FIELDS:
            if field == "assembly_days" and is_fason:
                continue
            value = base_data.get(field)
            label = cls.FIELD_LABELS.get(field, field)
            if value is None:
                errors.append(f"{label} bilgisi girilmemiş.")
            elif field in cls.PER_UNIT_FIELDS and (not isinstance(value, (int, float)) or value <= 0):
                errors.append(f"{label} 0 veya geçersiz. Lütfen geçerli bir değer girin.")
        if is_fason:
            outsource = base_data.get("outsource_days")
            if not isinstance(outsource, (int, float)) or outsource <= 0:
                errors.append("Fason Süresi (gün) bilgisi girilmemiş veya geçersiz.")
        return errors

    @staticmethod
    def _coerce_bool(raw) -> bool:
        if isinstance(raw, bool):
            return raw
        if raw is None:
            return False
        val = str(raw).strip().lower()
        return val in {"1", "true", "t", "yes", "y", "evet", "e", "fason", "dis", "dış", "outsource", "outsourced"}

    @staticmethod
    def _is_order_suppressed(order: Order) -> bool:
        """Return True if order is hidden from scheduling via suppression flag."""
        base_data = order.base_data or {}
        return bool(base_data.get("_auto_delivery_suppressed", False))

    @staticmethod
    def _first_present(data: dict, aliases: tuple[str, ...]):
        for key in aliases:
            value = data.get(key)
            if value is not None and str(value).strip() != "":
                return value
        return None

    @classmethod
    def extract_order_fields(cls, row_data: dict) -> dict:
        """Extract first-class Order columns from canonical fields or aliases."""
        return {
            field: cls._first_present(row_data, aliases)
            for field, aliases in cls.ORDER_FIELD_ALIASES.items()
        }

    @classmethod
    def build_order_base_data(
        cls,
        row_data: dict,
        existing_base_data: dict | None = None,
        product_info_lookup: dict[str, dict] | None = None,
    ) -> dict:
        """
        Keep only operational scheduling metadata in base_data.
        
        If product_name matches an entry in product_info_lookup, auto-fill scheduling fields
        (supply_days, assembly_days, epoxy_minutes, conformal_minutes, montaj_minutes, quality_minutes, montaj_kalite_minutes, test1_minutes, test2_minutes, final_test_minutes, delivery_days, duration_mode, production_flat_days, test_flat_days)
        from the master product info, but respect any explicit values in row_data.
        Preserves internal keys from existing_base_data.

        First-class order columns, split quantity/dates, status, external id aliases and
        raw duplicate Excel aliases are intentionally not stored here.
        """
        base_data: dict = {}

        # Extract product_name to check ProductInfo master data
        product_name = cls._first_present(row_data, cls.BASE_DATA_FIELD_ALIASES["product_name"])
        product_info_data = {}

        if product_name and product_info_lookup:
            # Lookup is case-insensitive
            product_name_lower = str(product_name).lower().strip()
            for key, info in product_info_lookup.items():
                if key.lower() == product_name_lower:
                    product_info_data = info
                    break

        # Kullanıcı Excel'de/formda assembly_days'i açıkça girdi mi? Aşağıdaki fason
        # düzeltmesi bunu, döngüde master'dan otomatik dolan değerle karıştırmamak
        # için ayrıca saklıyor (bkz. altdaki not).
        explicit_assembly_days = cls._first_present(row_data, cls.BASE_DATA_FIELD_ALIASES["assembly_days"])

        # Build base_data with priority: row_data > product_info_data > (none)
        for field, aliases in cls.BASE_DATA_FIELD_ALIASES.items():
            # First check if user explicitly provided value in row_data
            value = cls._first_present(row_data, aliases)
            
            # If not provided, check if we can fill from ProductInfo master data
            if value is None and field in ("supply_days", "assembly_days", "delivery_days",
                                           "epoxy_minutes", "conformal_minutes", "montaj_minutes",
                                           "quality_minutes", "montaj_kalite_minutes",
                                           "test1_minutes", "test2_minutes", "final_test_minutes",
                                           "duration_mode"):
                # NOT: *_flat_days BILINCLI olarak yok — sure modu kaldirildi, urun ana
                # verisindeki toplam-gun degerleri zamanlamada kullanilmiyor. Kopyalanirsa
                # siparis base_data'sinda olu bir deger olarak kalir ve ekranla cizelgenin
                # celismesine yol acar (bkz. OrderDetailModal flatFieldValue notu).
                # These fields can be auto-filled from ProductInfo
                value = product_info_data.get(field)
            
            if value is not None:
                base_data[field] = value

        # Fason (dış dizgi) satırlarda "assembly_days" zorunlu tutulmaz (bkz.
        # get_missing_required_fields) — kullanıcı bunun yerine "outsource_days"
        # girer. Ama zamanlama motoru (date_utils.py _block_days) outsource_days'i
        # HİÇ okumaz, yalnızca production_days/assembly_days'i okur. Bu dönüşüm
        # yapılmazsa Excel'den içe aktarılan fason siparişlerin Dizgi aşaması
        # zamanlamadan tamamen düşer (assembly_d=None). outsource_days yine de
        # (onu okuyan diğer görüntüleme yerleri için) ayrıca saklanır.
        #
        # Kontrol "explicit_assembly_days is None" üzerinden yapılır (yukarıdaki
        # döngüde master'dan otomatik dolmuş base_data["assembly_days"] değil):
        # ürün ProductInfo master listesinde kayıtlıysa assembly_days, ürünün
        # normal (iç üretim) dizgi süresiyle otomatik dolar. Fason bir siparişte bu
        # süre geçerli değildir (iş dışarıda yapılıyor) — kullanıcı assembly_days'i
        # kendisi girmediyse master'dan gelen değeri outsource_days ile eziyoruz.
        if (
            cls._coerce_bool(base_data.get("is_outsourced"))
            and explicit_assembly_days is None
            and base_data.get("production_days") is None
            and base_data.get("outsource_days") is not None
        ):
            base_data["assembly_days"] = base_data["outsource_days"]

        # Preserve internal keys from existing_base_data
        for key in cls.INTERNAL_BASE_DATA_KEYS:
            if existing_base_data and key in existing_base_data:
                base_data[key] = existing_base_data[key]

        return base_data

    @staticmethod
    def _normalize_column_names(names: list) -> list[str]:
        """Normalize and deduplicate column names from Excel headers."""
        normalized: list[str] = []
        counters: dict[str, int] = {}

        for raw_name in names:
            name = str(raw_name).strip() if raw_name is not None else ""
            if not name or name.lower() == "nan":
                name = "Alan"

            if name in counters:
                counters[name] += 1
                name = f"{name}_{counters[name]}"
            else:
                counters[name] = 1

            normalized.append(name)

        return normalized

    def _read_dataframe(
        self,
        file_data: bytes,
        *,
        header_mode: str = "ROW",
        header_row_index: int = 1,
    ) -> pd.DataFrame:
        """Read Excel as dataframe according to header orientation configuration."""
        header_mode = (header_mode or "ROW").upper()
        header_row_index = max(1, int(header_row_index or 1))

        if header_mode == "ROW":
            df = pd.read_excel(
                io.BytesIO(file_data),
                engine="openpyxl",
                header=header_row_index - 1,
            )
            df.columns = self._normalize_column_names(list(df.columns))
            return df

        # COLUMN mode: first column contains field names, each following column is a record.
        raw_df = pd.read_excel(io.BytesIO(file_data), engine="openpyxl", header=None)
        start_row = header_row_index - 1
        data_df = raw_df.iloc[start_row:, :].reset_index(drop=True)

        if data_df.empty or data_df.shape[1] < 2:
            return pd.DataFrame()

        header_series = data_df.iloc[:, 0]
        valid_mask = (~header_series.isna()) & (header_series.astype(str).str.strip() != "")
        if not valid_mask.any():
            return pd.DataFrame()

        header_names = self._normalize_column_names(header_series[valid_mask].tolist())
        values_df = data_df.loc[valid_mask, 1:]
        values_df.index = header_names

        transposed = values_df.T.reset_index(drop=True)
        transposed.columns = header_names
        return transposed

    def preview_excel(
        self,
        file_data: bytes,
        *,
        header_mode: str = "ROW",
        header_row_index: int = 1,
    ) -> dict:
        """Build a lightweight preview for mapping-template wizard UI."""
        df = self._read_dataframe(
            file_data,
            header_mode=header_mode,
            header_row_index=header_row_index,
        )
        df = df.dropna(how="all").reset_index(drop=True)

        if df.empty:
            return {
                "header_mode": header_mode.upper(),
                "header_row_index": header_row_index,
                "candidate_columns": [],
                "sample_rows": [],
            }

        sample_df = df.head(5).copy()
        sample_df = sample_df.where(pd.notna(sample_df), None)
        sample_rows = sample_df.to_dict(orient="records")
        # Ensure no NaN values remain in the output for JSON serialization
        sample_rows = self._clean_nan_recursive(sample_rows)

        return {
            "header_mode": header_mode.upper(),
            "header_row_index": header_row_index,
            "candidate_columns": [str(col) for col in df.columns],
            "sample_rows": sample_rows,
        }

    def parse_excel(
        self,
        file_data: bytes,
        mapping_template: MappingTemplate,
    ) -> ExcelParseResult:
        """
        Parse an Excel file using a mapping template.
        Returns mapped rows and any parsing errors.
        """
        errors: list[str] = []
        rows: list[dict] = []

        parse_options = (mapping_template.unique_id_config or {}).get("parse_options", {})
        header_mode = parse_options.get("header_mode", "ROW")
        header_row_index = parse_options.get("header_row_index", 1)

        try:
            df = self._read_dataframe(
                file_data,
                header_mode=header_mode,
                header_row_index=header_row_index,
            )
        except Exception as e:
            return ExcelParseResult(rows=[], errors=[f"Failed to read Excel file: {str(e)}"])

        # Remove completely empty rows
        df = df.dropna(how="all").reset_index(drop=True)

        if df.empty:
            return ExcelParseResult(rows=[], errors=["Excel file contains no data rows"])

        column_map: dict = mapping_template.column_map
        # column_map format: {"excel_col_name": "system_field_name", ...}

        # Validate that required Excel columns exist
        missing_cols = []
        for excel_col in column_map.keys():
            if excel_col not in df.columns:
                missing_cols.append(excel_col)

        if missing_cols:
            errors.append(
                f"Missing Excel columns: {', '.join(missing_cols)}. "
                f"Available columns: {', '.join(df.columns.tolist())}"
            )
            return ExcelParseResult(rows=[], errors=errors)

        # Map columns
        for idx, row in df.iterrows():
            mapped_row: dict = {}
            extra_data: dict = {}
            row_errors: list[str] = []

            # Map configured columns
            for excel_col, system_field in column_map.items():
                value = row.get(excel_col)
                # Convert NaN to None
                if pd.isna(value):
                    value = None
                # Convert numpy types to Python types
                elif hasattr(value, "item"):
                    value = value.item()
                # Convert Timestamp to ISO string
                elif isinstance(value, pd.Timestamp):
                    value = value.isoformat()

                mapped_row[system_field] = value

            # Collect unmapped columns as extra data (base_data)
            for col in df.columns:
                if col not in column_map:
                    value = row.get(col)
                    if pd.isna(value):
                        value = None
                    elif hasattr(value, "item"):
                        value = value.item()
                    elif isinstance(value, pd.Timestamp):
                        value = value.isoformat()
                    extra_data[col] = value

            # Ensure all values in extra_data are properly serializable (no NaN)
            extra_data = self._clean_nan_recursive(extra_data)
            mapped_row["_base_data"] = extra_data
            mapped_row["_row_index"] = int(idx) + 2  # Excel row number (1-indexed + header)

            # Collect validation warnings/errors for this row
            row_warnings: list[str] = []
            row_errors: list[str] = []
            combined = {**mapped_row, **extra_data}
            has_start = any(combined.get(k) for k in _START_DATE_KEYS if combined.get(k) is not None)
            has_end = any(combined.get(k) for k in _END_DATE_KEYS if combined.get(k) is not None)
            if not has_start and not has_end:
                row_errors.append("Başlangıç ve bitiş tarihi belirtilmemiş. Tarih zorunludur — bu kayıt atlanacak.")
            elif has_start and not has_end:
                row_warnings.append("Bitiş tarihi belirtilmemiş. Başlangıç + 7 gün varsayılan olarak kullanılacak.")
            elif not has_start and has_end:
                row_warnings.append("Başlangıç tarihi belirtilmemiş. Teslimat gününe konumlandırılacak.")
            quantity_val = combined.get("quantity")
            if quantity_val is None or (isinstance(quantity_val, (int, float)) and quantity_val <= 0) or (isinstance(quantity_val, str) and not quantity_val.strip()):
                row_warnings.append("Miktar (quantity) belirtilmemiş veya geçersiz. Varsayılan: 1 kullanılacak.")
            mapped_row["_warnings"] = row_warnings
            mapped_row["_errors"] = row_errors

            # Generate external_id based on strategy
            external_id = self._generate_external_id(
                mapped_row,
                mapping_template,
                row_errors,
            )
            mapped_row["_external_id"] = external_id

            if row_errors:
                errors.extend([f"Row {idx + 2}: {e}" for e in row_errors])
            else:
                rows.append(mapped_row)

        return ExcelParseResult(rows=rows, errors=errors)

    def _generate_external_id(
        self,
        mapped_row: dict,
        mapping_template: MappingTemplate,
        errors: list[str],
    ) -> str | None:
        """
        Generate an external_id based on the mapping template's strategy.
        - COLUMN: Use the value from a specified column.
        - HASH: Generate SHA-256 from configured column values.
        """
        strategy = mapping_template.unique_id_strategy
        config = mapping_template.unique_id_config or {}

        if strategy == UniqueIdStrategy.COLUMN.value:
            # Config: {"column": "system_field_name"}
            id_field = config.get("column")
            if not id_field:
                errors.append("unique_id_config missing 'column' key for COLUMN strategy")
                return None
            value = mapped_row.get(id_field)
            if value is None:
                errors.append(f"ID column '{id_field}' is empty")
                return None
            ext_id = str(value)
            # Excel/pandas, ID kolonunda boş bir hücre varsa tüm kolonu int64'ten
            # float64'e yükseltir (ör. "12345" -> "12345.0") — bu düzeltme
            # yapılmazsa aynı sipariş bir sonraki içe aktarmada (kolon tekrar int
            # olduğunda) farklı bir external_id üretip DUPLICATE sipariş olarak
            # açılabilir. parse_tedarik'teki aynı düzeltmeyle birebir aynı kural.
            if ext_id.endswith(".0") and ext_id.count(".") == 1:
                try:
                    ext_id = str(int(float(ext_id)))
                except ValueError:
                    pass
            return ext_id

        elif strategy == UniqueIdStrategy.HASH.value:
            # Config: {"columns": ["field1", "field2", ...]}
            hash_columns = config.get("columns", [])
            if not hash_columns:
                errors.append("unique_id_config missing 'columns' key for HASH strategy")
                return None

            hash_values = []
            for col in hash_columns:
                value = mapped_row.get(col)
                if value is None:
                    value = ""
                hash_values.append(str(value))

            hash_input = "|".join(hash_values)
            return hashlib.sha256(hash_input.encode("utf-8")).hexdigest()

        else:
            errors.append(f"Unknown unique_id_strategy: {strategy}")
            return None

    async def diff_with_db(
        self,
        parsed_rows: list[dict],
        mapping_template_id: UUID,
        db: AsyncSession,
        product_info_lookup: dict[str, dict] | None = None,
    ) -> DiffResult:
        """
        Compare parsed Excel rows with current DB state.
        Returns a DiffResult with ADD, REMOVE, UPDATE, UNCHANGED counts.
        """
        diff = DiffResult()

        # Fetch existing non-deleted orders for this mapping template. BOM bileşen
        # siparişleri (parent_order_id dolu) hariç tutulur — aksi halde Excel'de
        # karşılığı olmayan bu otomatik siparişler yanlışlıkla "REMOVE" (silinecek)
        # olarak işaretlenebilir.
        result = await db.execute(
            select(Order).where(
                Order.mapping_template_id == mapping_template_id,
                Order.is_deleted == False,  # noqa: E712
                Order.parent_order_id.is_(None),
            )
        )
        existing_orders_raw = result.scalars().all()
        order_ids = [order.id for order in existing_orders_raw]

        # Yalnızca order_id değil, TAM split nesneleri (quantity/start_date/end_date/
        # manual_edit) de çekilir — _detect_changes'in miktar/tarih karşılaştırması
        # (aşağıda) bunlara ihtiyaç duyar (bkz. o metottaki gerekçe).
        active_split_order_ids: set[UUID] = set()
        splits_by_order_id: dict[UUID, list[DeliverySplit]] = {}
        if order_ids:
            active_split_result = await db.execute(
                select(DeliverySplit).where(
                    DeliverySplit.order_id.in_(order_ids),
                    DeliverySplit.is_deleted == False,  # noqa: E712
                )
            )
            for split in active_split_result.scalars().all():
                active_split_order_ids.add(split.order_id)
                splits_by_order_id.setdefault(split.order_id, []).append(split)

        existing_orders = [
            order
            for order in existing_orders_raw
            if (order.id in active_split_order_ids) and (not self._is_order_suppressed(order))
        ]


        # Build lookup by external_id
        db_lookup: dict[str, Order] = {
            order.external_id: order for order in existing_orders
        }

        # Track which DB orders are still present in Excel
        seen_external_ids: set[str] = set()

        for row in parsed_rows:
            external_id = row.get("_external_id")
            if not external_id:
                continue

            seen_external_ids.add(external_id)

            row_warnings = row.get("_warnings", [])
            row_errors = row.get("_errors", [])

            if external_id not in db_lookup:
                # --- ADD: New row not in DB ---
                diff.add.append({
                    "external_id": external_id,
                    "data": {k: v for k, v in row.items() if not k.startswith("_")},
                    "base_data": row.get("_base_data", {}),
                    "row_index": row.get("_row_index"),
                    "warnings": row_warnings,
                    "errors": row_errors,
                })
            else:
                # --- Check for UPDATE ---
                existing_order = db_lookup[external_id]
                changes = self._detect_changes(
                    row, existing_order, product_info_lookup,
                    splits_by_order_id.get(existing_order.id, []),
                )

                if changes:
                    diff.update.append({
                        "external_id": external_id,
                        "order_id": str(existing_order.id),
                        "changes": changes,
                        "data": {k: v for k, v in row.items() if not k.startswith("_")},
                        "base_data": row.get("_base_data", {}),
                        "row_index": row.get("_row_index"),
                        "warnings": row_warnings,
                        "errors": row_errors,
                    })
                else:
                    diff.unchanged += 1

        # --- REMOVE: Rows in DB but not in Excel ---
        for external_id, order in db_lookup.items():
            if external_id not in seen_external_ids:
                diff.remove.append({
                    "external_id": external_id,
                    "order_id": str(order.id),
                    "status": order.status,
                    "base_data": order.base_data or {},
                })

        return diff

    def _detect_changes(
        self,
        new_row: dict,
        existing_order: Order,
        product_info_lookup: dict[str, dict] | None = None,
        existing_splits: list[DeliverySplit] | None = None,
    ) -> list[dict]:
        """
        Compare a new Excel row with an existing DB order.
        Returns a list of changed fields with old and new values.
        """
        changes: list[dict] = []

        existing_base_data = existing_order.base_data or {}
        combined_new_row = {**new_row, **new_row.get("_base_data", {})}
        # product_info_lookup burada da (apply-update adımıyla AYNI şekilde) verilmezse,
        # Excel'de boş bırakılıp master'dan otomatik dolan alanlar (ör. supply_days)
        # burada None hesaplanır — DB'deki gerçek (master'dan dolu) değerle karşılaştırılınca
        # hiçbir şey değişmemiş olsa bile sahte bir "değer → boş" farkı raporlanırdı.
        new_base_data = self.build_order_base_data(
            combined_new_row, existing_base_data, product_info_lookup=product_info_lookup
        )

        # Compare base_data fields
        all_keys = set(list(existing_base_data.keys()) + list(new_base_data.keys()))
        for key in all_keys:
            old_val = existing_base_data.get(key)
            new_val = new_base_data.get(key)

            if self._values_differ(old_val, new_val):
                changes.append({
                    "field": key,
                    "old_value": old_val,
                    "new_value": new_val,
                    "source": "base_data",
                })

        # Compare mapped system fields stored in base_data
        # (actual system fields like status are not compared — they're managed internally)
        mapped_data = self.extract_order_fields(combined_new_row)
        for field, new_val in mapped_data.items():
            # new_val None ise (Excel'de bu alan hiç eşlenmemiş/boşsa) ATLANIR —
            # _apply_order_fields (excel.py) tam olarak bu durumda mevcut değere HİÇ
            # dokunmuyor (bkz. oradaki "BOSSA ... DOKUNULMAZ" yorumu). Bu atlama
            # yapılmazsa: order_date/promised_date/requirement_date/penalty_date'i
            # eşlemeyen (ki bu ÇOĞUNLUK durumdur — ör. yalnızca start_date/delivery_date
            # eşleyen şablonlar) HER şablonda, HİÇBİR ŞEY gerçekten değişmemiş olsa bile
            # her satır "old_value → null" diye sahte bir UPDATE olarak işaretlenirdi
            # (canlı testte doğrulandı: yalnızca miktarı değiştirilen bir satır, aslında
            # hiç eşlenmemiş promised_date'in "null"a "değiştiği" sahte sinyaliyle
            # UPDATE'e düşüyordu — asıl miktar değişikliği bu gürültüde kayboluyordu).
            if new_val is None:
                continue
            old_val = getattr(existing_order, field, None)
            if self._values_differ(old_val, new_val):
                changes.append({
                    "field": field,
                    "old_value": old_val,
                    "new_value": new_val,
                    "source": "mapped",
                })

        # Miktar (quantity) ve tarih (start_date/delivery_date) karşılaştırması —
        # bunlar Order.base_data'da DEĞİL, DeliverySplit'te tutulur, bu yüzden
        # yukarıdaki iki döngüye hiç girmezler. SADECE siparişin tam olarak BİR
        # "otomatik" (elle düzenlenmemiş, manual_edit=False) split'i varsa yapılır:
        # Excel içe aktarmanın normal ADD/UPDATE akışı zaten hep tek split üretir;
        # birden fazla ya da hiç yoksa (kullanıcı elle bölmüş/tamamen elle
        # düzenlemişse) buraya karışılmaz — "elle düzenlenene dokunma" felsefesiyle
        # tutarlı (bkz. excel.py apply-update'teki AYNI "yalnızca auto split'ler"
        # kısıtlaması). Bu kontrol olmadan: bir siparişin SADECE miktarı ya da SADECE
        # teslim tarihi değişip yeniden yüklendiğinde (gerçek dünyada en yaygın
        # yeniden-içe-aktarma sebebi) hiçbir şey algılanmıyor, satır sessizce
        # "değişmedi" sayılıp hem önizlemede gösterilmiyor hem de uygulanmıyordu
        # (izole testte doğrulandı: 0 değişiklik raporlanıyordu).
        auto_splits = [s for s in (existing_splits or []) if not s.manual_edit]
        if len(auto_splits) == 1:
            split = auto_splits[0]

            new_qty_raw = combined_new_row.get("quantity")
            if new_qty_raw is not None and str(new_qty_raw).strip() != "":
                try:
                    new_qty = float(new_qty_raw)
                    if new_qty > 0 and abs(new_qty - (split.quantity or 0.0)) > 1e-9:
                        changes.append({
                            "field": "quantity",
                            "old_value": split.quantity,
                            "new_value": new_qty,
                            "source": "split",
                        })
                except (ValueError, TypeError):
                    pass

            start_raw = next((combined_new_row.get(k) for k in _START_DATE_KEYS if combined_new_row.get(k) is not None), None)
            end_raw = next((combined_new_row.get(k) for k in _END_DATE_KEYS if combined_new_row.get(k) is not None), None)
            new_start = self._coerce_date_value(start_raw)
            new_end = self._coerce_date_value(end_raw)
            existing_start = split.start_date.date() if split.start_date else None
            # split.end_date, girilen (dahil) teslim tarihinin "hariç tutan" (exclusive)
            # sınırıdır (bkz. excel.py _resolve_split_window: end_dt+1) — Excel'deki
            # ham değerle karşılaştırmak için bir gün geri alınır.
            existing_end_inclusive = (split.end_date - timedelta(days=1)).date() if split.end_date else None
            if new_start is not None and new_start != existing_start:
                changes.append({
                    "field": "start_date",
                    "old_value": existing_start.isoformat() if existing_start else None,
                    "new_value": new_start.isoformat(),
                    "source": "split",
                })
            if new_end is not None and new_end != existing_end_inclusive:
                changes.append({
                    "field": "delivery_date",
                    "old_value": existing_end_inclusive.isoformat() if existing_end_inclusive else None,
                    "new_value": new_end.isoformat(),
                    "source": "split",
                })

        return changes

    @staticmethod
    def _coerce_date_value(value) -> date | None:
        """Excel'den gelen esnek bir tarih değerini (Excel serial / ISO / dd.mm.yyyy
        vb.) düz bir `date`'e çevirir. excel.py'deki (endpoint katmanı, timezone-
        farkındalı) `_coerce_datetime` ile AYNI format listesini kullanır — o
        fonksiyonu buradan İTHAL ETMEK (tam tersi yönde) döngüsel import'a yol
        açar, bu yüzden burada bağımsız, küçük bir kopyası tutulur."""
        if value is None:
            return None
        if isinstance(value, datetime):
            return value.date()
        if isinstance(value, date):
            return value
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            serial = float(value)
            if 1 <= serial <= 80000:
                return (datetime(1899, 12, 30) + timedelta(days=serial)).date()
            return None
        text = str(value).strip()
        if not text:
            return None
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
        except ValueError:
            pass
        for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%m/%d/%Y", "%Y/%m/%d", "%d-%m-%Y"):
            try:
                return datetime.strptime(text, fmt).date()
            except ValueError:
                continue
        return None

    @staticmethod
    def _values_differ(old_val, new_val) -> bool:
        """Compare two values, handling type conversions and None."""
        if old_val is None and new_val is None:
            return False
        if old_val is None or new_val is None:
            return True
        # Normalize types for comparison
        try:
            if isinstance(old_val, (int, float)) and isinstance(new_val, (int, float)):
                return abs(float(old_val) - float(new_val)) > 1e-9
        except (ValueError, TypeError):
            pass
        return str(old_val) != str(new_val)


    # ─── Üretim Planlama Excel (uretim_Planlamadolu) ─────────────────────────

    URUN_SURE_EXPECTED_COLS = {
        "Proje", "Seviye", "Dizgi_Gun_1Kart", "Kalite_Dk", "Test1_Dk",
        "Epoxy_Dk", "Conformal_Dk", "Test2_Dk", "Montaj_Dk",
        "Montaj_Kalite_Dk", "Final_Test_Dk",
    }
    SIPARIS_PLAN_EXPECTED_FIRST_COLS = {
        "Siparis No", "Sipariş SS", "Musteri", "Proje / Ana Proje",
        "Sipariş Adedi", "Sevk Adedi", "Kalan Adet", "Siparis Tarihi",
        "Teslim Tarihi",
    }

    @staticmethod
    def _normalize_col_for_compare(name: str) -> str:
        """Lowercase and remove Turkish characters for comparison."""
        name = name.lower().strip()
        tr_map = str.maketrans({"ş": "s", "ç": "c", "ğ": "g", "ü": "u", "ö": "o", "ı": "i"})
        name = name.translate(tr_map)
        name = name.replace("  ", " ").strip()
        return name

    @staticmethod
    def _read_sheet(file_data: bytes, sheet_name: str, header_row: int = 0) -> pd.DataFrame:
        """Read a specific sheet from an Excel file as a DataFrame."""
        xls = pd.ExcelFile(io.BytesIO(file_data), engine="openpyxl")
        if sheet_name not in xls.sheet_names:
            return pd.DataFrame()
        df = pd.read_excel(xls, sheet_name=sheet_name, header=header_row)
        df.columns = ExcelService._normalize_column_names(list(df.columns))
        return df

    @classmethod
    def detect_uretim_planlamadolu(cls, file_data: bytes) -> bool:
        """Detect if the uploaded Excel is the uretim_Planlamadolu format."""
        xls = pd.ExcelFile(io.BytesIO(file_data), engine="openpyxl")
        sheet_names = set(xls.sheet_names)

        # Must have both URUN_SURE and SIPARIS_PLAN sheets
        if "URUN_SURE" not in sheet_names or "SIPARIS_PLAN" not in sheet_names:
            return False

        # Normalize expected columns for comparison
        urun_expected_norm = {cls._normalize_col_for_compare(c) for c in cls.URUN_SURE_EXPECTED_COLS}
        siparis_expected_norm = {cls._normalize_col_for_compare(c) for c in cls.SIPARIS_PLAN_EXPECTED_FIRST_COLS}

        # Check URUN_SURE headers
        df_urun = cls._read_sheet(file_data, "URUN_SURE")
        if df_urun.empty:
            return False
        urun_cols = {cls._normalize_col_for_compare(str(c)) for c in df_urun.columns}
        if not urun_expected_norm.issubset(urun_cols):
            return False

        # Check SIPARIS_PLAN headers (first 9 cols)
        df_siparis = cls._read_sheet(file_data, "SIPARIS_PLAN")
        if df_siparis.empty:
            return False
        siparis_first_cols = {cls._normalize_col_for_compare(str(c)) for c in df_siparis.columns[:9]}
        if not siparis_expected_norm.issubset(siparis_first_cols):
            return False

        return True

    @classmethod
    def parse_urun_sure(cls, file_data: bytes) -> list[dict]:
        """Parse URUN_SURE sheet rows into product dicts."""
        df = cls._read_sheet(file_data, "URUN_SURE")
        df = df.dropna(how="all").reset_index(drop=True)
        if df.empty:
            return []

        products = []
        for _, row in df.iterrows():
            proje = row.get("Proje")
            if pd.isna(proje) or not str(proje).strip():
                continue
            product = {
                "product_name": str(proje).strip(),
                "assembly_days": cls._float_val(row.get("Dizgi_Gun_1Kart"), 0),
                "quality_minutes": cls._float_val(row.get("Kalite_Dk")),
                "test1_minutes": cls._float_val(row.get("Test1_Dk")),
                "epoxy_minutes": cls._float_val(row.get("Epoxy_Dk")),
                "conformal_minutes": cls._float_val(row.get("Conformal_Dk")),
                "test2_minutes": cls._float_val(row.get("Test2_Dk")),
                "montaj_minutes": cls._float_val(row.get("Montaj_Dk")),
                "montaj_kalite_minutes": cls._float_val(row.get("Montaj_Kalite_Dk")),
                "final_test_minutes": cls._float_val(row.get("Final_Test_Dk")),
                "supply_days": 0,
                "delivery_days": 0,
                "_source": "URUN_SURE",
            }
            products.append(product)
        return products

    @classmethod
    def parse_tedarik(cls, file_data: bytes) -> dict[tuple[str, str], int]:
        """Parse TEDARIK sheet, return {(siparis_no, proje): supply_days}.

        Header is at row 4 (0-indexed row 3).
        Looks up columns: Siparis No (A), Proje / Ana Proje (B),
        Siparis Verilis Tarihi (F), Termin Tarihi (G).
        Computes supply_days = (termin - verilis).days.
        """
        df = cls._read_sheet(file_data, "TEDARIK", header_row=3)
        df = df.dropna(how="all").reset_index(drop=True)
        if df.empty:
            return {}

        col_map = {}
        for col_name in df.columns:
            norm = cls._normalize_col_for_compare(str(col_name))
            if norm == "siparis no":
                col_map["siparis_no"] = col_name
            elif norm == "proje / ana proje":
                col_map["proje"] = col_name
            elif "siparis verilis" in norm or "verilis tarihi" in norm:
                col_map["verilis"] = col_name
            elif "termin tarihi" in norm or norm == "termin":
                col_map["termin"] = col_name

        if "siparis_no" not in col_map or "verilis" not in col_map or "termin" not in col_map:
            return {}

        result: dict[tuple[str, str], int] = {}
        for _, row in df.iterrows():
            raw_no = row.get(col_map["siparis_no"])
            if pd.isna(raw_no) or not str(raw_no).strip():
                continue

            ext_id = str(raw_no).strip()
            if ext_id.endswith(".0") and ext_id.count(".") == 1:
                try:
                    ext_id = str(int(float(ext_id)))
                except ValueError:
                    pass

            raw_proje = row.get(col_map.get("proje"))
            proje_str = str(raw_proje).strip() if pd.notna(raw_proje) and str(raw_proje).strip() else ""

            raw_verilis = row.get(col_map["verilis"])
            raw_termin = row.get(col_map["termin"])

            if pd.isna(raw_verilis) or pd.isna(raw_termin):
                continue

            try:
                if isinstance(raw_verilis, pd.Timestamp):
                    v_dt = raw_verilis.to_pydatetime()
                else:
                    v_dt = pd.to_datetime(str(raw_verilis))

                if isinstance(raw_termin, pd.Timestamp):
                    t_dt = raw_termin.to_pydatetime()
                else:
                    t_dt = pd.to_datetime(str(raw_termin))

                supply_days = (t_dt.date() - v_dt.date()).days
                if supply_days < 0:
                    supply_days = 0

                key = (ext_id, proje_str)
                if key not in result:
                    result[key] = supply_days
            except (ValueError, TypeError):
                continue

        return result

    @staticmethod
    def _float_val(value, default=None) -> float | None:
        """Safely convert a value to float, returning default on failure."""
        if value is None or pd.isna(value):
            return default
        try:
            v = float(value)
            if np.isnan(v):
                return default
            return v
        except (ValueError, TypeError):
            return default

    @staticmethod
    def read_calisma_saati(file_data: bytes) -> float:
        """Read daily working hours from KAPASITE sheet B2."""
        df = ExcelService._read_sheet(file_data, "KAPASITE")
        if df.empty:
            return 8.0
        for _, row in df.iterrows():
            param = str(row.get("Parametre", "")).strip().lower() if pd.notna(row.get("Parametre")) else ""
            if "calisma" in param or "çalışma" in param:
                val = row.get("Deger")
                if pd.notna(val):
                    try:
                        return float(val)
                    except (ValueError, TypeError):
                        pass
                break
        return 8.0

    @classmethod
    def parse_siparis_plan_input(cls, file_data: bytes) -> list[dict]:
        """
        Parse SIPARIS_PLAN sheet columns A-I (order input columns).
        Returns a list of order dicts with keys matching the existing import format.
        """
        df = cls._read_sheet(file_data, "SIPARIS_PLAN")
        # Keep original index (0 = Excel row 2) so _row_index stays correct
        df = df.dropna(how="all")
        if df.empty:
            return []

        # Normalize column names: lowercase + remove Turkish chars, then build a reverse map
        df_normalized_cols = {cls._normalize_col_for_compare(c): c for c in df.columns}
        col_map = {
            "siparis no": "siparis_no",
            "siparis ss": "siparis_ss",
            "musteri": "customer",
            "proje / ana proje": "product_code",
            "siparis adedi": "quantity",
            "sevk adedi": "sevk_adet",
            "kalan adet": "kalan_adet",
            "siparis tarihi": "order_date",
            "teslim tarihi": "delivery_date",
            "dizgi modu": "dizgi_modu",
            "efektif dizgi modu": "efektif_dizgi_modu",
        }

        rows = []
        for _, row in df.iterrows():
            entry = {}
            for norm_key, sys_key in col_map.items():
                actual_col = df_normalized_cols.get(norm_key)
                val = row.get(actual_col) if actual_col else None
                if pd.isna(val):
                    val = None
                elif isinstance(val, pd.Timestamp):
                    val = val.isoformat()
                elif hasattr(val, "item"):
                    val = val.item()
                entry[sys_key] = val

            # Skip rows without siparis_no and product_code
            if not entry.get("siparis_no") or not entry.get("product_code"):
                continue

            # Ensure quantity
            qty = entry.get("quantity")
            if qty is None or (isinstance(qty, (int, float)) and qty <= 0):
                qty = 1
            entry["quantity"] = float(qty) if qty else 1.0

            entry["_row_index"] = int(_.name) + 2 if hasattr(_, "name") else 2
            rows.append(entry)

        return rows

    @staticmethod
    def _add_business_days(start_date, days: int, holidays: set) -> datetime:
        """Add business days to a date (skip weekends and holidays)."""
        current = start_date
        remaining = days
        while remaining > 0:
            current += timedelta(days=1)
            if current.weekday() >= 5:  # Saturday=5, Sunday=6
                continue
            date_key = current.date()
            if date_key in holidays:
                continue
            remaining -= 1
        return current

    @staticmethod
    def _subtract_business_days(end_date, days: int, holidays: set) -> datetime:
        """Subtract business days from a date (going backward, skip weekends/holidays)."""
        current = end_date
        remaining = days
        while remaining > 0:
            current -= timedelta(days=1)
            if current.weekday() >= 5:
                continue
            date_key = current.date()
            if date_key in holidays:
                continue
            remaining -= 1
        return current

    @classmethod
    @classmethod
    def _build_column_map(cls, ws) -> dict[str, int]:
        """Build normalized header->column map, falling back to fixed positions."""
        # Known uretim_Planlamadolu column structure (column_letter -> normalized header)
        FIXED_COLUMNS: dict[str, str] = {
            "A": "siparis no", "B": "siparis ss", "C": "musteri",
            "D": "proje / ana proje", "E": "siparis adedi", "F": "sevk adedi",
            "G": "kalan adet", "H": "siparis tarihi", "I": "teslim tarihi",
            "J": "oncelik", "K": "dizgi gun/adet", "L": "kalite dk/adet",
            "M": "test1 dk/adet", "N": "epoxy dk/adet", "O": "conformal dk/adet",
            "P": "test2 dk/adet", "Q": "montaj dk/adet", "R": "final test dk/adet",
            "S": "toplam dizgi gun", "T": "toplam kalite dk", "U": "toplam test1 dk",
            "V": "toplam epoxy dk", "W": "toplam conformal dk", "X": "toplam test2 dk",
            "Y": "toplam montaj dk", "Z": "toplam final test dk",
            "AA": "dizgi gun ihtiyaci", "AB": "kalite gun ihtiyaci",
            "AC": "test1 gun ihtiyaci", "AD": "epoxy gun ihtiyaci",
            "AE": "conformal gun ihtiyaci", "AF": "test2 gun ihtiyaci",
            "AG": "montaj gun ihtiyaci", "AH": "final test gun ihtiyaci",
            "AI": "dizgi baslangic / fason termin", "AJ": "kalite baslangic",
            "AK": "test1 baslangic", "AL": "epoxy baslangic",
            "AM": "conformal baslangic", "AN": "test2 baslangic",
            "AO": "montaj baslangic", "AP": "final test baslangic",
            "AQ": "bugun yapilmasi gereken", "AR": "risk durumu",
            "AS": "dizgi modu", "AT": "fason dizgi gun/adet",
            "AU": "otomatik fason oneri", "AV": "efektif dizgi modu",
            "AW": "ana proje", "AX": "tedarik anahtari",
            "AY": "malzeme durumu", "AZ": "tedarik riski",
            "BA": "kritik termin", "BB": "uretime baslama onayi",
        }

        # Try building from header row (text values only)
        from openpyxl.utils import column_index_from_string
        header_map: dict[str, int] = {}
        for col_idx in range(1, ws.max_column + 1):
            val = ws.cell(row=1, column=col_idx).value
            if val and isinstance(val, str) and not val.startswith("="):
                header_map[cls._normalize_col_for_compare(val)] = col_idx

        # Fill in missing columns from fixed map
        for col_letter, norm_name in FIXED_COLUMNS.items():
            if norm_name not in header_map:
                try:
                    col_idx = column_index_from_string(col_letter)
                    header_map[norm_name] = col_idx
                except Exception:
                    pass
        return header_map

    @classmethod
    def generate_siparis_plan_export(
        cls,
        file_data: bytes,
        orders: list,
        product_info_map: dict[str, dict],
        holidays: set,
        calisma_saati: float = 8.0,
    ) -> tuple[bytes, list[str], int, int]:
        """
        Generate a filled SIPARIS_PLAN Excel from the original template.
        Reads the original template, fills A-I from orders, calculates K-BB,
        returns the .xlsx bytes.
        """
        import openpyxl
        from openpyxl.utils import get_column_letter
        from copy import copy

        # Load original workbook
        wb = openpyxl.load_workbook(io.BytesIO(file_data))
        ws = wb["SIPARIS_PLAN"]

        header_map = cls._build_column_map(ws)

        def _h(name: str) -> int | None:
            return header_map.get(cls._normalize_col_for_compare(name))

        calisma_dk = calisma_saati * 60
        warnings: list[str] = []
        matched_count = 0
        unmatched_count = 0
        unmatched_by_code: dict[str, int] = {}
        invalid_date_by_code: dict[str, int] = {}

        # Process each order row (starting from row 2)
        row_idx = 2
        for order in orders:
            # --- Columns A-I (input columns, fill from order data) ---
            cls._set_cell(ws, row_idx, _h("Siparis No"), order.get("siparis_no"))
            cls._set_cell(ws, row_idx, _h("Sipariş SS"), order.get("siparis_ss"))
            cls._set_cell(ws, row_idx, _h("Musteri"), order.get("customer"))
            cls._set_cell(ws, row_idx, _h("Sipariş Adedi"), order.get("quantity"))
            cls._set_cell(ws, row_idx, _h("Sevk Adedi"), order.get("sevk_adet"))
            cls._set_cell(ws, row_idx, _h("Kalan Adet"), order.get("kalan_adet"))
            cls._set_cell(ws, row_idx, _h("Siparis Tarihi"), order.get("order_date"))
            cls._set_cell(ws, row_idx, _h("Teslim Tarihi"), order.get("delivery_date"))

            raw_product_code = str(order.get("product_code", "")).strip()
            pi = order.get("_product_info") or (product_info_map.get(raw_product_code.lower()) if raw_product_code else None)

            if pi:
                qty = float(order.get("quantity", 1))

                # K-R: Per-unit durations
                dizgi_gun = pi.get("assembly_days", 0) or 0
                kalite_dk = (pi.get("quality_minutes") or 0) + (pi.get("montaj_kalite_minutes") or 0)
                test1_dk = pi.get("test1_minutes") or 0
                epoxy_dk = pi.get("epoxy_minutes") or 0
                conformal_dk = pi.get("conformal_minutes") or 0
                test2_dk = pi.get("test2_minutes") or 0
                montaj_dk = pi.get("montaj_minutes") or 0
                final_test_dk = pi.get("final_test_minutes") or 0

                cls._set_cell(ws, row_idx, _h("Dizgi Gun/Adet"), dizgi_gun)
                cls._set_cell(ws, row_idx, _h("Kalite Dk/Adet"), kalite_dk)
                cls._set_cell(ws, row_idx, _h("Test1 Dk/Adet"), test1_dk)
                cls._set_cell(ws, row_idx, _h("Epoxy Dk/Adet"), epoxy_dk)
                cls._set_cell(ws, row_idx, _h("Conformal Dk/Adet"), conformal_dk)
                cls._set_cell(ws, row_idx, _h("Test2 Dk/Adet"), test2_dk)
                cls._set_cell(ws, row_idx, _h("Montaj Dk/Adet"), montaj_dk)
                cls._set_cell(ws, row_idx, _h("Final Test Dk/Adet"), final_test_dk)

                # S-Z: Totals
                is_fason = str(order.get("dizgi_modu", "") or order.get("efektif_dizgi_modu", "")).strip() == "FASON"

                toplam_dizgi_gun = 0 if is_fason else qty * dizgi_gun
                toplam_kalite_dk = qty * kalite_dk
                toplam_test1_dk = qty * test1_dk
                toplam_epoxy_dk = qty * epoxy_dk
                toplam_conformal_dk = qty * conformal_dk
                toplam_test2_dk = qty * test2_dk
                toplam_montaj_dk = qty * montaj_dk
                toplam_final_test_dk = qty * final_test_dk

                cls._set_cell(ws, row_idx, _h("Toplam Dizgi Gun"), toplam_dizgi_gun)
                cls._set_cell(ws, row_idx, _h("Toplam Kalite Dk"), toplam_kalite_dk)
                cls._set_cell(ws, row_idx, _h("Toplam Test1 Dk"), toplam_test1_dk)
                cls._set_cell(ws, row_idx, _h("Toplam Epoxy Dk"), toplam_epoxy_dk)
                cls._set_cell(ws, row_idx, _h("Toplam Conformal Dk"), toplam_conformal_dk)
                cls._set_cell(ws, row_idx, _h("Toplam Test2 Dk"), toplam_test2_dk)
                cls._set_cell(ws, row_idx, _h("Toplam Montaj Dk"), toplam_montaj_dk)
                cls._set_cell(ws, row_idx, _h("Toplam Final Test Dk"), toplam_final_test_dk)

                # Read KAPASITE values from template
                kap_wb = openpyxl.load_workbook(io.BytesIO(file_data), data_only=True)
                ws_kap = kap_wb["KAPASITE"]
                kap_calisma_saati = float(ws_kap.cell(2, 2).value or calisma_saati)
                kap_kalite_kisi = float(ws_kap.cell(5, 2).value or 1)
                kap_montaj_kisi = float(ws_kap.cell(6, 2).value or 3)
                kap_test_kisi = float(ws_kap.cell(7, 2).value or 0)
                kap_fason_gun_adet = float(ws_kap.cell(11, 2).value or 1)

                gunluk_dk = kap_calisma_saati * 60
                kalite_kap_dk = gunluk_dk * kap_kalite_kisi       # B8
                montaj_kap_dk = gunluk_dk * kap_montaj_kisi        # B9
                test_kap_dk = gunluk_dk * kap_test_kisi            # B10

                # AA-AH: Gun ihtiyaci (total / daily capacity per process)
                # AA = S (formulde oldugu gibi: =IF(S="","",S))
                cls._set_cell(ws, row_idx, _h("Dizgi Gun Ihtiyaci"), toplam_dizgi_gun)
                # AB-AH: toplam_dk / kapasite_dk_gun
                cls._set_cell(ws, row_idx, _h("Kalite Gun Ihtiyaci"), toplam_kalite_dk / kalite_kap_dk if kalite_kap_dk > 0 else 0)
                cls._set_cell(ws, row_idx, _h("Test1 Gun Ihtiyaci"), toplam_test1_dk / test_kap_dk if test_kap_dk > 0 else 0)
                cls._set_cell(ws, row_idx, _h("Epoxy Gun Ihtiyaci"), toplam_epoxy_dk / montaj_kap_dk if montaj_kap_dk > 0 else 0)
                cls._set_cell(ws, row_idx, _h("Conformal Gun Ihtiyaci"), toplam_conformal_dk / montaj_kap_dk if montaj_kap_dk > 0 else 0)
                cls._set_cell(ws, row_idx, _h("Test2 Gun Ihtiyaci"), toplam_test2_dk / test_kap_dk if test_kap_dk > 0 else 0)
                cls._set_cell(ws, row_idx, _h("Montaj Gun Ihtiyaci"), toplam_montaj_dk / montaj_kap_dk if montaj_kap_dk > 0 else 0)
                cls._set_cell(ws, row_idx, _h("Final Test Gun Ihtiyaci"), toplam_final_test_dk / test_kap_dk if test_kap_dk > 0 else 0)

                # AI-AP: Backward scheduling from delivery date
                # Formul mantigi: WORKDAY.INTL(onceki_tarih, -ROUNDUP(gun_ihtiyaci,0), "0000011")
                # Sira: Teslim'den geriye: Final Test → Montaj → Test2 → Conformal → Epoxy → Test1 → Kalite → Dizgi
                delivery_date = order.get("delivery_date")
                if delivery_date:
                    if isinstance(delivery_date, str):
                        try:
                            delivery_dt = datetime.fromisoformat(delivery_date.replace("Z", "+00:00"))
                        except ValueError:
                            delivery_dt = None
                    elif isinstance(delivery_date, datetime):
                        delivery_dt = delivery_date
                    elif isinstance(delivery_date, date) and not isinstance(delivery_date, datetime):
                        delivery_dt = datetime(delivery_date.year, delivery_date.month, delivery_date.day, tzinfo=timezone.utc)
                    else:
                        delivery_dt = None
                else:
                    delivery_dt = None

                if delivery_dt:
                    current_date = delivery_dt

                    # AP: Final Test Baslangic = WORKDAY.INTL(I, -(ROUNDUP(AH,0)+1), "0000011")
                    gun = math.ceil(toplam_final_test_dk / test_kap_dk) if test_kap_dk > 0 and toplam_final_test_dk > 0 else 0
                    if gun > 0:
                        current_date = cls._subtract_business_days(current_date, gun + 1, holidays)
                    cls._set_cell(ws, row_idx, _h("Final Test Baslangic"), current_date)

                    # AO: Montaj Baslangic = WORKDAY.INTL(AP, -ROUNDUP(AG,0), "0000011")
                    gun = math.ceil(toplam_montaj_dk / montaj_kap_dk) if montaj_kap_dk > 0 and toplam_montaj_dk > 0 else 0
                    if gun > 0:
                        current_date = cls._subtract_business_days(current_date, gun, holidays)
                    cls._set_cell(ws, row_idx, _h("Montaj Baslangic"), current_date)

                    # AN: Test2 Baslangic = WORKDAY.INTL(AO, -ROUNDUP(AF,0), "0000011")
                    gun = math.ceil(toplam_test2_dk / test_kap_dk) if test_kap_dk > 0 and toplam_test2_dk > 0 else 0
                    if gun > 0:
                        current_date = cls._subtract_business_days(current_date, gun, holidays)
                    cls._set_cell(ws, row_idx, _h("Test2 Baslangic"), current_date)

                    # AM: Conformal Baslangic = WORKDAY.INTL(AN, -ROUNDUP(AE,0), "0000011")
                    gun = math.ceil(toplam_conformal_dk / montaj_kap_dk) if montaj_kap_dk > 0 and toplam_conformal_dk > 0 else 0
                    if gun > 0:
                        current_date = cls._subtract_business_days(current_date, gun, holidays)
                    cls._set_cell(ws, row_idx, _h("Conformal Baslangic"), current_date)

                    # AL: Epoxy Baslangic = WORKDAY.INTL(AM, -ROUNDUP(AD,0), "0000011")
                    gun = math.ceil(toplam_epoxy_dk / montaj_kap_dk) if montaj_kap_dk > 0 and toplam_epoxy_dk > 0 else 0
                    if gun > 0:
                        current_date = cls._subtract_business_days(current_date, gun, holidays)
                    cls._set_cell(ws, row_idx, _h("Epoxy Baslangic"), current_date)

                    # AK: Test1 Baslangic = WORKDAY.INTL(AL, -ROUNDUP(AC,0), "0000011")
                    gun = math.ceil(toplam_test1_dk / test_kap_dk) if test_kap_dk > 0 and toplam_test1_dk > 0 else 0
                    if gun > 0:
                        current_date = cls._subtract_business_days(current_date, gun, holidays)
                    cls._set_cell(ws, row_idx, _h("Test1 Baslangic"), current_date)

                    # AJ: Kalite Baslangic = WORKDAY.INTL(AK, -ROUNDUP(AB,0), "0000011")
                    gun = math.ceil(toplam_kalite_dk / kalite_kap_dk) if kalite_kap_dk > 0 and toplam_kalite_dk > 0 else 0
                    if gun > 0:
                        current_date = cls._subtract_business_days(current_date, gun, holidays)
                    cls._set_cell(ws, row_idx, _h("Kalite Baslangic"), current_date)

                    # AI: Dizgi Baslangic / Fason Termin
                    # IF(AV="FASON", WORKDAY.INTL(AJ, -ROUNDUP(G*IF(AT<>"",AT,KAPASITE!B11),0),...), IF(AA=0, AJ, AJ-AA))
                    if is_fason:
                        gun = math.ceil(qty * kap_fason_gun_adet)
                        current_date = cls._subtract_business_days(current_date, gun, holidays)
                    else:
                        if toplam_dizgi_gun > 0:
                            current_date = current_date - timedelta(days=toplam_dizgi_gun)
                    cls._set_cell(ws, row_idx, _h("Dizgi Baslangic / Fason Termin"), current_date)

                else:
                    # pi var ama delivery_date geçersiz
                    invalid_date_by_code[raw_product_code] = invalid_date_by_code.get(raw_product_code, 0) + 1

                cls._set_cell(ws, row_idx, _h("Ana Proje"), raw_product_code)
                matched_count += 1

            else:
                # pi yok
                pc_key = raw_product_code or "(boş)"
                unmatched_by_code[pc_key] = unmatched_by_code.get(pc_key, 0) + 1
                unmatched_count += 1

            row_idx += 1

        # Add grouped warnings (per product code, not per row)
        for pc, count in sorted(invalid_date_by_code.items(), key=lambda x: -x[1]):
            warnings.append(f"{count} satır ({pc}): Teslim Tarihi geçersiz veya boş, AI-AP tarih hesaplamaları yapılamadı.")
        for pc, count in sorted(unmatched_by_code.items(), key=lambda x: -x[1]):
            warnings.append(f"{count} satır ({pc}): Ürün kodu URUN_SURE'de bulunamadı, K-BB hesaplamaları yapılamadı.")
        if unmatched_count > 0:
            warnings.insert(0, f"{unmatched_count} satır URUN_SURE'de karşılığı bulunamadığı için K-BB hesaplamaları yapılamadı.")

        # Save to bytes
        output = io.BytesIO()
        wb.save(output)
        output.seek(0)
        return output.read(), warnings, matched_count, unmatched_count

    @staticmethod
    def _set_cell(ws, row: int, col: int | None, value):
        """Set a cell value if col is not None."""
        if col is None:
            return
        if isinstance(value, datetime):
            if value.tzinfo is not None:
                value = value.replace(tzinfo=None)
            ws.cell(row=row, column=col, value=value)
        elif isinstance(value, date) and not isinstance(value, datetime):
            ws.cell(row=row, column=col, value=value)
        elif value is not None:
            ws.cell(row=row, column=col, value=value)


# Singleton instance
excel_service = ExcelService()
