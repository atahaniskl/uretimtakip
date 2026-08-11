"""
MappingTemplate Pydantic schemas.
"""

from uuid import UUID

from pydantic import BaseModel, Field


class MappingTemplateCreate(BaseModel):
    """Create a new mapping template."""
    name: str = Field(..., min_length=1, max_length=255)
    column_map: dict = Field(
        ...,
        description='Mapping: {"excel_column_name": "system_field_name"}',
        examples=[{"Sipariş No": "order_number", "Ürün Adı": "product_name", "Miktar": "quantity"}],
    )
    unique_id_strategy: str = Field(
        default="COLUMN",
        pattern="^(COLUMN|HASH)$",
        description="Strategy for generating unique IDs: COLUMN or HASH",
    )
    unique_id_config: dict | None = Field(
        default=None,
        description='Config for ID strategy. COLUMN: {"column": "order_number"}, HASH: {"columns": ["field1", "field2"]}',
        examples=[{"column": "order_number"}],
    )


class MappingTemplateUpdate(BaseModel):
    """Update an existing mapping template."""
    name: str | None = Field(None, min_length=1, max_length=255)
    column_map: dict | None = None
    unique_id_strategy: str | None = Field(None, pattern="^(COLUMN|HASH)$")
    unique_id_config: dict | None = None


class MappingTemplateRead(BaseModel):
    """Public mapping template representation."""
    id: UUID
    name: str
    column_map: dict
    unique_id_strategy: str
    unique_id_config: dict | None
    created_by: UUID

    model_config = {"from_attributes": True}
