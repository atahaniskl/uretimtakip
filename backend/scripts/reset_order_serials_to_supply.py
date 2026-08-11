"""Reset all serial number stages for a specific order to 'supply'."""

import asyncio
from uuid import UUID

from sqlalchemy import update, select, func

from app.database import async_session_factory
from app.models.order_serial_number import OrderSerialNumber

ORDER_ID = UUID("7d1dcfbd-e03b-430c-8d17-bbf8f4fdc6fe")
TARGET_STAGE = "supply"


async def main() -> None:
    async with async_session_factory() as session:
        try:
            count_before_stmt = (
                select(func.count())
                .select_from(OrderSerialNumber)
                .where(OrderSerialNumber.order_id == ORDER_ID)
            )
            total_before = (await session.execute(count_before_stmt)).scalar_one()

            update_stmt = (
                update(OrderSerialNumber)
                .where(OrderSerialNumber.order_id == ORDER_ID)
                .values(current_stage=TARGET_STAGE)
            )
            result = await session.execute(update_stmt)
            await session.commit()

            count_after_stmt = (
                select(func.count())
                .select_from(OrderSerialNumber)
                .where(
                    OrderSerialNumber.order_id == ORDER_ID,
                    OrderSerialNumber.current_stage == TARGET_STAGE,
                )
            )
            total_after_supply = (await session.execute(count_after_stmt)).scalar_one()

            print(f"order_id={ORDER_ID}")
            print(f"updated_rows={result.rowcount or 0}")
            print(f"total_serials={total_before}")
            print(f"serials_in_supply_after={total_after_supply}")
        except Exception:
            await session.rollback()
            raise


if __name__ == "__main__":
    asyncio.run(main())
