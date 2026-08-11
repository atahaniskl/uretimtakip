"""
Schemas for product info master data.
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class SubProductInput(BaseModel):
    product_id: UUID
    quantity: int = Field(default=1, ge=1)


class SubProductRead(BaseModel):
    product_id: UUID
    product_name: str
    quantity: int

    model_config = {"from_attributes": True}


class ProductInfoBase(BaseModel):
    product_name: str = Field(min_length=1, max_length=255)
    supply_days: int = Field(ge=0)
    assembly_days: float = Field(ge=0)
    delivery_days: int = Field(ge=0)
    quality_minutes: float | None = Field(default=None, ge=0)
    epoxy_minutes: float | None = Field(default=None, ge=0)
    conformal_minutes: float | None = Field(default=None, ge=0)
    montaj_minutes: float | None = Field(default=None, ge=0)
    montaj_kalite_minutes: float | None = Field(default=None, ge=0)
    test1_minutes: float | None = Field(default=None, ge=0)
    test2_minutes: float | None = Field(default=None, ge=0)
    final_test_minutes: float | None = Field(default=None, ge=0)
    duration_mode: Literal["per_unit", "flat"] | None = Field(default=None)
    production_flat_days: float | None = Field(default=None, ge=0)
    test_flat_days: float | None = Field(default=None, ge=0)
    assembly_flat_days: float | None = Field(default=None, ge=0)


class ProductInfoCreate(ProductInfoBase):
    sub_products: list[SubProductInput] = Field(default_factory=list)


class ProductInfoUpdate(BaseModel):
    product_name: str | None = Field(default=None, min_length=1, max_length=255)
    supply_days: int | None = Field(default=None, ge=0)
    assembly_days: float | None = Field(default=None, ge=0)
    delivery_days: int | None = Field(default=None, ge=0)
    quality_minutes: float | None = Field(default=None, ge=0)
    epoxy_minutes: float | None = Field(default=None, ge=0)
    conformal_minutes: float | None = Field(default=None, ge=0)
    montaj_minutes: float | None = Field(default=None, ge=0)
    montaj_kalite_minutes: float | None = Field(default=None, ge=0)
    test1_minutes: float | None = Field(default=None, ge=0)
    test2_minutes: float | None = Field(default=None, ge=0)
    final_test_minutes: float | None = Field(default=None, ge=0)
    duration_mode: Literal["per_unit", "flat"] | None = Field(default=None)
    production_flat_days: float | None = Field(default=None, ge=0)
    test_flat_days: float | None = Field(default=None, ge=0)
    assembly_flat_days: float | None = Field(default=None, ge=0)
    sub_products: list[SubProductInput] | None = Field(default=None)


class ProductInfoRead(ProductInfoBase):
    id: UUID
    uretim_dk: float = 0.0
    kalite_dk: float = 0.0
    test_dk: float = 0.0
    sub_products: list[SubProductRead] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}