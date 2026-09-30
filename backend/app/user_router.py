from fastapi import APIRouter, Depends, HTTPException, Cookie
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List, Optional
from app.database import get_db
from app.models import LocalUser, LocalRole, AuditLog
from app.core_api import core_api_client
from app.dependencies import get_current_user_id, require_permission
from app.redis_client import get_redis
from app import session_store
from redis.exceptions import RedisError
from pydantic import BaseModel
from datetime import datetime, timezone
import uuid

# Task 019 item A: every route here manages local users (provision, role, status, delete, and the
# Core-API employee search used to pick who to provision), so all of them require the `users` menu
# permission on top of a valid session. Before this, a valid session of any role was enough — the
# only thing protecting user administration was that the frontend did not link to it.
router = APIRouter(prefix="/users", tags=["User Management"])

# ─── Response / Request Schemas ──────────────────────────────────────────────

class UserResponse(BaseModel):
    id: uuid.UUID
    employee_id: str
    full_name: str
    department: str
    division: str
    company: str
    role_id: uuid.UUID
    role_name: str
    is_active: bool

    class Config:
        from_attributes = True

class ProvisionRequest(BaseModel):
    employee_id: str
    role_name: str = "User"

class StatusUpdateRequest(BaseModel):
    is_active: bool

class RoleUpdateRequest(BaseModel):
    role_id: uuid.UUID

# ─── Lockout guards (task 023 edge cases) ────────────────────────────────────
#
# These routes never had a rule about who is allowed to switch off whom, so the only Admin could
# deactivate or delete themselves and lock everybody out of user management. The rules below are the
# minimum that keeps the system recoverable; they are deliberately about *removing* access, so
# re-activating, re-provisioning and granting a role are never blocked.
ADMIN_ROLE_NAME = "Admin"
SELF_DELETE_DETAIL = "ลบบัญชีของตัวเองไม่ได้ กรุณาให้ผู้ดูแลระบบคนอื่นดำเนินการ"
SELF_DEACTIVATE_DETAIL = "ปิดการใช้งานบัญชีของตัวเองไม่ได้ กรุณาให้ผู้ดูแลระบบคนอื่นดำเนินการ"
LAST_ADMIN_DETAIL = "ต้องเหลือผู้ดูแลระบบที่ใช้งานอยู่อย่างน้อย 1 คน"


async def _role_name_of(db: AsyncSession, role_id: uuid.UUID) -> str | None:
    return (await db.execute(select(LocalRole.name).where(LocalRole.id == role_id))).scalar_one_or_none()


async def _other_active_admins(db: AsyncSession, employee_id: str) -> int:
    """How many *other* active, non-deprovisioned users hold the Admin role."""
    stmt = (
        select(LocalUser.id)
        .join(LocalRole, LocalUser.role_id == LocalRole.id)
        .where(LocalRole.name == ADMIN_ROLE_NAME)
        .where(LocalUser.is_active.is_(True))
        .where(LocalUser.deprovisioned_at.is_(None))
        .where(LocalUser.employee_id != employee_id)
    )
    return len((await db.execute(stmt)).all())

# ─── List Users ───────────────────────────────────────────────────────────────

@router.get("", response_model=List[UserResponse])
async def list_users(
    skip: int = 0,
    limit: int = 100,
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user = Depends(require_permission("users")),
):
    query = select(LocalUser, LocalRole.name.label("role_name")).join(
        LocalRole, LocalUser.role_id == LocalRole.id
    )

    if search:
        query = query.where(
            (LocalUser.employee_id.ilike(f"%{search}%")) |
            (LocalUser.full_name.ilike(f"%{search}%"))
        )

    query = query.offset(skip).limit(limit)
    result = await db.execute(query)

    users = []
    for user, role_name in result.all():
        users.append({
            "id": user.id,
            "employee_id": user.employee_id,
            "full_name": user.full_name,
            "department": user.department,
            "division": user.division,
            "company": user.company,
            "role_id": user.role_id,
            "role_name": role_name,
            "is_active": user.is_active,
        })

    return users

# ─── Provision User ───────────────────────────────────────────────────────────

@router.post("/provision", status_code=201)
async def provision_user(
    request: ProvisionRequest,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    access_token: str = Cookie(None),
    _current_user = Depends(require_permission("users")),
):
    # 1. Check if already provisioned
    existing_stmt = select(LocalUser).where(LocalUser.employee_id == request.employee_id)
    existing_user = (await db.execute(existing_stmt)).scalar_one_or_none()
    if existing_user:
        raise HTTPException(status_code=400, detail="พนักงานคนนี้เพิ่มเข้าใช้งานระบบแล้ว")

    # 2. Get employee info from Core-API (ใช้ access_token จาก cookie)
    if not access_token:
        raise HTTPException(status_code=401, detail="ไม่พบเซสชันการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่")
    try:
        emp_data = await core_api_client.get_employee(access_token, request.employee_id)
    except Exception:
        raise HTTPException(status_code=404, detail="ไม่พบข้อมูลพนักงานรหัสนี้จาก Core-API")

    # 3. Get or create Role
    role_stmt = select(LocalRole).where(LocalRole.name == request.role_name)
    role = (await db.execute(role_stmt)).scalar_one_or_none()
    if not role:
        role = LocalRole(name=request.role_name, is_system_role=False)
        db.add(role)
        await db.flush()

    # 4. Create Local User
    new_user = LocalUser(
        employee_id=emp_data["employee_id"],
        full_name=emp_data["full_name"],
        department=emp_data.get("department", "N/A"),
        division=emp_data.get("division", "N/A"),
        company=emp_data.get("company_name") or emp_data.get("company", "N/A"),
        role_id=role.id,
        is_active=True,
    )
    db.add(new_user)

    # 5. Audit Log
    audit = AuditLog(
        action="USER_PROVISIONED",
        actor_id=actor_id,
        details=f"เพิ่มผู้ใช้ {request.employee_id} บทบาท {request.role_name}",
        metadata_json={"role": request.role_name, "employee_id": request.employee_id},
    )
    db.add(audit)

    await db.commit()
    return {"status": "success", "employee_id": new_user.employee_id}

# ─── Update User Status (ตรงกับ FE: PATCH /users/{employee_id}/status) ────────

@router.patch("/{employee_id}/status")
async def update_user_status(
    employee_id: str,
    body: StatusUpdateRequest,
    db: AsyncSession = Depends(get_db),
    redis = Depends(get_redis),
    actor_id: str = Depends(get_current_user_id),
    _current_user = Depends(require_permission("users")),
):
    stmt = select(LocalUser).where(LocalUser.employee_id == employee_id)
    user = (await db.execute(stmt)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="ไม่พบผู้ใช้งานนี้ในระบบ")

    # Removing access from yourself or from the last Admin would lock everybody out of this page.
    if body.is_active is False:
        if employee_id == actor_id:
            raise HTTPException(status_code=400, detail=SELF_DEACTIVATE_DETAIL)
        if await _role_name_of(db, user.role_id) == ADMIN_ROLE_NAME \
                and await _other_active_admins(db, employee_id) == 0:
            raise HTTPException(status_code=400, detail=LAST_ADMIN_DETAIL)

    user.is_active = body.is_active
    user.deprovisioned_at = None if body.is_active else datetime.utcnow()

    # Audit Log
    action = "USER_ACTIVATED" if body.is_active else "USER_DEPROVISIONED"
    db.add(AuditLog(
        action=action,
        actor_id=actor_id,
        details=f"{'เปิดใช้งาน' if body.is_active else 'ปิดการใช้งาน'}ผู้ใช้ {employee_id}",
        metadata_json={"employee_id": employee_id, "is_active": body.is_active},
    ))

    await db.commit()

    # Task 028: deactivating a person must end their session at once instead of waiting for their
    # next refresh — every Redis record of the session goes. Redis trouble never blocks the admin's
    # action; the local-users gate in `session_is_live` still refuses them on the next request.
    if body.is_active is False:
        try:
            await session_store.end_session(redis, employee_id)
        except RedisError as e:
            print(f"Redis error while ending a deactivated user's session: {e}")

    return {"status": "success", "employee_id": employee_id, "is_active": body.is_active}

# ─── Update User Role (ตรงกับ FE: PATCH /users/{employee_id}/role) ─────────────

@router.patch("/{employee_id}/role")
async def update_user_role(
    employee_id: str,
    body: RoleUpdateRequest,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user = Depends(require_permission("users")),
):
    stmt = select(LocalUser).where(LocalUser.employee_id == employee_id)
    user = (await db.execute(stmt)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # ตรวจว่า role มีอยู่จริง
    role_stmt = select(LocalRole).where(LocalRole.id == body.role_id)
    role = (await db.execute(role_stmt)).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="ไม่พบบทบาทที่เลือก")

    # Moving the last Admin to another role removes the last account that can manage users.
    if role.name != ADMIN_ROLE_NAME \
            and await _role_name_of(db, user.role_id) == ADMIN_ROLE_NAME \
            and await _other_active_admins(db, employee_id) == 0:
        raise HTTPException(status_code=400, detail=LAST_ADMIN_DETAIL)

    old_role_id = user.role_id
    user.role_id = body.role_id

    # Audit Log
    db.add(AuditLog(
        action="USER_ROLE_CHANGED",
        actor_id=actor_id,
        details=f"เปลี่ยนบทบาทของ {employee_id} เป็น {role.name}",
        metadata_json={
            "employee_id": employee_id,
            "old_role_id": str(old_role_id),
            "new_role_id": str(body.role_id),
            "new_role_name": role.name,
        },
    ))

    await db.commit()
    return {"status": "success", "employee_id": employee_id, "role_id": str(body.role_id)}

# ─── Search Core-API Employees ───────────────────────────────────────────────

@router.get("/search-employees")
async def search_core_employees(
    q: str,
    access_token: str = Cookie(None),
    _current_user = Depends(require_permission("users")),
):
    """Core-API employee search for the provision dialog (task 019 item A).

    The cookie is still read here because the Core-API call needs the admin's own token; it is no
    longer what authorises the request — the `users` permission above is.
    """
    if not access_token:
        raise HTTPException(status_code=401, detail="ไม่พบเซสชันการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่")
    try:
        data = await core_api_client.search_employees(access_token, q)
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ─── Delete User (App DB only) ────────────────────────────────────────────────

@router.delete("/{employee_id}")
async def delete_user(
    employee_id: str,
    db: AsyncSession = Depends(get_db),
    redis = Depends(get_redis),
    actor_id: str = Depends(get_current_user_id),
    _current_user = Depends(require_permission("users")),
):
    stmt = select(LocalUser).where(LocalUser.employee_id == employee_id)
    user = (await db.execute(stmt)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="ไม่พบผู้ใช้งานนี้ในระบบ")

    # Deleting yourself or the last Admin locks everybody out of user management (task 023).
    if employee_id == actor_id:
        raise HTTPException(status_code=400, detail=SELF_DELETE_DETAIL)
    if await _role_name_of(db, user.role_id) == ADMIN_ROLE_NAME \
            and await _other_active_admins(db, employee_id) == 0:
        raise HTTPException(status_code=400, detail=LAST_ADMIN_DETAIL)

    await db.delete(user)

    # Audit Log
    db.add(AuditLog(
        action="USER_DELETED",
        actor_id=actor_id,
        details=f"ลบผู้ใช้ {employee_id} ({user.full_name}) ออกจากฐานข้อมูลแอป",
        metadata_json={"employee_id": employee_id, "full_name": user.full_name},
    ))

    await db.commit()

    # Task 028: a deleted person's session records are removed now, not at their next refresh (the
    # `session_is_live` gate would refuse them anyway — this just leaves nothing behind).
    try:
        await session_store.end_session(redis, employee_id)
    except RedisError as e:
        print(f"Redis error while ending a deleted user's session: {e}")

    return {"status": "success", "employee_id": employee_id}

