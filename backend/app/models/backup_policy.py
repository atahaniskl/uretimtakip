"""
Backup policy model.
Stores admin-configurable automatic backup and retention settings.
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class BackupPolicy(Base):
    __tablename__ = "backup_policies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    automation_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    daily_retention: Mapped[int] = mapped_column(Integer, nullable=False, default=14)
    weekly_retention: Mapped[int] = mapped_column(Integer, nullable=False, default=8)
    monthly_retention: Mapped[int] = mapped_column(Integer, nullable=False, default=12)
    manual_retention: Mapped[int] = mapped_column(Integer, nullable=False, default=40)

    daily_hour_utc: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    weekly_weekday_utc: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    weekly_hour_utc: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    monthly_day_utc: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    monthly_hour_utc: Mapped[int] = mapped_column(Integer, nullable=False, default=4)

    max_hours_without_backup: Mapped[int] = mapped_column(Integer, nullable=False, default=24)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
