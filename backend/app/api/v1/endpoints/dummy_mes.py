"""
Dummy MES (Manufacturing Execution System) simulator.
"""
from random import choice
from fastapi import APIRouter, Query

from app.models.enums import SerialNumberStage

router = APIRouter(prefix="/dummy-mes", tags=["dummy-mes"])


@router.get("/status")
async def get_dummy_status(product_code: str | None = Query(None), serial_number: str | None = Query(None)):
    """Return a random stage from SerialNumberStage for testing.

    This simulates an external MES that reports current status for a serial number.
    """
    stages = [s.value for s in SerialNumberStage]
    return {"status": choice(stages)}
