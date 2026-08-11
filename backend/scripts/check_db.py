import asyncio
from app.database import engine

async def main():
    try:
        async with engine.begin() as conn:
            await conn.execute('SELECT 1')
        print('DB connection OK')
    except Exception as e:
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    asyncio.run(main())
