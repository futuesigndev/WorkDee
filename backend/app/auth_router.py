from fastapi import APIRouter, Depends, HTTPException, Response, Cookie, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.core_api import core_api_client
from app.models import LocalUser, LocalRole, LocalMenu, RoleMenuPermission, AppSettings, AuditLog
from pydantic import BaseModel
from app.dependencies import get_current_user_id
from app.config import settings

router = APIRouter(prefix="/auth", tags=["auth"])

class LoginRequest(BaseModel):
    employee_id: str
    password: str

@router.post("/login")
async def login(
    login_data: LoginRequest,
    response: Response,
    req: Request,
    db: AsyncSession = Depends(get_db)
):
    try:
        # 1. Login to Core-API
        core_data = await core_api_client.login(login_data.employee_id, login_data.password)
        
        # 2. Check/Create Local User
        stmt = select(LocalUser).where(LocalUser.employee_id == login_data.employee_id)
        result = await db.execute(stmt)
        user = result.scalar_one_or_none()
        
        if not user:
            # Check if we have a default role, if not create 'Admin' for the first user
            role_stmt = select(LocalRole).where(LocalRole.name == "Admin")
            role_result = await db.execute(role_stmt)
            default_role = role_result.scalar_one_or_none()
            
            if not default_role:
                default_role = LocalRole(name="Admin", is_system_role=True)
                db.add(default_role)
                await db.flush() # Get ID
            
            # Create Local User automatically from Core-API data
            user = LocalUser(
                employee_id=core_data["user"]["employee_id"],
                full_name=core_data["user"]["full_name"],
                department=core_data["user"].get("department", "N/A"),
                division=core_data["user"].get("division", "N/A"),
                company=core_data["user"].get("company", "N/A"),
                role_id=default_role.id,
                is_active=True
            )
            db.add(user)
            await db.flush()

        # 3. Set HttpOnly Cookies — ค่าทั้งหมดอ่านจาก settings (.env)
        response.set_cookie(
            key="access_token",
            value=core_data["access_token"],
            httponly=True,
            secure=settings.COOKIE_SECURE,
            samesite=settings.COOKIE_SAMESITE,
            max_age=settings.ACCESS_TOKEN_EXPIRE_SECONDS
        )
        response.set_cookie(
            key="refresh_token",
            value=core_data["refresh_token"],
            httponly=True,
            secure=settings.COOKIE_SECURE,
            samesite=settings.COOKIE_SAMESITE,
            max_age=settings.REFRESH_TOKEN_EXPIRE_SECONDS
        )

        # 4. Get corporate theme setting from database and set theme cookie
        settings_stmt = select(AppSettings).limit(1)
        settings_result = await db.execute(settings_stmt)
        app_settings_db = settings_result.scalar_one_or_none()
        theme_val = app_settings_db.theme if app_settings_db else "minimalist-slate"

        response.set_cookie(
            key="theme",
            value=theme_val,
            secure=settings.COOKIE_SECURE,
            samesite=settings.COOKIE_SAMESITE,
            max_age=31536000  # 1 year
        )
        
        # 5. Write Audit Log
        ip_addr = req.client.host if req.client else "127.0.0.1"
        audit = AuditLog(
            action="AUTH_LOGIN_SUCCESS",
            actor_id=user.employee_id,
            details=f"User {user.full_name} logged in successfully",
            ip_address=ip_addr,
            metadata_json={"full_name": user.full_name, "department": user.department}
        )
        db.add(audit)
        await db.commit()
        
        return {"message": "Login successful", "user": core_data["user"]}
        
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))

@router.get("/me/menus")
async def get_user_menus(
    employee_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db)
):
    # 1. Get user role_id
    stmt = select(LocalUser.role_id).where(LocalUser.employee_id == employee_id)
    result = await db.execute(stmt)
    role_id = result.scalar_one_or_none()
    
    if not role_id:
        return []

    # 2. GET menus with permission
    stmt = (
        select(LocalMenu)
        .join(RoleMenuPermission, LocalMenu.id == RoleMenuPermission.menu_id)
        .where(RoleMenuPermission.role_id == role_id)
        .where(RoleMenuPermission.can_access == True)
        .where(LocalMenu.is_active == True)
        .order_by(LocalMenu.order)
    )
    result = await db.execute(stmt)
    menus = result.scalars().all()
    
    # Organize into hierarchy
    menu_map = {str(m.id): {
        "id": str(m.id),
        "key": m.key,
        "label": m.label,
        "path": m.path,
        "icon": m.icon,
        "order": m.order,
        "parent_id": str(m.parent_id) if m.parent_id else None,
        "children": []
    } for m in menus}
    
    hierarchy = []
    for m_id, m_data in menu_map.items():
        if m_data["parent_id"] and m_data["parent_id"] in menu_map:
            menu_map[m_data["parent_id"]]["children"].append(m_data)
        elif not m_data["parent_id"]:
            hierarchy.append(m_data)
            
    # Sort by order
    hierarchy.sort(key=lambda x: x["order"])
    for root in hierarchy:
        root["children"].sort(key=lambda x: x["order"])
        
    return hierarchy

@router.post("/logout")
async def logout(
    response: Response,
    req: Request,
    db: AsyncSession = Depends(get_db),
    access_token: str | None = Cookie(None)
):
    try:
        if access_token:
            from jose import jwt
            # Decode payload without verification to retrieve sub (employee_id) even if token is expired/invalid
            payload = jwt.decode(access_token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM], options={"verify_signature": False})
            employee_id = payload.get("sub")
            if employee_id:
                ip_addr = req.client.host if req.client else "127.0.0.1"
                audit = AuditLog(
                    action="AUTH_LOGOUT",
                    actor_id=employee_id,
                    details=f"User {employee_id} logged out",
                    ip_address=ip_addr,
                    metadata_json={}
                )
                db.add(audit)
                await db.commit()
    except Exception as e:
        # Prevent any logging failure from blocking the logout cookie clearing
        print(f"Logout audit log error: {e}")

    response.delete_cookie("access_token")
    response.delete_cookie("refresh_token")
    return {"message": "Logged out"}
