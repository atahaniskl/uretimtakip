"""
Shared enums used across multiple models.
"""

import enum


class UniqueIdStrategy(str, enum.Enum):
    """Strategy for generating unique IDs from Excel data."""
    COLUMN = "COLUMN"
    HASH = "HASH"


class OrderStatus(str, enum.Enum):
    """Order status lifecycle."""
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    COMPLETED = "COMPLETED"


class AuditAction(str, enum.Enum):
    """Actions tracked in the audit log."""
    CREATE = "CREATE"
    UPDATE = "UPDATE"
    DELETE = "DELETE"
    DRAG = "DRAG"
    SPLIT = "SPLIT"
    BACKUP = "BACKUP"
    RESTORE = "RESTORE"


class SerialNumberStage(str, enum.Enum):
    """Stages of a serial number through the production process."""
    SUPPLY = "supply"
    ASSEMBLY = "assembly"
    EPOXY = "epoxy"
    CONFORMAL = "conformal"
    MONTAJ = "montaj"
    KALITE = "kalite"
    MONTAJ_KALITE = "montaj_kalite"
    TEST1 = "test1"
    TEST2 = "test2"
    FINAL_TEST = "final_test"
    DELIVERY = "delivery"
    COMPLETED = "completed"
