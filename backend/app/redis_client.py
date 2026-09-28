import redis.asyncio as aioredis

from app.config import settings

# Shared async Redis client, created once at import time — the same shape as the
# module-level engine in app/database.py.
#
# `protocol=2` (RESP2) is deliberate: docker-compose runs Redis 7 (which supports
# RESP3), but redis-py 8.x defaults to RESP3 and sends an initial `HELLO 3`, which
# older servers reject (the local dev Redis on this machine is 5.0.14 and answers
# "unknown command HELLO"). RESP2 works against both. See 004-report.md.
redis_client = aioredis.from_url(
    settings.REDIS_URL,
    decode_responses=True,
    protocol=2,
)


def refresh_token_key(employee_id: str) -> str:
    """Redis key for a user's refresh token.

    Format fixed by docs/SYSTEM_SPEC_MultiApp_Webapp_Template_v1_4.md §3.1:
    `employee_id:refresh_token`.
    """
    return f"{employee_id}:refresh_token"


async def get_redis():
    """FastAPI dependency yielding the shared Redis client.

    Mirrors `get_db` in app/database.py (a plain async generator dependency).
    """
    yield redis_client
