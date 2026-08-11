from typing import List, Optional
from fastapi import APIRouter, HTTPException, BackgroundTasks, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel, Field
import uuid

from app.api.deps import get_current_user, require_role
from app.database import get_db
from app.models.purchasing import PurchasingRecord
from app.models.user import User, UserRole
from app.services.purchasing_email import send_purchasing_email

router = APIRouter(prefix="/purchasing", tags=["Purchasing"])

class PurchasingData(BaseModel):
    id: Optional[str] = None
    purchaseNo: str = ""
    purchasingAgent: str = ""
    approval: str = ""
    type: str = ""
    product: str = ""
    version: str = ""
    quantity: str = ""
    project: str = ""
    customer: str = ""
    proposalNo: str = ""
    listPrice: str = ""
    unitPriceEuro: str = ""
    unitPriceUsd: str = ""
    totalPriceUsd: str = ""
    company: str = ""
    supplier: str = ""
    orderDate: str = ""
    expectedDeliveryDate: str = ""
    deliveryDate: str = ""
    # _sourceFile Pydantic v2'de private sayilir, sourceFile olarak aliaslanir
    sourceFile: Optional[str] = Field(default=None, alias="_sourceFile")

    model_config = {"populate_by_name": True, "from_attributes": True}

class SendPurchasingEmailRequest(BaseModel):
    rows: List[PurchasingData]

@router.get("/", response_model=List[PurchasingData])
async def get_all_purchasing_records(
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(PurchasingRecord))
    records = result.scalars().all()
    return [
        PurchasingData(
            id=str(r.id),
            purchaseNo=r.purchase_no or "",
            purchasingAgent=r.purchasing_agent or "",
            approval=r.approval or "",
            type=r.record_type or "",
            product=r.product or "",
            version=r.version or "",
            quantity=r.quantity or "",
            project=r.project or "",
            customer=r.customer or "",
            proposalNo=r.proposal_no or "",
            listPrice=r.list_price or "",
            unitPriceEuro=r.unit_price_euro or "",
            unitPriceUsd=r.unit_price_usd or "",
            totalPriceUsd=r.total_price_usd or "",
            company=r.company or "",
            supplier=r.supplier or "",
            orderDate=r.order_date or "",
            expectedDeliveryDate=r.expected_delivery_date or "",
            deliveryDate=r.delivery_date or "",
            _sourceFile=r.source_file or ""
        ) for r in records
    ]

@router.post("/bulk-create")
async def bulk_create_purchasing_records(
    request: SendPurchasingEmailRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
):
    if not request.rows:
        raise HTTPException(status_code=400, detail="No rows provided")
    
    db_records = []
    for row in request.rows:
        record_id = uuid.UUID(row.id) if row.id and len(row.id) == 36 else uuid.uuid4()
        db_record = PurchasingRecord(
            id=record_id,
            purchase_no=row.purchaseNo,
            purchasing_agent=row.purchasingAgent,
            approval=row.approval,
            record_type=row.type,
            product=row.product,
            version=row.version,
            quantity=row.quantity,
            project=row.project,
            customer=row.customer,
            proposal_no=row.proposalNo,
            list_price=row.listPrice,
            unit_price_euro=row.unitPriceEuro,
            unit_price_usd=row.unitPriceUsd,
            total_price_usd=row.totalPriceUsd,
            company=row.company,
            supplier=row.supplier,
            order_date=row.orderDate,
            expected_delivery_date=row.expectedDeliveryDate,
            delivery_date=row.deliveryDate,
            source_file=row.sourceFile
        )
        db_records.append(db_record)
        db.add(db_record)
        
    await db.commit()
    
    # E-posta gonderimi arka planda yap
    background_tasks.add_task(send_purchasing_email, request.rows)
    
    return {"message": "Records saved and email sent to background tasks."}

@router.put("/{record_id}")
async def update_purchasing_record(
    record_id: uuid.UUID,
    data: PurchasingData,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
):
    result = await db.execute(select(PurchasingRecord).where(PurchasingRecord.id == record_id))
    record = result.scalar_one_or_none()
    
    if not record:
        raise HTTPException(status_code=404, detail="Record not found")
        
    record.purchase_no = data.purchaseNo
    record.purchasing_agent = data.purchasingAgent
    record.approval = data.approval
    record.record_type = data.type
    record.product = data.product
    record.version = data.version
    record.quantity = data.quantity
    record.project = data.project
    record.customer = data.customer
    record.proposal_no = data.proposalNo
    record.list_price = data.listPrice
    record.unit_price_euro = data.unitPriceEuro
    record.unit_price_usd = data.unitPriceUsd
    record.total_price_usd = data.totalPriceUsd
    record.company = data.company
    record.supplier = data.supplier
    record.order_date = data.orderDate
    record.expected_delivery_date = data.expectedDeliveryDate
    record.delivery_date = data.deliveryDate
    
    await db.commit()
    return {"message": "Updated successfully"}

@router.delete("/{record_id}")
async def delete_purchasing_record(
    record_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.PLANNER)),
):
    result = await db.execute(select(PurchasingRecord).where(PurchasingRecord.id == record_id))
    record = result.scalar_one_or_none()
    
    if not record:
        raise HTTPException(status_code=404, detail="Record not found")
        
    await db.delete(record)
    await db.commit()
    return {"message": "Deleted successfully"}
