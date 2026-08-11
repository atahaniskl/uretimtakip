"""
Order Pydantic schemas.
"""

from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, Field


class OrderBase(BaseModel):
    """Shared order fields used across create/update/read schemas."""
    customer_name: str | None = Field(default=None, max_length=255)
    responsible_personnel: str | None = Field(default=None, max_length=255)
    order_date: date | None = None
    promised_date: date | None = None
    requirement_date: date | None = None
    penalty_date: date | None = None


class OrderCreate(OrderBase):
    """Payload for creating an order."""
    external_id: str = Field(..., min_length=1, max_length=255)
    mapping_template_id: UUID
    base_data: dict | None = None
    status: str = Field(default="PENDING")
    created_by: UUID


class OrderUpdate(OrderBase):
    """Payload for updating order details."""
    external_id: str | None = Field(default=None, min_length=1, max_length=255)
    mapping_template_id: UUID | None = None
    base_data: dict | None = None
    status: str | None = None
    is_deleted: bool | None = None
    deleted_at: datetime | None = None


class OrderSerialNumberCreate(BaseModel):
    """Payload for creating an order serial number."""
    serial_number: str = Field(..., min_length=1, max_length=255)
    current_stage: str = Field(default="supply", max_length=20)


class OrderSerialNumbersBulkUpdate(BaseModel):
    """Payload for replacing an order's serial number collection."""
    serial_numbers: list[str] = Field(default_factory=list)


class OrderSerialNumberRead(BaseModel):
    """Public order serial number representation."""
    id: UUID
    order_id: UUID
    serial_number: str
    current_stage: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class OrderRead(OrderBase):
    """Public order representation."""
    id: UUID
    external_id: str
    mapping_template_id: UUID
    base_data: dict | None
    status: str
    created_by: UUID
    is_deleted: bool
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime
    serial_numbers: list[OrderSerialNumberRead] = Field(default_factory=list)
    completion_percentage: float = Field(default=0.0, description="0-100 weighted completion %")
    stage_counts: dict[str, int] = Field(default_factory=dict, description="Count of serial numbers by stage")

    model_config = {"from_attributes": True}


class CellUpdateRequest(BaseModel):
    """Payload for updating a single cell in the order details spreadsheet."""
    order_id: str
    split_id: str | None = None
    field_key: str
    value: str | int | float | bool | None


class BulkCellUpdateRequest(BaseModel):
    """Payload for bulk cell updates from the order details spreadsheet."""
    updates: list[CellUpdateRequest]


class OrderListResponse(BaseModel):
    """Paginated list of orders."""
    orders: list[OrderRead]
    total: int
    page: int
    page_size: int
