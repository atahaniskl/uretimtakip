"""
Excel & Diff operation Pydantic schemas.
"""

from uuid import UUID

from pydantic import BaseModel, Field


class ExcelUploadResponse(BaseModel):
    """Response after uploading an Excel file to MinIO."""
    file_key: str = Field(..., description="MinIO object key for the uploaded file")
    filename: str
    message: str
    is_uretim_plan: bool = Field(False, description="Whether the file is a uretim_Planlamadolu template")
    product_count: int = Field(0, description="Number of products in URUN_SURE sheet")
    order_count: int = Field(0, description="Number of orders in SIPARIS_PLAN sheet")
    calisma_saati: int = Field(8, description="Daily working hours from KAPASITE sheet")


class DiffSummary(BaseModel):
    """Summary counts for a diff operation."""
    total_add: int
    total_remove: int
    total_update: int
    total_unchanged: int


class FieldChange(BaseModel):
    """Individual field change detail."""
    field: str
    old_value: str | int | float | None = None
    new_value: str | int | float | None = None
    source: str = Field(..., description="'base_data' or 'mapped'")


class DiffAddEntry(BaseModel):
    """A row that exists in Excel but not in DB."""
    external_id: str
    data: dict
    base_data: dict
    row_index: int | None = None
    warnings: list[str] = Field(default_factory=list, description="Validation warnings for this row")
    errors: list[str] = Field(default_factory=list, description="Critical errors — this row will be skipped")


class DiffRemoveEntry(BaseModel):
    """A row that exists in DB but not in Excel."""
    external_id: str
    order_id: str
    status: str
    base_data: dict


class DiffUpdateEntry(BaseModel):
    """A row with changed fields between Excel and DB."""
    external_id: str
    order_id: str
    changes: list[dict]
    data: dict
    base_data: dict
    row_index: int | None = None
    warnings: list[str] = Field(default_factory=list, description="Validation warnings for this row")
    errors: list[str] = Field(default_factory=list, description="Critical errors — this row will be skipped")


class DiffResponse(BaseModel):
    """Full diff result between uploaded Excel and current DB state."""
    add: list[DiffAddEntry]
    remove: list[DiffRemoveEntry]
    update: list[DiffUpdateEntry]
    unchanged: int
    summary: DiffSummary
    import_warnings: list[str] = Field(default_factory=list, description="Global import warnings")
    import_errors: list[str] = Field(default_factory=list, description="Global import errors (rows that will be skipped)")


class DiffApplyRequest(BaseModel):
    """
    Request to apply diff results to the database.
    The client can selectively approve which additions, removals, and updates to apply.
    """
    apply_adds: bool = Field(default=True, description="Apply all ADD entries")
    apply_removes: bool = Field(default=True, description="Apply all REMOVE entries (soft-delete)")
    apply_updates: bool = Field(default=True, description="Apply all UPDATE entries")
    exclude_external_ids: list[str] = Field(
        default_factory=list,
        description="External IDs to exclude from the apply operation",
    )


class DiffApplyResponse(BaseModel):
    """Response after applying diff results."""
    added: int
    removed: int
    updated: int
    skipped: int
    message: str


class ExcelPreviewResponse(BaseModel):
    """Preview response to help users configure template mapping easily."""
    header_mode: str
    header_row_index: int
    candidate_columns: list[str]
    sample_rows: list[dict]


class ImportProductInfoResponse(BaseModel):
    """Response after importing URUN_SURE sheet data."""
    added: int = Field(0, description="Number of new products added")
    updated: int = Field(0, description="Number of existing products updated")
    total: int = Field(0, description="Total rows processed")
    message: str = ""


class ExportSiparisPlanResponse(BaseModel):
    """Response after exporting SIPARIS_PLAN Excel."""
    download_url: str = Field(..., description="URL to download the generated Excel")
    order_count: int = Field(0, description="Number of orders exported")
