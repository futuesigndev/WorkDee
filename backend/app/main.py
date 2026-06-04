from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.auth_router import router as auth_router
from app.user_router import router as user_router
from app.role_router import router as role_router
from app.settings_router import router as settings_router
from app.line_router import router as line_router
from app.log_router import router as log_router
from app.menu_router import router as menu_router
from app.database import AsyncSessionLocal, engine, Base
from app.seeds import seed_data

app = FastAPI(title=settings.APP_NAME)

@app.on_event("startup")
async def startup_event():
    # Create tables if they don't exist
    # Check if audit_logs table is outdated (missing action/details) in a separate block
    drop_needed = False
    try:
        async with engine.begin() as conn:
            from sqlalchemy import text
            await conn.execute(text("SELECT action, details FROM audit_logs LIMIT 1;"))
    except Exception:
        drop_needed = True

    async with engine.begin() as conn:
        if drop_needed:
            from sqlalchemy import text
            print("audit_logs table is outdated or missing columns. Dropping to recreate...")
            await conn.execute(text("DROP TABLE IF EXISTS audit_logs CASCADE;"))

        await conn.run_sync(Base.metadata.create_all)

        # Custom inline migration for line_bindings table to support history and revoke reasoning
        from sqlalchemy import text
        print("Migrating line_bindings table...")
        await conn.execute(text("""
            ALTER TABLE line_bindings ADD COLUMN IF NOT EXISTS revoke_reason VARCHAR;
        """))
        
        # Custom inline migration for AppSettings table to support database LINE configurations
        print("Migrating app_settings table...")
        await conn.execute(text("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS line_channel_access_token VARCHAR;"))
        await conn.execute(text("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS line_channel_secret VARCHAR;"))
        await conn.execute(text("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS line_liff_id VARCHAR;"))
        
        # Dynamically drop existing unique constraints on employee_id and line_user_id
        try:
            constraints_res = await conn.execute(text("""
                SELECT conname
                FROM pg_constraint
                WHERE conrelid = 'line_bindings'::regclass AND contype = 'u';
            """))
            for row in constraints_res.fetchall():
                conname = row[0]
                print(f"Dropping unique constraint: {conname} on line_bindings")
                await conn.execute(text(f"ALTER TABLE line_bindings DROP CONSTRAINT {conname};"))
        except Exception as ex:
            print(f"Error checking/dropping constraints on line_bindings: {ex}")

    async with AsyncSessionLocal() as db:
        await seed_data(db)

# Setup ngrok warning bypass header middleware
@app.middleware("http")
async def add_ngrok_skip_browser_warning_header(request, call_next):
    response = await call_next(request)
    response.headers["ngrok-skip-browser-warning"] = "true"
    return response

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

@app.get("/health")
async def health_check():
    return {"status": "ok", "app": settings.APP_NAME}
