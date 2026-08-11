"""
Pydantic schemas for request/suggestion/complaint items.
"""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class FeedbackCheckUpdate(BaseModel):
    is_checked: bool


class FeedbackItemRead(BaseModel):
    id: UUID
    category: str
    description: str
    screenshot_filename: str | None = None
    has_screenshot: bool = False
    created_by: UUID
    created_by_username: str | None = None
    created_at: datetime
    is_checked: bool
    checked_by: UUID | None = None
    checked_by_username: str | None = None
    checked_at: datetime | None = None


class FeedbackItemCreateResponse(BaseModel):
    message: str = "Kayit olusturuldu"
    item: FeedbackItemRead


class FeedbackItemCreateForm(BaseModel):
    category: str = Field(pattern="^(REQUEST|SUGGESTION|COMPLAINT)$")
    description: str = Field(min_length=3, max_length=4000)