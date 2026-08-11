from sqlalchemy import Column, String
from app.database import Base
from sqlalchemy.dialects.postgresql import UUID
import uuid

class PurchasingRecord(Base):
    __tablename__ = "purchasing_records"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    purchase_no = Column(String, index=True)
    purchasing_agent = Column(String)
    approval = Column(String)
    record_type = Column(String) # Because 'type' is a reserved word
    product = Column(String)
    version = Column(String)
    quantity = Column(String)
    project = Column(String)
    customer = Column(String)
    proposal_no = Column(String)
    list_price = Column(String)
    unit_price_euro = Column(String)
    unit_price_usd = Column(String)
    total_price_usd = Column(String)
    company = Column(String)
    supplier = Column(String)
    order_date = Column(String)
    expected_delivery_date = Column(String)
    delivery_date = Column(String)
    source_file = Column(String, nullable=True)
