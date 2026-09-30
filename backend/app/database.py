import logging

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from app.config import settings

# SQLAlchemy logs every statement through these loggers at INFO level whenever their level allows it.
# `echo=False` only means "do not switch logging on", so on its own it does not keep SQL out of the
# log if the deployment configures logging at INFO (uvicorn does not, but a naive basicConfig does).
# With `SQL_ECHO` off we therefore pin them to WARNING.
SQL_LOGGERS = ("sqlalchemy.engine", "sqlalchemy.engine.Engine")


def build_engine() -> AsyncEngine:
    """The one place an engine is created, so `SQL_ECHO` applies consistently (task 019 item E).

    Echo used to be hard-coded `True`, which printed every statement — and with it every literal —
    to the log in every environment. `SQL_ECHO=true` in `.env` turns it back on.
    """
    echo = settings.sql_echo_enabled
    engine = create_async_engine(settings.DATABASE_URL, echo=echo)
    if not echo:
        for name in SQL_LOGGERS:
            logging.getLogger(name).setLevel(logging.WARNING)
    return engine


engine = build_engine()
AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

class Base(DeclarativeBase):
    pass

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session
        await session.commit()
