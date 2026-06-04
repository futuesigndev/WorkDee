from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models import AppSettings
from pydantic import BaseModel
from typing import Optional
from app.config import settings as app_settings

from app.dependencies import get_current_user_id

router = APIRouter(prefix="/settings", tags=["settings"])

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

    class Config:
        from_attributes = True

@router.get("", response_model=AppSettingsSchema)
async def get_settings(db: AsyncSession = Depends(get_db)):
    stmt = select(AppSettings).limit(1)
    result = await db.execute(stmt)
    settings = result.scalar_one_or_none()
    
    if not settings:
        # Return default if not initialized
        return AppSettingsSchema(
            app_name="FutureSign Multi-App",
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
    db: AsyncSession = Depends(get_db)
):
    stmt = select(AppSettings).limit(1)
    result = await db.execute(stmt)
    settings = result.scalar_one_or_none()
    
    if not settings:
        settings = AppSettings()
        db.add(settings)
    
    settings.app_name = settings_data.app_name
    settings.app_logo_url = settings_data.app_logo_url
    settings.theme = settings_data.theme
    settings.dark_mode = settings_data.dark_mode
    settings.branding_text = settings_data.branding_text
    settings.sub_text = settings_data.sub_text
    
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
    admin_id: str = Depends(get_current_user_id)
):
    stmt = select(AppSettings).limit(1)
    result = await db.execute(stmt)
    settings = result.scalar_one_or_none()
    
    if not settings:
        return AdminAppSettingsSchema(
            app_name="FutureSign Multi-App",
            theme="minimalist-slate",
            dark_mode="system"
        )
    
    return settings

@router.patch("/admin", response_model=AdminAppSettingsSchema)
async def update_admin_settings(
    settings_data: AdminAppSettingsSchema,
    response: Response,
    db: AsyncSession = Depends(get_db),
    admin_id: str = Depends(get_current_user_id)
):
    stmt = select(AppSettings).limit(1)
    result = await db.execute(stmt)
    settings = result.scalar_one_or_none()
    
    if not settings:
        settings = AppSettings()
        db.add(settings)
    
    settings.app_name = settings_data.app_name
    settings.app_logo_url = settings_data.app_logo_url
    settings.theme = settings_data.theme
    settings.dark_mode = settings_data.dark_mode
    settings.branding_text = settings_data.branding_text
    settings.sub_text = settings_data.sub_text
    settings.line_channel_access_token = settings_data.line_channel_access_token
    settings.line_channel_secret = settings_data.line_channel_secret
    settings.line_liff_id = settings_data.line_liff_id
    
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
