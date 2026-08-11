"""
Common/shared Pydantic schemas.
"""

from pydantic import BaseModel


class MessageResponse(BaseModel):
    """Generic message response."""
    message: str


class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    version: str
