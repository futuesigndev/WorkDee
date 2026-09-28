from fastapi import APIRouter, Depends, HTTPException, Response, Cookie, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.core_api import core_api_client
from app.models import LocalUser, LocalRole, LocalMenu, RoleMenuPermission, AppSettings, AuditLog
from pydantic import BaseModel
from app.dependencies import get_current_user_id
from app.config import settings
from app.redis_client import get_redis, refresh_token_key
from fastapi.responses import JSONResponse
from redis.exceptions import RedisError

router = APIRouter(prefix="/auth", tags=["auth"])

class LoginRequest(BaseModel):
    employee_id: str
    password: str

@router.post("/login")
async def login(
    login_data: LoginRequest,
    response: Response,
    req: Request,
    db: AsyncSession = Depends(get_db),
    redis = Depends(get_redis)
):
    try:
        # 1. Login to Core-API
        core_data = await core_api_client.login(login_data.employee_id, login_data.password)
        
        # 2. Check/Create Local User
        stmt = select(LocalUser).where(LocalUser.employee_id == login_data.employee_id)
        result = await db.execute(stmt)
        user = result.scalar_one_or_none()
        
        if not user:
            # Check if this is the very first user in the system (bootstrap mode)
            user_count_stmt = select(LocalUser)
            user_count_result = await db.execute(user_count_stmt)
            existing_users = user_count_result.scalars().all()

            if existing_users:
                # System already has users → only provisioned employees may login
                raise HTTPException(
                    status_code=403,
                    detail="Access denied. Your account has not been provisioned. Please contact an administrator."
                )

            # No users exist yet → bootstrap: first login becomes Admin
            role_stmt = select(LocalRole).where(LocalRole.name == "Admin")
            role_result = await db.execute(role_stmt)
            default_role = role_result.scalar_one_or_none()

            if not default_role:
                default_role = LocalRole(name="Admin", is_system_role=True)
                db.add(default_role)
                await db.flush()  # Get ID

            # Create the first Admin user
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

        # 6. Store the refresh token in Redis so logout can revoke this session server-side
        #    (key format employee_id:refresh_token, per docs/SYSTEM_SPEC §3.1).
        #    If Redis is unreachable, login still succeeds — Core-API already authenticated
        #    the user; refresh will then fail closed until Redis is reachable again.
        try:
            await redis.set(
                refresh_token_key(user.employee_id),
                core_data["refresh_token"],
                ex=settings.REFRESH_TOKEN_EXPIRE_SECONDS,
            )
        except RedisError as e:
            print(f"Redis error at login (refresh token not stored): {e}")

        return {"message": "Login successful", "user": core_data["user"]}
        
    except HTTPException:
        raise
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

@router.post("/refresh")
async def refresh(
    response: Response,
    redis = Depends(get_redis),
    refresh_token: str | None = Cookie(None),
    access_token: str | None = Cookie(None),
):
    """Exchange the refresh_token cookie for new tokens.

    Core-API rotates the refresh token on every use, so the rotated pair must replace
    both the cookies and the Redis value. The access token is expected to be expired
    here, so it is only *read* (the `sub` claim), never verified — the same
    claim-read pattern logout uses. Redis is the revocation gate: a missing key or a
    value that doesn't match the cookie means the session is dead, so fail closed.
    """
    from jose import jwt

    def _expired() -> JSONResponse:
        # Headers set on the injected Response are dropped when an HTTPException is
        # raised, so build the 401 explicitly to guarantee the cookies are cleared.
        resp = JSONResponse(status_code=401, content={"detail": "Session expired"})
        resp.delete_cookie("access_token")
        resp.delete_cookie("refresh_token")
        return resp

    # 1. The refresh_token cookie is required.
    if not refresh_token:
        return _expired()

    # 2. Read employee_id from the access token claim (it is normally expired by now;
    #    python-jose checks exp by default, so verify_exp must be disabled too).
    employee_id = None
    if access_token:
        try:
            payload = jwt.decode(
                access_token,
                settings.SECRET_KEY,
                algorithms=[settings.ALGORITHM],
                options={"verify_signature": False, "verify_exp": False}
            )
            employee_id = payload.get("sub")
        except Exception:
            employee_id = None
    if not employee_id:
        return _expired()

    key = refresh_token_key(employee_id)

    # 3. Redis gates revocation. Unreachable Redis => fail closed (state unverifiable).
    try:
        stored = await redis.get(key)
    except RedisError as e:
        print(f"Redis error at refresh (failing closed): {e}")
        return _expired()

    if stored is None:
        # Revoked (logout) or never stored — force a real login.
        return _expired()

    if stored != refresh_token:
        # Cookie doesn't match the stored token: stale or stolen. Drop the session whole.
        try:
            await redis.delete(key)
        except RedisError as e:
            print(f"Redis error while invalidating mismatched token: {e}")
        return _expired()

    # 4. Exchange with Core-API. Any failure => clean 401 (never leak exception text).
    try:
        core_data = await core_api_client.refresh_token(refresh_token)
    except Exception as e:
        print(f"Core-API refresh failed: {e}")
        try:
            await redis.delete(key)
        except RedisError:
            pass
        return _expired()

    new_access = core_data.get("access_token")
    new_refresh = core_data.get("refresh_token")
    if not new_access or not new_refresh:
        try:
            await redis.delete(key)
        except RedisError:
            pass
        return _expired()

    # 5. Store the rotated refresh token (TTL reset). If it can't be stored, the old
    #    token is already invalid at Core-API, so this session cannot refresh again.
    try:
        await redis.set(key, new_refresh, ex=settings.REFRESH_TOKEN_EXPIRE_SECONDS)
    except RedisError as e:
        print(f"Redis error while storing rotated token (failing closed): {e}")
        return _expired()

    # 6. Issue the new cookies with the same flags as /login.
    response.set_cookie(
        key="access_token",
        value=new_access,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite=settings.COOKIE_SAMESITE,
        max_age=settings.ACCESS_TOKEN_EXPIRE_SECONDS
    )
    response.set_cookie(
        key="refresh_token",
        value=new_refresh,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite=settings.COOKIE_SAMESITE,
        max_age=settings.REFRESH_TOKEN_EXPIRE_SECONDS
    )

    return {"message": "Token refreshed"}

@router.post("/logout")
async def logout(
    response: Response,
    req: Request,
    db: AsyncSession = Depends(get_db),
    redis = Depends(get_redis),
    access_token: str | None = Cookie(None)
):
    employee_id = None
    try:
        if access_token:
            from jose import jwt
            # Read the sub claim (not a trust decision) even when the token is expired:
            # python-jose validates exp by default, so verify_exp must also be disabled.
            payload = jwt.decode(
                access_token,
                settings.SECRET_KEY,
                algorithms=[settings.ALGORITHM],
                options={"verify_signature": False, "verify_exp": False}
            )
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

    # Revoke the server-side session before clearing cookies. If Redis is unreachable,
    # log it but still clear the cookies — logout must not be blocked by Redis.
    if employee_id:
        try:
            await redis.delete(refresh_token_key(employee_id))
        except RedisError as e:
            print(f"Logout Redis revoke error: {e}")

    response.delete_cookie("access_token")
    response.delete_cookie("refresh_token")
    return {"message": "Logged out"}
