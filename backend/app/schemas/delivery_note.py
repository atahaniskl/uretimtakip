"""
Pydantic schemas for delivery notes.
"""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class DeliveryNoteCreate(BaseModel):
    content: str = Field(..., min_length=1, max_length=4000)


class DeliveryNoteRead(BaseModel):
    id: UUID
    order_id: UUID
    content: str
    created_by: UUID
    created_by_username: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}
