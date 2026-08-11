"""
Dynamic Production Scheduler — FastAPI Application Entry Point.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.config import settings
from app.database import engine, Base
from app.api.v1.router import api_v1_router
from app.services.sse_service import sse_manager
from app.services.backup_service import backup_service
from app.services.mes_scheduler import mes_scheduler

# Import all models so SQLAlchemy registers them
from app.models.user import User  # noqa: F401
from app.models.mapping_template import MappingTemplate  # noqa: F401
from app.models.product_info import ProductInfo  # noqa: F401
from app.models.order import Order  # noqa: F401
from app.models.order_serial_number import OrderSerialNumber  # noqa: F401
from app.models.delivery_split import DeliverySplit  # noqa: F401
from app.models.delivery_note import DeliveryNote  # noqa: F401
from app.models.audit_log import AuditLog  # noqa: F401
from app.models.backup_policy import BackupPolicy  # noqa: F401
from app.models.official_holiday import OfficialHoliday  # noqa: F401
from app.models.saved_filter import SavedFilter  # noqa: F401
from app.models.feedback_item import FeedbackItem  # noqa: F401
from app.models.purchasing import PurchasingRecord  # noqa: F401


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan:
    - On startup: create tables if they don't exist (dev convenience).
    - On shutdown: dispose engine.
    """
    # Create tables (in production, use Alembic migrations instead)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Compatibility fix for older restored backups.
        await conn.execute(text("ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT TRUE"))
        await conn.execute(text("ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS email VARCHAR(255)"))
        await conn.execute(text("ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS authentik_subject VARCHAR(255)"))
        await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email_unique ON users (email) WHERE email IS NOT NULL"))
        await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_authentik_subject_unique ON users (authentik_subject) WHERE authentik_subject IS NOT NULL"))
        await conn.execute(text("UPDATE users SET is_approved = TRUE WHERE is_approved IS NULL"))
        await conn.execute(text("ALTER TABLE IF EXISTS users ALTER COLUMN is_approved SET DEFAULT TRUE"))
        await conn.execute(text("ALTER TABLE IF EXISTS users ALTER COLUMN is_approved SET NOT NULL"))

    # Start SSE Redis Pub/Sub listener
    await sse_manager.connect_redis()

    # Start automatic backup loop (if enabled)
    await backup_service.start_automation()
    # Start MES scheduler
    await mes_scheduler.start()

    yield

    # Cleanup
    await backup_service.stop_automation()
    await sse_manager.disconnect_redis()
    await mes_scheduler.stop()
    await engine.dispose()


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="Excel tabanlı üretim verilerini hiyerarşik Gantt üzerinde yöneten planlama aracı.",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount API routes
app.include_router(api_v1_router)


# Health check
@app.get("/api/health", tags=["Health"])
async def health_check():
    """Application health check endpoint."""
    return {
        "status": "healthy",
        "version": settings.APP_VERSION,
        "app": settings.APP_NAME,
        "sse_clients": sse_manager.client_count,
    }
