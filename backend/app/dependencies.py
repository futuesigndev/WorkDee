from datetime import timezone

from fastapi import Depends, HTTPException, Cookie, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models import LocalUser, RoleMenuPermission, LocalMenu, LocalRole
from app.core_api import core_api_client
from app.config import settings

# Task 023 — when a session is refused because HR revoked the person (deleted, deactivated,
# deprovisioned), every session route answers 401 rather than 403 so the frontend sends them to
# /login. Deliberately the same English style as the other session errors; the body is never
# rendered (apiFetch turns any 401 into "session over, go to /login").
SESSION_REVOKED_DETAIL = "Session revoked"

# A brand-new employee's token is issued by Core-API *before* our own row is written (the bootstrap
# Admin, or a just-provisioned user logging in for the first time) and the two clocks live on
# different hosts. Only a token that is clearly older than the row counts as "issued in a previous
# life of this employee id"; this slack keeps a skewed clock from rejecting a fresh login.
SESSION_CLOCK_SKEW_SECONDS = 60


def _issued_at(access_token: str | None) -> int | None:
    """`iat` (Unix seconds) from the access token, or None when it cannot be read.

    Read **without** verifying the signature — the same claim-read pattern `/auth/refresh` and
    `/auth/logout` already use — and only ever used to make access *stricter*. Core-API stays the one
    and only validator of the token itself; nothing here can grant access.
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
    issued = payload.get("iat")
    if isinstance(issued, bool) or not isinstance(issued, (int, float)):
        return None
    return int(issued)


async def session_is_live(db: AsyncSession, employee_id: str, access_token: str | None = None) -> bool:
    """Whether this employee may still use a session (task 023).

    False when the `local_users` row is gone (deleted), inactive, or deprovisioned — and when the
    token was issued before the current row existed, which is the deleted-and-re-provisioned case.
    One indexed lookup (`local_users.employee_id` is UNIQUE) and **no cache**: HR revoking somebody
    has to bite on the very next request, so a cached answer would defeat the purpose.
    """
    row = (await db.execute(
        select(LocalUser.is_active, LocalUser.deprovisioned_at, LocalUser.created_at)
        .where(LocalUser.employee_id == employee_id)
    )).first()
    if row is None:
        return False

    is_active, deprovisioned_at, created_at = row
    if not is_active or deprovisioned_at is not None:
        return False

    issued_at = _issued_at(access_token)
    if issued_at is not None and created_at is not None:
        created_ts = int(
            (created_at if created_at.tzinfo else created_at.replace(tzinfo=timezone.utc)).timestamp()
        )
        if issued_at < created_ts - SESSION_CLOCK_SKEW_SECONDS:
            return False

    return True


async def get_current_user_id(
    access_token: str = Cookie(None),
    db: AsyncSession = Depends(get_db)
):
    """The employee the session cookie belongs to — or 401.

    Two gates: Core-API has to accept the token (`get_me`), and the person has to still be a live
    local user. The second gate is what makes a delete/deactivate take effect immediately (task 023)
    instead of waiting for the token to age out; it is one small indexed lookup per request.
    """
    if not access_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        # ตรวจ token จริงกับ Core-API (ผู้ตรวจที่ถูกต้องตาม design) — ไม่ถอด JWT เองในเครื่อง
        # fail-closed: token invalid / Core-API ล่ม / timeout → 401 เสมอ ไม่มี fallback ให้ผ่าน
        me = await core_api_client.get_me(access_token)
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    employee_id = me.get("employee_id")
    if not employee_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    if not await session_is_live(db, employee_id, access_token):
        # Deleted, deactivated, deprovisioned, or a token from before the row was (re-)created.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=SESSION_REVOKED_DETAIL)

    return employee_id

def require_permission(menu_key: str):
    async def permission_checker(
        employee_id: str = Depends(get_current_user_id),
        db: AsyncSession = Depends(get_db)
    ):
        # 1. Get user role. The row is re-read here for `role_id`, which is why a role or grant
        #    change is already in effect on the next request (no role is baked into the token).
        stmt = select(LocalUser).where(LocalUser.employee_id == employee_id)
        result = await db.execute(stmt)
        user = result.scalar_one_or_none()

        # Kept as a second line of defence: `get_current_user_id` above has already answered 401 for
        # a deleted or inactive user, so this 403 only fires if the row changes mid-request.
        if not user or not user.is_active:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive user")

        # 2. Check menu permission
        stmt = (
            select(RoleMenuPermission)
            .join(LocalMenu, RoleMenuPermission.menu_id == LocalMenu.id)
            .where(RoleMenuPermission.role_id == user.role_id)
            .where(LocalMenu.key == menu_key)
            .where(RoleMenuPermission.can_access == True)
        )
        result = await db.execute(stmt)
        permission = result.scalar_one_or_none()
        
        if not permission:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
            
        return user
        
    return permission_checker
