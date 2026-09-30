"""FastAPI application — app factory, startup schema maintenance and middleware.

Startup work is **additive only** (task 019 item B): nothing here drops or rewrites a table. It used
to drop and recreate `audit_logs` whenever a column it expected was missing, which destroyed every
audit row (54 rows live at the time) to fix a schema detail. Now:

* missing tables are created (`create_all`),
* missing **columns** on `audit_logs` are added with `ADD COLUMN IF NOT EXISTS`,
* a column whose type/nullability differs from the model is left exactly as it is and reported as one
  ERROR line naming the table and column,
* the two partial unique indexes that give the database its own "one active LINE ↔ one active
  employee" guarantee are created with `CREATE UNIQUE INDEX IF NOT EXISTS`,
* legacy single-column UNIQUE constraints (if an older install still has them) are dropped, because
  the history design needs several rows per LINE account and per employee.

Every step is idempotent, so running it twice — or from two workers at once — is safe.
"""
import logging

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncConnection

from app.config import settings
from app import photo_storage
from app.auth_router import router as auth_router
from app.user_router import router as user_router
from app.role_router import router as role_router
from app.settings_router import router as settings_router
from app.log_router import router as log_router
from app.menu_router import router as menu_router
from app.attendance_router import (
    CHECKIN_PATH,
    CHECKIN_REVIEW_STATUS_INDEX,
    CHECKIN_UNIQUE_INDEX,
    CHECKIN_WORK_DATE_INDEX,
    UPLOAD_TOO_LARGE_HARD_MESSAGE_TH,
    UPLOAD_TOO_LARGE_MESSAGE_TH,
    checkin_upload_limits,
    router as attendance_router,
)
from app.work_profile_router import router as work_profile_router
from app.news_router import router as news_router
from app.database import AsyncSessionLocal, engine, Base
from app.line_router import (
    LINE_ACTIVE_EMPLOYEE_INDEX,
    LINE_ACTIVE_LINE_USER_INDEX,
    LINE_BINDING_INDEX_NAMES,
    router as line_router,
)
from app.models import AuditLog
from app.seeds import seed_data

logger = logging.getLogger("app.startup")

# Types information_schema reports vs. what SQLAlchemy compiles a model column to.
_TYPE_ALIASES = {
    "varchar": "character varying",
    "character varying": "character varying",
    "text": "text",
    "jsonb": "jsonb",
    "json": "jsonb",
    "uuid": "uuid",
    "integer": "integer",
    "int4": "integer",
    "boolean": "boolean",
    "bool": "boolean",
    "timestamp": "timestamp without time zone",
    "timestamp without time zone": "timestamp without time zone",
    "timestamptz": "timestamp with time zone",
    "timestamp with time zone": "timestamp with time zone",
    "numeric": "numeric",
    "double precision": "double precision",
}


def _canonical_type(raw: str) -> str:
    normalized = " ".join(raw.replace("_", " ").lower().split())
    return _TYPE_ALIASES.get(normalized, normalized)


def _safe_default(column) -> str | None:
    """A value existing rows may take when a NOT NULL column is added. None = leave it nullable."""
    type_name = _canonical_type(column.type.compile(dialect=postgresql.dialect()))
    if type_name in ("character varying", "text"):
        return "''"
    if type_name == "jsonb":
        return "'{}'::jsonb"
    if type_name == "timestamp without time zone":
        return "now()"
    if type_name == "boolean":
        return "false"
    if type_name == "integer":
        return "0"
    return None


async def _table_exists(conn: AsyncConnection, table: str) -> bool:
    result = await conn.execute(
        text(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = current_schema() AND table_name = :table"
        ),
        {"table": table},
    )
    return result.first() is not None


async def _columns(conn: AsyncConnection, table: str) -> dict[str, tuple[str, str]]:
    """{column: (canonical_type, "YES"|"NO" nullable)} for one table in the current schema."""
    rows = (await conn.execute(
        text(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = :table"
        ),
        {"table": table},
    )).all()
    return {name: (_canonical_type(data_type), is_nullable) for name, data_type, is_nullable in rows}


async def repair_audit_logs(conn: AsyncConnection) -> list[str]:
    """Add any column the model declares and the table lacks. Returns the columns added.

    Never drops, renames or retypes anything. A column that exists but does not match the model is
    reported as one ERROR line and left alone.
    """
    if not await _table_exists(conn, AuditLog.__tablename__):
        return []  # create_all will build it in the correct shape

    present = await _columns(conn, AuditLog.__tablename__)
    added: list[str] = []

    for column in AuditLog.__table__.columns:
        model_type = column.type.compile(dialect=postgresql.dialect())
        model_type_canonical = _canonical_type(model_type)
        model_nullable = "YES" if column.nullable else "NO"

        if column.name not in present:
            # Additive only. A NOT NULL column gets a value for the rows that already exist when a
            # safe default exists (so the repaired table matches the model); otherwise it is nullable.
            ddl = f'ADD COLUMN IF NOT EXISTS "{column.name}" {model_type}'
            default = _safe_default(column)
            if not column.nullable and default:
                ddl += f" NOT NULL DEFAULT {default}"
            await conn.execute(text(f"ALTER TABLE {AuditLog.__tablename__} {ddl};"))
            added.append(column.name)
            logger.warning(
                "audit_logs: added missing column '%s' (%s) — existing rows were kept",
                column.name,
                model_type_canonical,
            )
            continue

        db_type, db_nullable = present[column.name]
        problems = []
        if db_type != model_type_canonical:
            problems.append(f"type {db_type} (model: {model_type_canonical})")
        if db_nullable != model_nullable:
            problems.append(f"nullable={db_nullable} (model: nullable={model_nullable})")
        if problems:
            logger.error(
                "audit_logs.%s does not match the model: %s — left unchanged, no data was touched",
                column.name,
                "; ".join(problems),
            )

    return added


async def ensure_line_binding_indexes(conn: AsyncConnection) -> list[str]:
    """Create the partial unique indexes that enforce 1:1 for *active* bindings.

    `WHERE status IN ('PENDING','APPROVED')` deliberately leaves REJECTED/REVOKED history rows alone,
    so an employee can be registered again after a revoke. Idempotent; a failure (for example an older
    install that already holds duplicates) is logged and does not stop startup.
    """
    if not await _table_exists(conn, "line_bindings"):
        return []

    created: list[str] = []
    for index_name, column in ((LINE_ACTIVE_LINE_USER_INDEX, "line_user_id"),
                               (LINE_ACTIVE_EMPLOYEE_INDEX, "employee_id")):
        try:
            # A SAVEPOINT per index: if an older install already holds duplicates the CREATE fails and
            # would otherwise abort the whole startup transaction (leaving seed_data unable to run and
            # the server unable to boot at all). Rolling back to the savepoint keeps everything else
            # working — measured with a duplicate-holding schema in the 019 suite.
            async with conn.begin_nested():
                await conn.execute(text(
                    f"CREATE UNIQUE INDEX IF NOT EXISTS {index_name} "
                    f"ON line_bindings ({column}) WHERE status IN ('PENDING', 'APPROVED');"
                ))
        except Exception as exc:  # noqa: BLE001 - a legacy install with duplicates must still boot
            logger.error(
                "could not create unique index %s on line_bindings(%s): %s — "
                "the database-level 1:1 guarantee is NOT in place on this install",
                index_name,
                column,
                exc,
            )
            continue
        created.append(index_name)

    existing = set((await conn.execute(text(
        "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'line_bindings'"
    ))).scalars().all())
    logger.info("line_bindings unique indexes present: %s",
                sorted(existing.intersection(LINE_BINDING_INDEX_NAMES)))
    return created


async def drop_legacy_line_binding_unique_constraints(conn: AsyncConnection) -> list[str]:
    """Drop legacy single-column UNIQUE **constraints** on `line_bindings`, if an old install has any.

    Those are `pg_constraint` rows that predate the history design (a LINE account and an employee may
    each appear many times across PENDING/REJECTED/REVOKED rows). Only a plain single-column unique
    constraint on `line_user_id`/`employee_id` is considered, so nothing else can be dropped. The
    partial unique indexes created above are ordinary indexes, not constraints, so this never touches
    them.
    """
    dropped: list[str] = []
    rows = (await conn.execute(text("""
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'line_bindings'::regclass AND contype = 'u'
    """))).all()
    for conname, definition in rows:
        normalized = " ".join(definition.split()).upper()
        if normalized in ("UNIQUE (LINE_USER_ID)", "UNIQUE (EMPLOYEE_ID)"):
            await conn.execute(text(f"ALTER TABLE line_bindings DROP CONSTRAINT {conname};"))
            dropped.append(conname)
            logger.warning("dropped legacy unique constraint %s on line_bindings (%s)", conname, definition)
    return dropped


async def ensure_checkin_index(conn: AsyncConnection) -> list[str]:
    """One check-in per employee, round and day — enforced by the database (task 021).

    A partial index, so the rows that no longer matter (a round removed from a template sets
    `round_id` to NULL) are outside it. Same SAVEPOINT pattern as the line-binding indexes: a legacy
    state that already holds duplicates must not stop startup.
    """
    if not await _table_exists(conn, "attendance_checkins"):
        return []
    try:
        async with conn.begin_nested():
            await conn.execute(text(
                f"CREATE UNIQUE INDEX IF NOT EXISTS {CHECKIN_UNIQUE_INDEX} "
                "ON attendance_checkins (employee_id, work_date, round_id) WHERE round_id IS NOT NULL;"
            ))
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "could not create unique index %s on attendance_checkins: %s — "
            "the database-level \"one check-in per round per day\" guarantee is NOT in place on this install",
            CHECKIN_UNIQUE_INDEX,
            exc,
        )
        return []
    return [CHECKIN_UNIQUE_INDEX]


async def ensure_checkin_review_columns(conn: AsyncConnection) -> list[str]:
    """Add the three HR review columns to `attendance_checkins` on an install that predates them.

    Task 022. Additive only, exactly like `repair_audit_logs`: every added column is nullable and has
    no default, so existing rows keep their data and are simply "not reviewed yet". A fresh database
    gets the columns (and the two lookup indexes) from `create_all` instead, and this function then
    finds them present and does nothing.
    """
    if not await _table_exists(conn, "attendance_checkins"):
        return []  # create_all will build it in the correct shape

    present = await _columns(conn, "attendance_checkins")
    wanted = {
        "reviewed_by": "VARCHAR",
        "reviewed_at": "TIMESTAMPTZ",
        "review_note": "VARCHAR(500)",
    }
    added: list[str] = []
    for name, ddl_type in wanted.items():
        if name in present:
            continue
        await conn.execute(text(
            f'ALTER TABLE attendance_checkins ADD COLUMN IF NOT EXISTS "{name}" {ddl_type};'
        ))
        added.append(name)
        logger.warning(
            "attendance_checkins: added missing column '%s' (%s) — existing rows were kept",
            name,
            ddl_type,
        )
    return added


async def ensure_checkin_lookup_indexes(conn: AsyncConnection) -> list[str]:
    """Index the two columns the HR records page filters on (task 022).

    Same SAVEPOINT-per-index pattern as the unique indexes: an index that cannot be created is one
    ERROR line and startup continues (the page still works, just slower on a large table).
    """
    if not await _table_exists(conn, "attendance_checkins"):
        return []

    created: list[str] = []
    for index_name, column in ((CHECKIN_WORK_DATE_INDEX, "work_date"),
                               (CHECKIN_REVIEW_STATUS_INDEX, "review_status")):
        try:
            async with conn.begin_nested():
                await conn.execute(text(
                    f"CREATE INDEX IF NOT EXISTS {index_name} ON attendance_checkins ({column});"
                ))
        except Exception as exc:  # noqa: BLE001 - a slow query must not stop the server from booting
            logger.error("could not create index %s on attendance_checkins(%s): %s", index_name, column, exc)
            continue
        created.append(index_name)
    return created


async def ensure_schema() -> None:
    """Everything startup must do to the database, in order. Additive and idempotent."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

        # Custom inline migration for line_bindings table to support history and revoke reasoning
        print("Migrating line_bindings table...")
        await conn.execute(text("""
            ALTER TABLE line_bindings ADD COLUMN IF NOT EXISTS revoke_reason VARCHAR;
        """))

        # Custom inline migration for AppSettings table to support database LINE configurations
        print("Migrating app_settings table...")
        await conn.execute(text("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS line_channel_access_token VARCHAR;"))
        await conn.execute(text("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS line_channel_secret VARCHAR;"))
        await conn.execute(text("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS line_liff_id VARCHAR;"))
        await conn.execute(text("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS line_basic_id VARCHAR;"))

        # Repair, never rebuild: audit rows must survive every startup (task 019 item B).
        await repair_audit_logs(conn)

        # Database-level 1:1 for active bindings, then the legacy constraints that predate it (item C).
        await ensure_line_binding_indexes(conn)
        await drop_legacy_line_binding_unique_constraints(conn)

        # One check-in per round per day (task 021).
        await ensure_checkin_index(conn)

        # HR review columns and the two filter indexes of the records page (task 022).
        await ensure_checkin_review_columns(conn)
        await ensure_checkin_lookup_indexes(conn)

    async with AsyncSessionLocal() as db:
        await seed_data(db)


# ── Thai validation messages (task 026) ───────────────────────────────────────────────────────────
# Pydantic answers in English ("Field required", "Input should be a valid integer", …) and those
# sentences reach an HR user through the admin pages. The response **shape** is untouched: `detail`
# stays a list of `{loc, type, msg}` (the pages already render exactly that, and their
# `translateFieldMessage` helpers pass an unrecognised string through unchanged), and `loc`/`type` are
# machine values that stay as they are. Only `msg` becomes a short Thai sentence.
VALIDATION_FALLBACK_TH = "ข้อมูลไม่ถูกต้อง"
VALIDATION_MESSAGES_TH = {
    "missing": "ต้องกรอกข้อมูลช่องนี้",
    "string_too_short": "ข้อความสั้นเกินไป",
    "string_too_long": "ข้อความยาวเกินไป",
    "string_type": "ต้องเป็นข้อความ",
    "string_pattern_mismatch": "รูปแบบข้อความไม่ถูกต้อง",
    "string_unicode": "ข้อความไม่ถูกต้อง",
    "int_type": "ต้องเป็นจำนวนเต็ม",
    "int_parsing": "ต้องเป็นจำนวนเต็ม",
    "float_type": "ต้องเป็นตัวเลข",
    "float_parsing": "ต้องเป็นตัวเลข",
    "decimal_type": "ต้องเป็นตัวเลข",
    "decimal_parsing": "ต้องเป็นตัวเลข",
    "bool_type": "ต้องเป็นค่าจริง/เท็จ",
    "bool_parsing": "ต้องเป็นค่าจริง/เท็จ",
    "uuid_type": "รูปแบบรหัสอ้างอิงไม่ถูกต้อง",
    "uuid_parsing": "รูปแบบรหัสอ้างอิงไม่ถูกต้อง",
    "date_type": "รูปแบบวันที่ไม่ถูกต้อง",
    "date_parsing": "รูปแบบวันที่ไม่ถูกต้อง",
    "date_from_datetime_parsing": "รูปแบบวันที่ไม่ถูกต้อง",
    "datetime_type": "รูปแบบวันเวลาไม่ถูกต้อง",
    "datetime_parsing": "รูปแบบวันเวลาไม่ถูกต้อง",
    "datetime_from_date_parsing": "รูปแบบวันเวลาไม่ถูกต้อง",
    "time_type": "รูปแบบเวลาไม่ถูกต้อง",
    "time_parsing": "รูปแบบเวลาไม่ถูกต้อง",
    "greater_than": "ค่าน้อยเกินไป",
    "greater_than_equal": "ค่าน้อยเกินไป",
    "less_than": "ค่ามากเกินไป",
    "less_than_equal": "ค่ามากเกินไป",
    "enum": "ค่าที่เลือกไม่อยู่ในตัวเลือกที่กำหนด",
    "literal_error": "ค่าที่เลือกไม่อยู่ในตัวเลือกที่กำหนด",
    "json_invalid": "รูปแบบ JSON ไม่ถูกต้อง",
    "list_type": "ต้องเป็นรายการ",
    "dict_type": "ต้องเป็นข้อมูลแบบ object",
    "bytes_type": "ต้องเป็นไฟล์ข้อมูล",
    "iterable_type": "ต้องเป็นรายการ",
    "extra_forbidden": "มีฟิลด์ที่ระบบไม่รองรับส่งมาในคำขอ",
}

# Types whose Pydantic message carries the limit in `ctx` — the number is the useful part of it.
VALIDATION_LIMIT_MESSAGES_TH = {
    "string_too_short": "ความยาวต้องมีอย่างน้อย {limit} ตัวอักษร",
    "string_too_long": "ความยาวต้องไม่เกิน {limit} ตัวอักษร",
    "greater_than": "ค่าต้องมากกว่า {limit}",
    "greater_than_equal": "ค่าต้องไม่น้อยกว่า {limit}",
    "less_than": "ค่าต้องน้อยกว่า {limit}",
    "less_than_equal": "ค่าต้องไม่เกิน {limit}",
}


def thai_validation_message(error: dict) -> str:
    """ข้อความ validation ภาษาไทย (loc/type ของเดิมไม่ถูกแตะต้อง)"""
    error_type = str(error.get("type") or "")
    context = error.get("ctx") if isinstance(error.get("ctx"), dict) else {}
    limit = context.get("max_length", context.get("min_length", context.get(
        "ge", context.get("le", context.get("gt", context.get("lt"))))))
    if limit is not None and error_type in VALIDATION_LIMIT_MESSAGES_TH:
        return VALIDATION_LIMIT_MESSAGES_TH[error_type].format(limit=limit)
    if error_type == "value_error":
        # A `field_validator` of ours raises its own sentence through ValueError (cross-field rules are
        # raised as HTTPException(422) instead). Pydantic prefixes it with "Value error, ": drop the
        # prefix and keep the sentence — never replace our own wording with a generic one.
        raw = str(error.get("msg") or "")
        prefix = "Value error, "
        return raw[len(prefix):] if raw.startswith(prefix) else (raw or VALIDATION_FALLBACK_TH)
    return VALIDATION_MESSAGES_TH.get(error_type, VALIDATION_FALLBACK_TH)


def create_app() -> FastAPI:
    """Build the application.

    A factory rather than a bare module global so the API-docs flag (item D) can be exercised by
    constructing an app with different settings, without editing `.env`.
    """
    # Application logs (startup summary, photo storage, LINE identity, …) are INFO-level, and uvicorn
    # configures only its own loggers — without this, `logger.info(…)` from `app.*` would go nowhere and
    # an operator would never see, for example, that the photo folder is unusable. `force=False` keeps
    # any logging a host already set up; the SQLAlchemy loggers are pinned separately by
    # `database.build_engine()`, so this cannot turn SQL echo back on.
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    docs_enabled = settings.api_docs_enabled
    app = FastAPI(
        title=settings.APP_NAME,
        docs_url="/docs" if docs_enabled else None,
        redoc_url="/redoc" if docs_enabled else None,
        openapi_url="/openapi.json" if docs_enabled else None,
    )

    @app.on_event("startup")
    async def startup_event():
        await ensure_schema()
        # One line about the photo storage folder (task 020). Storage being unavailable must never
        # stop the app from starting — a missing photo is a flagged record later, not a lost check-in.
        photo_storage.log_storage_status()

    @app.middleware("http")
    async def guard_checkin_upload(request: Request, call_next):
        """Reject an oversize check-in upload *before* the body is read (task 021).

        FastAPI parses a multipart body before it solves the endpoint's dependencies, so this cannot be
        a dependency: the declared size has to be checked here, ahead of parsing, or a huge body would
        already have been spooled by the time the endpoint runs.
        """
        if request.method == "POST" and request.url.path == CHECKIN_PATH:
            declared = request.headers.get("content-length")
            if declared and declared.isdigit():
                guard, hard_cap = checkin_upload_limits()
                if int(declared) > guard:
                    detail = (
                        UPLOAD_TOO_LARGE_HARD_MESSAGE_TH
                        if int(declared) > hard_cap
                        else UPLOAD_TOO_LARGE_MESSAGE_TH
                    )
                    return JSONResponse(status_code=413, content={"detail": detail})
        return await call_next(request)

    # Setup CORS — origins อ่านจาก settings (มาจาก .env)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(auth_router, prefix="/api/v1")
    app.include_router(user_router, prefix="/api/v1")
    app.include_router(role_router, prefix="/api/v1")
    app.include_router(settings_router, prefix="/api/v1")
    app.include_router(line_router, prefix="/api/v1")
    app.include_router(log_router, prefix="/api/v1")
    app.include_router(menu_router, prefix="/api/v1")
    app.include_router(attendance_router, prefix="/api/v1")
    app.include_router(work_profile_router, prefix="/api/v1")
    # Company news, HR side only (task 036). The employee-facing /news/me/* routes are task 037.
    app.include_router(news_router, prefix="/api/v1")

    @app.get("/health")
    async def health_check():
        return {"status": "ok", "app": settings.APP_NAME}

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        """422 ที่ข้อความเป็นภาษาไทย — โครงสร้างเดิม (detail: [{loc, type, msg}]) เก็บไว้ครบ"""
        detail = []
        for error in exc.errors():
            item = jsonable_encoder(error)
            item["msg"] = thai_validation_message(error)
            detail.append(item)
        return JSONResponse(status_code=422, content={"detail": detail})

    return app


app = create_app()
