"""
Pydantic schemas for shared saved filters.
"""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class TaskTextFilterRule(BaseModel):
    field: str = Field(
        default="all",
        # "company" artik kullanicidan gizli (Firma/Musteri karisikligini gidermek
        # icin sadece "customer" secilebiliyor) - eski kayitli filtreler kirilmasin
        # diye pattern'de hala kabul ediliyor, sadece frontend'de secenek olarak sunulmuyor.
        pattern="^(all|order|product|company|customer|quantity|created_by|last_interacted_by|outsourced|supply_days|production_days)$",
    )
    query: str = Field(default="", max_length=255)


class SavedFilterCriteria(BaseModel):
    task_filter_field: str = Field(
        default="all",
        pattern="^(all|order|product|company|customer|quantity|created_by|last_interacted_by|outsourced|supply_days|production_days)$",
    )
    task_filter_query: str = Field(default="", max_length=255)
    company_filter: str = Field(default="", max_length=255)
    customer_filter: str = Field(default="", max_length=255)
    task_filters: list[TaskTextFilterRule] = Field(default_factory=list)


class SavedFilterCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    criteria: SavedFilterCriteria


class SavedFilterRead(BaseModel):
    id: UUID
    name: str
    criteria: SavedFilterCriteria
    created_by: UUID
    created_by_username: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}
