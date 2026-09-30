from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models import AppSettings, AuditLog
from pydantic import BaseModel
from typing import Optional
from app.config import settings as app_settings

from app.dependencies import require_permission

router = APIRouter(prefix="/settings", tags=["settings"])

# ─── Audit (task 046) ─────────────────────────────────────────────────────────
# Every admin write leaves one traceable row, written in the same transaction as the change and
# committed only when something really changed. `details` is Thai and names only the **fields** that
# changed — never a value: the LINE channel token, the channel secret, the logo URL, the app name and
# the branding text are all values, and a secret is compared internally but never quoted back.
# Field names (the machine-readable half) go into `metadata_json`, the Thai half into `details`.
#
# The six UI fields and the four LINE fields cover both PATCH routes; the label map is what makes the
# Logs page readable for HR staff.
SETTINGS_FIELD_LABELS = {
    "app_name": "ชื่อแอป",
    "app_logo_url": "โลโก้",
    "theme": "ธีม",
    "dark_mode": "โหมดสี",
    "branding_text": "ข้อความแบรนด์",
    "sub_text": "ข้อความบรรยาย",
    "line_channel_access_token": "โทเคน LINE",
    "line_channel_secret": "รหัสลับ LINE",
    "line_liff_id": "LIFF ID",
    "line_basic_id": "LINE Basic ID",
}

SETTINGS_FIELDS = (
    "app_name",
    "app_logo_url",
    "theme",
    "dark_mode",
    "branding_text",
    "sub_text",
)

# `PATCH /settings` (the shape the public page reads) writes only those six — it must keep ignoring
# the LINE ids it merely echoes back, or a save from that page would wipe them.
ADMIN_ONLY_FIELDS = (
    "line_channel_access_token",
    "line_channel_secret",
    "line_liff_id",
    "line_basic_id",
)


def _ip_address(req: Request) -> str:
    """The client IP the way the neighbours record it (a request without one falls back)."""
    return req.client.host if req.client else "127.0.0.1"


def _write_audit(db: AsyncSession, actor_id: str, changed: list[str], req: Request) -> None:
    """One `SETTINGS_UPDATED` row. Field NAMES only — no value, no length, no secret.

    The Thai sentence lists the fields in the declaration order above (app name → … → LINE ids), so
    the same set of changes always reads the same way; `metadata_json` keeps the machine-readable
    alphabetical list.
    """
    labels = ", ".join(SETTINGS_FIELD_LABELS[field] for field in SETTINGS_FIELD_LABELS if field in changed)
    db.add(AuditLog(
        action="SETTINGS_UPDATED",
        actor_id=actor_id,
        details=f"แก้ไขการตั้งค่า: {labels}",
        ip_address=_ip_address(req),
        metadata_json={"fields": sorted(changed)},
    ))


def _apply_settings(
    settings: AppSettings, values: dict, fields: tuple[str, ...], is_new: bool
) -> list[str]:
    """Write the values that really differ and return their field names.

    A save that changes nothing is not a write: nothing is assigned, so no UPDATE is sent and
    `updated_at` / `updated_by` stay where they were (measured in task 046 Part A: the naive
    assignment the route used to do already emitted no UPDATE for an identical payload, because
    SQLAlchemy compares the value before flushing — this keeps that behaviour explicit).
    """
    changed = [field for field in fields
               if is_new or getattr(settings, field) != values.get(field)]
    for field in changed:
        setattr(settings, field, values.get(field))
    return changed

class AdminAppSettingsSchema(BaseModel):
    app_name: str
    app_logo_url: Optional[str] = None
    theme: str
    dark_mode: str
    branding_text: Optional[str] = "Empowering Digital Enterprise"
    sub_text: Optional[str] = "Experience the next generation of multi-application management with our secure, unified platform."
    line_channel_access_token: Optional[str] = None
    line_channel_secret: Optional[str] = None
    line_liff_id: Optional[str] = None
    line_basic_id: Optional[str] = None

    class Config:
        from_attributes = True

class AppSettingsSchema(BaseModel):
    app_name: str
    app_logo_url: Optional[str] = None
    theme: str
    dark_mode: str
    branding_text: Optional[str] = "Empowering Digital Enterprise"
    sub_text: Optional[str] = "Experience the next generation of multi-application management with our secure, unified platform."
    line_liff_id: Optional[str] = None
    line_basic_id: Optional[str] = None

    class Config:
        from_attributes = True

@router.get("", response_model=AppSettingsSchema)
async def get_settings(
    db: AsyncSession = Depends(get_db)
):
    stmt = select(AppSettings).limit(1)
    result = await db.execute(stmt)
    settings = result.scalar_one_or_none()
    
    if not settings:
        # Return default if not initialized
        return AppSettingsSchema(
            app_name="WorkDee",
            theme="minimalist-slate",
            dark_mode="system",
            line_liff_id=app_settings.LINE_LIFF_ID
        )
    
    # If DB doesn't have it set, fallback to env variable
    if not settings.line_liff_id:
        settings.line_liff_id = app_settings.LINE_LIFF_ID
        
    return settings

@router.patch("", response_model=AppSettingsSchema)
async def update_settings(
    settings_data: AppSettingsSchema,
    response: Response,
    req: Request,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(require_permission("settings"))
):
    stmt = select(AppSettings).limit(1)
    result = await db.execute(stmt)
    settings = result.scalar_one_or_none()

    is_new = settings is None
    if is_new:
        settings = AppSettings()
        db.add(settings)

    changed = _apply_settings(settings, settings_data.model_dump(), SETTINGS_FIELDS, is_new)
    if changed:
        # Whoever saved is recorded on the row itself (task 046/D2) and in the audit row, in the
        # same transaction as the change.
        settings.updated_by = current_user.employee_id
        _write_audit(db, current_user.employee_id, changed, req)
        await db.commit()
        await db.refresh(settings)

    # Set the theme cookie on response so it updates client-side dynamically
    response.set_cookie(
        key="theme",
        value=settings.theme,
        secure=app_settings.COOKIE_SECURE,
        samesite=app_settings.COOKIE_SAMESITE,
        max_age=31536000  # 1 year
    )

    return settings

@router.get("/admin", response_model=AdminAppSettingsSchema)
async def get_admin_settings(
    db: AsyncSession = Depends(get_db),
    _current_user = Depends(require_permission("settings"))
):
    stmt = select(AppSettings).limit(1)
    result = await db.execute(stmt)
    settings = result.scalar_one_or_none()
    
    if not settings:
        return AdminAppSettingsSchema(
            app_name="WorkDee",
            theme="minimalist-slate",
            dark_mode="system"
        )
    
    return settings

@router.patch("/admin", response_model=AdminAppSettingsSchema)
async def update_admin_settings(
    settings_data: AdminAppSettingsSchema,
    response: Response,
    req: Request,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(require_permission("settings"))
):
    stmt = select(AppSettings).limit(1)
    result = await db.execute(stmt)
    settings = result.scalar_one_or_none()

    is_new = settings is None
    if is_new:
        settings = AppSettings()
        db.add(settings)

    changed = _apply_settings(
        settings, settings_data.model_dump(), SETTINGS_FIELDS + ADMIN_ONLY_FIELDS, is_new
    )
    if changed:
        settings.updated_by = current_user.employee_id
        _write_audit(db, current_user.employee_id, changed, req)
        await db.commit()
        await db.refresh(settings)

    # Set the theme cookie on response so it updates client-side dynamically
    response.set_cookie(
        key="theme",
        value=settings.theme,
        secure=app_settings.COOKIE_SECURE,
        samesite=app_settings.COOKIE_SAMESITE,
        max_age=31536000  # 1 year
    )

    return settings
