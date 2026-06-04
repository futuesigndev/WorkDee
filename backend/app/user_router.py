from fastapi import APIRouter, Depends, HTTPException, Cookie
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List, Optional
from app.database import get_db
from app.models import LocalUser, LocalRole, AuditLog
from app.core_api import core_api_client
from app.dependencies import get_current_user_id
from pydantic import BaseModel
from datetime import datetime, timezone
import uuid

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

# ─── List Users ───────────────────────────────────────────────────────────────

@router.get("", response_model=List[UserResponse])
async def list_users(
    skip: int = 0,
    limit: int = 100,
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
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
):
    # 1. Check if already provisioned
    existing_stmt = select(LocalUser).where(LocalUser.employee_id == request.employee_id)
    existing_user = (await db.execute(existing_stmt)).scalar_one_or_none()
    if existing_user:
        raise HTTPException(status_code=400, detail="User already provisioned")

    # 2. Get employee info from Core-API (ใช้ access_token จาก cookie)
    if not access_token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        emp_data = await core_api_client.get_employee(access_token, request.employee_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Employee not found in Core-API")

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
        details=f"Provisioned {request.employee_id} with role {request.role_name}",
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
    actor_id: str = Depends(get_current_user_id),
):
    stmt = select(LocalUser).where(LocalUser.employee_id == employee_id)
    user = (await db.execute(stmt)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.is_active = body.is_active
    user.deprovisioned_at = None if body.is_active else datetime.utcnow()

    # Audit Log
    action = "USER_ACTIVATED" if body.is_active else "USER_DEPROVISIONED"
    db.add(AuditLog(
        action=action,
        actor_id=actor_id,
        details=f"{'Activated' if body.is_active else 'Deprovisioned'} user {employee_id}",
        metadata_json={"employee_id": employee_id, "is_active": body.is_active},
    ))

    await db.commit()
    return {"status": "success", "employee_id": employee_id, "is_active": body.is_active}

# ─── Update User Role (ตรงกับ FE: PATCH /users/{employee_id}/role) ─────────────

@router.patch("/{employee_id}/role")
async def update_user_role(
    employee_id: str,
    body: RoleUpdateRequest,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
):
    stmt = select(LocalUser).where(LocalUser.employee_id == employee_id)
    user = (await db.execute(stmt)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # ตรวจว่า role มีอยู่จริง
    role_stmt = select(LocalRole).where(LocalRole.id == body.role_id)
    role = (await db.execute(role_stmt)).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")

    old_role_id = user.role_id
    user.role_id = body.role_id

    # Audit Log
    db.add(AuditLog(
        action="USER_ROLE_CHANGED",
        actor_id=actor_id,
        details=f"Changed role of {employee_id} to {role.name}",
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
):
    if not access_token:
        raise HTTPException(status_code=401, detail="Not authenticated")
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
    actor_id: str = Depends(get_current_user_id),
):
    stmt = select(LocalUser).where(LocalUser.employee_id == employee_id)
    user = (await db.execute(stmt)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    await db.delete(user)

    # Audit Log
    db.add(AuditLog(
        action="USER_DELETED",
        actor_id=actor_id,
        details=f"Deleted user {employee_id} ({user.full_name}) from app database",
        metadata_json={"employee_id": employee_id, "full_name": user.full_name},
    ))

    await db.commit()
    return {"status": "success", "employee_id": employee_id}

