"""
User-related Pydantic schemas.
"""

from uuid import UUID

from pydantic import BaseModel, Field


class UserRead(BaseModel):
    """Public user representation (never exposes password)."""
    id: UUID
    username: str
    email: str | None = None
    authentik_subject: str | None = None
    role: str
    is_approved: bool

    model_config = {"from_attributes": True}


class UserCreate(BaseModel):
    """Schema for creating a user (admin operation)."""
    username: str = Field(..., min_length=3, max_length=100)
    email: str | None = Field(None, max_length=255)
    password: str = Field(..., min_length=6, max_length=128)
    role: str = Field(default="VIEWER", pattern="^(ADMIN|PLANNER|VIEWER)$")
    is_approved: bool = True


class UserUpdate(BaseModel):
    """Schema for updating a user."""
    username: str | None = Field(None, min_length=3, max_length=100)
    email: str | None = Field(None, max_length=255)
    password: str | None = Field(None, min_length=6, max_length=128)
    role: str | None = Field(None, pattern="^(ADMIN|PLANNER|VIEWER)$")
    is_approved: bool | None = None
