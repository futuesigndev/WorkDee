from fastapi import APIRouter, Depends, HTTPException, Response, Cookie, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.core_api import core_api_client
from app.models import LocalUser, LocalRole, LocalMenu, RoleMenuPermission, AppSettings, AuditLog
from pydantic import BaseModel
from app.dependencies import get_current_user_id, session_is_live, SESSION_REVOKED_DETAIL
from app.config import settings
from app.redis_client import get_redis, refresh_token_key
from app import session_store
from fastapi.responses import JSONResponse
from redis.exceptions import RedisError
import time

router = APIRouter(prefix="/auth", tags=["auth"])


def _claim_sub(access_token: str | None) -> str | None:
    """The `sub` claim inside the access-token cookie — read, never trusted (task 028).

    python-jose validates `exp` by default and this token is normally expired by the time we look at
    it, so both checks are disabled. The signature is deliberately **not** verified: WorkDee holds no
    Core-API signing key (no shared secret, no JWKS, no introspection endpoint — see 028-report.md §1),
    so this value may never decide anything by itself. Callers use it as a consistency check against
    our own Redis record, or for an audit line — never to look up another session's data.
    """
    if not access_token:
        return None
    try:
        from jose import jwt

        payload = jwt.decode(
            access_token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
            options={"verify_signature": False, "verify_exp": False},
        )
    except Exception:
        return None
    sub = payload.get("sub")
    return sub if isinstance(sub, str) and sub else None

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
                    detail="บัญชีนี้ยังไม่ได้รับสิทธิ์เข้าใช้งานระบบ กรุณาติดต่อผู้ดูแลระบบ"
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
        #    Task 028: the access *cookie* now lives for the whole session cap while the token inside
        #    keeps its own life. Before, max_age equalled the token's life, so an idle browser dropped
        #    the cookie and could never reach /auth/refresh with its 7-day refresh token.
        response.set_cookie(
            key="access_token",
            value=core_data["access_token"],
            httponly=True,
            secure=settings.COOKIE_SECURE,
            samesite=settings.COOKIE_SAMESITE,
            max_age=settings.access_cookie_max_age_seconds
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
            details=f"ผู้ใช้ {user.full_name} เข้าสู่ระบบสำเร็จ",
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
            # Stores the refresh token *and* the two task-028 records: the session meta
            # (`renewals` = 0, `started_at`) and the reverse index `/auth/refresh`
            # looks the session up by.
            await session_store.start_session(redis, user.employee_id, core_data["refresh_token"])
        except RedisError as e:
            print(f"Redis error at login (refresh token not stored): {e}")

        return {"message": "Login successful", "user": core_data["user"]}
        
    except HTTPException:
        raise
    except Exception as e:
        # Log the real cause server-side; never return raw exception text to the client.
        print(f"Login failed: {e}")
        raise HTTPException(status_code=401, detail="Login failed")

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

    def node(menu: LocalMenu, granted: bool) -> dict:
        return {
            "id": str(menu.id),
            "key": menu.key,
            "label": menu.label,
            "path": menu.path,
            "icon": menu.icon,
            "order": menu.order,
            "parent_id": str(menu.parent_id) if menu.parent_id else None,
            # `granted: false` marks a **container** — a parent returned only so a granted child has a
            # group to sit in. The shell keeps the container's own page closed to this role.
            "granted": granted,
            "children": [],
        }

    menu_map = {str(m.id): node(m, True) for m in menus}

    # A granted child whose parent is not granted used to be dropped entirely (`elif not m.parent_id`),
    # which left the user with an empty sidebar and an "access denied" shell (task 045/D6). The parent
    # now comes back as a container instead. Inactive parents are still fetched: hiding the group would
    # hide the granted child with it.
    missing_parent_ids = {
        m.parent_id for m in menus if m.parent_id and str(m.parent_id) not in menu_map
    }
    for _ in range(10):  # the seeded tree is two levels deep; the bound is a guard, not a feature
        if not missing_parent_ids:
            break
        parents = (await db.execute(
            select(LocalMenu).where(LocalMenu.id.in_(missing_parent_ids))
        )).scalars().all()
        missing_parent_ids = set()
        for parent in parents:
            if str(parent.id) in menu_map:
                continue
            menu_map[str(parent.id)] = node(parent, False)
            if parent.parent_id and str(parent.parent_id) not in menu_map:
                missing_parent_ids.add(parent.parent_id)

    hierarchy = []

    for m_data in menu_map.values():
        parent_id = m_data["parent_id"]
        if parent_id and parent_id in menu_map and parent_id != m_data["id"]:
            menu_map[parent_id]["children"].append(m_data)
        else:
            # Top level — or a parent row that does not exist at all: show the menu rather than drop it.
            hierarchy.append(m_data)

    # Sort by order
    hierarchy.sort(key=lambda x: x["order"])
    for root in hierarchy:
        root["children"].sort(key=lambda x: x["order"])
        
    return hierarchy

@router.get("/me")
async def get_my_identity(
    employee_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Who the session belongs to — the admin shell's identity card (task 023).

    Deliberately tiny and read-only: the name, the role name and the ids the shell needs to draw the
    avatar. It carries no permission of its own — the session guard in `get_current_user_id` is what
    authorises it — so an account with **zero** menu grants can still see its own name.
    """
    row = (await db.execute(
        select(LocalUser.employee_id, LocalUser.full_name, LocalRole.name, LocalUser.role_id)
        .join(LocalRole, LocalUser.role_id == LocalRole.id)
        .where(LocalUser.employee_id == employee_id)
    )).first()
    if row is None:
        # Unreachable through `get_current_user_id`; kept so a direct call can never 500.
        raise HTTPException(status_code=401, detail=SESSION_REVOKED_DETAIL)
    return {
        "employee_id": row[0],
        "full_name": row[1],
        "role_name": row[2],
        "role_id": str(row[3]),
    }


@router.post("/refresh")
async def refresh(
    response: Response,
    redis = Depends(get_redis),
    db: AsyncSession = Depends(get_db),
    refresh_token: str | None = Cookie(None),
    access_token: str | None = Cookie(None),
):
    """Exchange the refresh_token cookie for new tokens (task 023 gates + task 028 hardening).

    Core-API rotates the refresh token on every use, so the rotated pair must replace both the cookies
    and the Redis value. Two things changed in task 028:

    * **Who the caller is comes from our own record**, found by the refresh token itself
      (`refresh_owner:<fingerprint>` → employee id). The access cookie's `sub` is only a consistency
      check: it is not verifiable in WorkDee, and a claim that disagrees with the token's owner is
      refused *without touching anybody's records* — the old mismatch branch deleted that key, which
      let a forged cookie sign another employee out (`.scratch/probe028_subtrust_before.txt`).
    * **The session has a hard cap**: at most `SESSION_MAX_RENEWALS` renewals and at most
      `SESSION_MAX_AGE_MINUTES` minutes since login. Hitting either one really ends the session.
    """

    def _expired() -> JSONResponse:
        # Headers set on the injected Response are dropped when an HTTPException is
        # raised, so build the 401 explicitly to guarantee the cookies are cleared.
        resp = JSONResponse(status_code=401, content={"detail": "Session expired"})
        resp.delete_cookie("access_token")
        resp.delete_cookie("refresh_token")
        return resp

    async def _end_session(employee_id: str, reason: str) -> None:
        """Remove every server-side record of this session before refusing (best effort)."""
        try:
            await session_store.end_session(redis, employee_id)
        except RedisError as e:
            print(f"Redis error while ending a session ({reason}): {e}")

    def _already_renewed() -> JSONResponse:
        """Two tabs, one token: the other tab rotated it a moment ago — not an error.

        No cookies are set and nothing is deleted; the caller retries its request with the cookies the
        first tab already installed. A stranger replaying an old token gets this answer too and gains
        nothing from it — there is no token in it.
        """
        return JSONResponse(status_code=200, content={"message": "Token already renewed"})

    # 1. Both cookies are required: the refresh cookie identifies the session, the access cookie
    #    states who the caller believes they are (checked in step 3, never trusted).
    if not refresh_token or not access_token:
        return _expired()
    claimed_employee = _claim_sub(access_token)
    if not claimed_employee:
        return _expired()

    # 2. Redis tells us who owns this refresh token. Unreachable Redis => fail closed.
    try:
        employee_id = await session_store.owner_of_token(redis, refresh_token)
        rotated_away = employee_id is None and bool(
            await session_store.was_just_rotated(redis, refresh_token)
        )
    except RedisError as e:
        print(f"Redis error at refresh (failing closed): {e}")
        return _expired()

    if employee_id is None:
        return _already_renewed() if rotated_away else _expired()

    key = refresh_token_key(employee_id)

    # 3. The claim in the access cookie must agree with the token's owner. A disagreement means a
    #    forged or edited cookie: refuse, and leave the claimed employee's records untouched.
    if claimed_employee != employee_id:
        return _expired()

    # 4. The live local row gates the session (task 023): a deleted, deactivated or deprovisioned
    #    employee cannot mint a new access token, and every record of the session is dropped so it
    #    cannot come back to life.
    if not await session_is_live(db, employee_id, access_token):
        await _end_session(employee_id, "revoked user")
        return _expired()

    # 5. Redis gates revocation. Unreachable Redis => fail closed (state unverifiable).
    try:
        stored = await redis.get(key)
    except RedisError as e:
        print(f"Redis error at refresh (failing closed): {e}")
        return _expired()

    if stored is None:
        # Revoked (logout) or never stored — force a real login.
        return _expired()

    if stored != refresh_token:
        # A stale token belonging to this same employee (an old tab, or a session replaced by a new
        # sign-in). Refuse the *caller*, but never delete the live session's records: a stale cookie
        # must not be able to sign the person out (task 028).
        return _expired()

    # 6. The session cap (task 028, Amendment 1). No record => fail closed: a session recorded before
    #    this task cannot be renewed, so the person signs in once and gets a full 60 minutes.
    try:
        state = await session_store.session_state(redis, employee_id)
    except RedisError as e:
        print(f"Redis error at refresh (failing closed): {e}")
        return _expired()
    if state is None:
        return _expired()
    if int(time.time()) - int(state.get("started_at") or 0) > settings.session_max_age_seconds:
        await _end_session(employee_id, "age cap")
        return _expired()
    if int(state.get("renewals") or 0) >= settings.session_max_renewals:
        await _end_session(employee_id, "renewal cap")
        return _expired()

    # 7. Exchange with Core-API. Any failure => clean 401 (never leak exception text) — unless the
    #    token was rotated under us in the meantime (two tabs refreshing at once), which is not a
    #    failure at all.
    try:
        core_data = await core_api_client.refresh_token(refresh_token)
    except Exception as e:
        print(f"Core-API refresh failed: {e}")
        try:
            if await redis.get(key) not in (None, refresh_token):
                return _already_renewed()
        except RedisError:
            pass
        await _end_session(employee_id, "core-api failure")
        return _expired()

    new_access = core_data.get("access_token")
    new_refresh = core_data.get("refresh_token")
    if not new_access or not new_refresh:
        await _end_session(employee_id, "incomplete core-api answer")
        return _expired()

    # 8. Store the rotated pair, consume one renewal (atomically) and remember the token we rotated
    #    away from for a few seconds. If it can't be stored, the old token is already invalid at
    #    Core-API, so this session cannot refresh again — end it and ask for a real sign-in.
    try:
        renewals = await session_store.register_renewal(redis, employee_id, refresh_token)
        await session_store.rotate_session(redis, employee_id, refresh_token, new_refresh)
    except RedisError as e:
        print(f"Redis error while storing rotated token (failing closed): {e}")
        await _end_session(employee_id, "post-exchange redis failure")
        return _expired()

    if renewals is None or renewals > settings.session_max_renewals:
        # A simultaneous refresh consumed the last renewal first: the cap is the cap.
        await _end_session(employee_id, "renewal cap (race)")
        return _expired()

    # 9. Issue the new cookies with the same flags as /login. The access cookie lives for the whole
    #    session cap (so the browser still holds it when the token inside expires); the token inside
    #    keeps its own life and every guarded route still rejects an expired token (Core-API checks).
    response.set_cookie(
        key="access_token",
        value=new_access,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite=settings.COOKIE_SAMESITE,
        max_age=settings.access_cookie_max_age_seconds
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
    access_token: str | None = Cookie(None),
    refresh_token: str | None = Cookie(None),
):
    """End the session: drop the server-side records, then clear the cookies.

    **Which session** is decided by the refresh cookie (a `refresh_owner:` lookup) — task 028 changed
    this from "the `sub` claim of the access cookie", which is not verifiable in WorkDee and let a
    forged cookie delete somebody else's session. The access cookie's claim is now only a fallback for
    the audit line, for the case where the refresh cookie is already gone.
    """
    employee_id = None
    try:
        if refresh_token:
            employee_id = await session_store.owner_of_token(redis, refresh_token)
    except RedisError as e:
        print(f"Logout session lookup failed: {e}")

    if employee_id is None:
        # No refresh cookie we recognise: there is nothing we can prove is ours to revoke. The
        # cookies are cleared below anyway, so the browser is logged out either way.
        employee_id = _claim_sub(access_token)

    try:
        if employee_id:
            ip_addr = req.client.host if req.client else "127.0.0.1"
            audit = AuditLog(
                action="AUTH_LOGOUT",
                actor_id=employee_id,
                details=f"ผู้ใช้ {employee_id} ออกจากระบบ",
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
    # Task 028: `end_session` removes the refresh token, the session meta (renewal counter) and the
    # reverse index together, so nothing of this session survives a logout.
    if employee_id:
        try:
            await session_store.end_session(redis, employee_id)
        except RedisError as e:
            print(f"Logout Redis revoke error: {e}")

    response.delete_cookie("access_token")
    response.delete_cookie("refresh_token")
    return {"message": "Logged out"}
