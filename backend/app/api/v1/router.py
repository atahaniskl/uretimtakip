"""
API v1 Router — aggregates all v1 endpoint routers.
"""

from fastapi import APIRouter

from app.api.v1.endpoints.auth import router as auth_router
from app.api.v1.endpoints.users import router as users_router
from app.api.v1.endpoints.mapping_templates import router as mapping_templates_router
from app.api.v1.endpoints.excel import router as excel_router
from app.api.v1.endpoints.gantt import router as gantt_router
from app.api.v1.endpoints.events import router as events_router
from app.api.v1.endpoints.audit_logs import router as audit_logs_router
from app.api.v1.endpoints.backups import router as backups_router
from app.api.v1.endpoints.holidays import router as holidays_router
from app.api.v1.endpoints.product_info import router as product_info_router
from app.api.v1.endpoints.saved_filters import router as saved_filters_router
from app.api.v1.endpoints.feedback_items import router as feedback_items_router
from app.api.v1.endpoints.order_details import router as order_details_router
from app.api.v1.endpoints.orders import router as orders_router
from app.api.v1.endpoints.dummy_mes import router as dummy_mes_router
from app.api.v1.endpoints.serial_numbers import router as serial_numbers_router
from app.api.v1.endpoints.purchasing import router as purchasing_router
from app.api.v1.endpoints.app_settings import router as app_settings_router
from app.api.v1.endpoints.statistics import router as statistics_router

api_v1_router = APIRouter(prefix="/api")

api_v1_router.include_router(purchasing_router)

api_v1_router.include_router(auth_router)
api_v1_router.include_router(users_router)
api_v1_router.include_router(mapping_templates_router)
api_v1_router.include_router(excel_router)
api_v1_router.include_router(gantt_router)
api_v1_router.include_router(events_router)
api_v1_router.include_router(audit_logs_router)
api_v1_router.include_router(backups_router)
api_v1_router.include_router(holidays_router)
api_v1_router.include_router(product_info_router)
api_v1_router.include_router(saved_filters_router)
api_v1_router.include_router(feedback_items_router)
api_v1_router.include_router(order_details_router)
api_v1_router.include_router(orders_router)
api_v1_router.include_router(dummy_mes_router)
api_v1_router.include_router(serial_numbers_router)
api_v1_router.include_router(app_settings_router)
api_v1_router.include_router(statistics_router)
