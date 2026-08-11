"""
DPS Application Settings.
All configuration is loaded from environment variables via pydantic-settings.
"""

from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # --- App ---
    APP_NAME: str = "Dynamic Production Scheduler"
    APP_VERSION: str = "1.15.9"
    DEBUG: bool = True

    # --- PostgreSQL ---
    POSTGRES_USER: str = "dps_user"
    POSTGRES_PASSWORD: str = "dps_secret_password_change_me"
    POSTGRES_DB: str = "dps_database"
    POSTGRES_PORT: int = 5432
    DATABASE_URL: str = Field(
        default="postgresql+asyncpg://dps_user:dps_secret_password_change_me@postgres:5432/dps_database"
    )

    # --- Redis ---
    REDIS_PASSWORD: str = "redis_secret_password_change_me"
    REDIS_PORT: int = 6379
    REDIS_URL: str = Field(
        default="redis://:redis_secret_password_change_me@redis:6379/0"
    )

    # --- Celery ---
    CELERY_BROKER_URL: str = Field(
        default="redis://:redis_secret_password_change_me@redis:6379/1"
    )
    CELERY_RESULT_BACKEND: str = Field(
        default="redis://:redis_secret_password_change_me@redis:6379/2"
    )

    # --- MinIO ---
    MINIO_ENDPOINT: str = "minio:9000"
    MINIO_ACCESS_KEY: str = "minio_admin"
    MINIO_SECRET_KEY: str = "minio_secret_password_change_me"
    MINIO_BUCKET_NAME: str = "dps-uploads"
    MINIO_SECURE: bool = False

    # --- Database Backup ---
    BACKUP_AUTOMATION_ENABLED: bool = True
    BACKUP_INTERVAL_MINUTES: int = 360
    BACKUP_RETENTION_COUNT: int = 40
    BACKUP_RESTORE_TIMEOUT_SECONDS: int = 90

    # --- Production Planning ---
    WORK_HOURS_PER_DAY: int = 7

    # --- MES Status Polling ---
    MES_STATUS_URL: str = "http://127.0.0.1:8000/api/dummy-mes/status"
    MES_POLL_INTERVAL_SECONDS: int = 1800

    # --- Mail ---
    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 587
    SMTP_EMAIL: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_USE_TLS: bool = True
    ORDER_COMPLETION_EMAIL_TO: str = ""
    PURCHASING_EMAIL_TO: str = ""

    # --- JWT ---
    JWT_SECRET_KEY: str = "super_secret_jwt_key_change_me_in_production"
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    JWT_REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    COOKIE_SECURE: bool = False

    # --- Authentik / OIDC ---
    AUTHENTIK_ENABLED: bool = False
    AUTHENTIK_ISSUER_URL: str = ""
    AUTHENTIK_INTERNAL_URL: str = ""
    AUTHENTIK_CLIENT_ID: str = ""
    AUTHENTIK_CLIENT_SECRET: str = ""
    AUTHENTIK_REDIRECT_URI: str = ""
    AUTHENTIK_FRONTEND_CALLBACK_URL: str = "/auth/authentik/callback"
    AUTHENTIK_SCOPE: str = "openid profile email"
    AUTHENTIK_AUTO_APPROVE: bool = True
    AUTHENTIK_DEFAULT_ROLE: str = "VIEWER"
    AUTHENTIK_GROUPS_CLAIM: str = "groups"
    AUTHENTIK_ADMIN_GROUP: str = "dps-admins"
    AUTHENTIK_PLANNER_GROUP: str = "dps-planners"

    model_config = {
        "env_file": ".env",
        "case_sensitive": True,
        "extra": "ignore",
    }


settings = Settings()
