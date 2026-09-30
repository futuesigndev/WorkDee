from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, func
from typing import List, Optional
from app.database import get_db
from app.models import LocalRole, LocalMenu, RoleMenuPermission, LocalUser
from app.dependencies import require_permission
from pydantic import BaseModel
import uuid

router = APIRouter(prefix="/roles", tags=["Role & Permission Management"])

class RoleResponse(BaseModel):
    id: uuid.UUID
    name: str
    description: Optional[str]
    is_system_role: bool

    class Config:
        from_attributes = True

class MenuResponse(BaseModel):
    id: uuid.UUID
    key: str
    label: str
    path: str
    icon: Optional[str]
    parent_id: Optional[uuid.UUID]
    order: int
    is_active: bool

    class Config:
        from_attributes = True

class PermissionUpdate(BaseModel):
    menu_ids: List[uuid.UUID]

@router.get("", response_model=List[RoleResponse])
async def list_roles(
    db: AsyncSession = Depends(get_db),
    _current_user = Depends(require_permission("roles"))
):
    result = await db.execute(select(LocalRole).order_by(LocalRole.name))
    return result.scalars().all()

@router.get("/menus", response_model=List[MenuResponse])
async def list_all_menus(
    db: AsyncSession = Depends(get_db),
    _current_user = Depends(require_permission("roles"))
):
    result = await db.execute(select(LocalMenu).order_by(LocalMenu.order))
    return result.scalars().all()

@router.get("/{role_id}/permissions")
async def get_role_permissions(
    role_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _current_user = Depends(require_permission("roles"))
):
    # Get all menu IDs that this role can access
    stmt = select(RoleMenuPermission.menu_id).where(
        RoleMenuPermission.role_id == role_id,
        RoleMenuPermission.can_access == True
    )
    result = await db.execute(stmt)
    return {"role_id": role_id, "menu_ids": [row for row in result.scalars().all()]}

@router.post("/{role_id}/permissions")
async def update_role_permissions(
    role_id: uuid.UUID, 
    payload: PermissionUpdate, 
    db: AsyncSession = Depends(get_db),
    _current_user = Depends(require_permission("roles"))
):
    # A child menu is shown inside its parent group, so a grant for the child alone would leave the user
    # with a menu they cannot see (task 045/D6). A parent that is a **pure group heading** (no page of its
    # own) is added to the grant, because that cannot widen access to any page. A parent that HAS its own
    # page is never added silently — the save is refused and the message names it (the admin decides).
    requested_set = set(payload.menu_ids)
    to_insert = list(payload.menu_ids)
    if requested_set:
        rows = (await db.execute(
            select(LocalMenu).where(LocalMenu.id.in_(requested_set))
        )).scalars().all()
        known = {m.id: m for m in rows}
        missing_parents: dict[uuid.UUID, LocalMenu] = {}
        for _ in range(10):  # walk up; the seeded tree is two levels deep, the bound is a guard
            additions: list[LocalMenu] = []
            for menu_id in list(requested_set):
                menu = known.get(menu_id)
                if menu is None or not menu.parent_id or menu.parent_id in requested_set:
                    continue
                parent = known.get(menu.parent_id)
                if parent is None:
                    parent = (await db.execute(
                        select(LocalMenu).where(LocalMenu.id == menu.parent_id)
                    )).scalar_one_or_none()
                    if parent is None:
                        continue
                    known[parent.id] = parent
                if not (parent.path or "").strip():
                    additions.append(parent)
                else:
                    missing_parents[parent.id] = parent
            if not additions:
                break
            for parent in additions:
                if parent.id not in requested_set:
                    requested_set.add(parent.id)
                    to_insert.append(parent.id)
        missing_parents = {
            key: value for key, value in missing_parents.items() if key not in requested_set
        }
        if missing_parents:
            labels = ", ".join(sorted({p.label for p in missing_parents.values()}))
            raise HTTPException(
                status_code=400,
                detail=f"ต้องเลือกเมนูหลัก {labels} ด้วย เพราะเมนูย่อยจะแสดงอยู่ในเมนูหลักเสมอ",
            )

    # 1. Clear existing permissions for this role
    await db.execute(delete(RoleMenuPermission).where(RoleMenuPermission.role_id == role_id))
    
    # 2. Add new permissions
    new_perms = [
        RoleMenuPermission(role_id=role_id, menu_id=m_id, can_access=True)
        for m_id in to_insert
    ]
    db.add_all(new_perms)
    await db.commit()
    
    return {"status": "success", "updated_count": len(new_perms)}

# ─── Role CRUD Operations ─────────────────────────────────────────────────────

class RoleCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None

class RoleUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None

@router.post("", response_model=RoleResponse, status_code=201)
async def create_role(
    payload: RoleCreateRequest,
    db: AsyncSession = Depends(get_db),
    _current_user = Depends(require_permission("roles"))
):
    # Check if role name already exists
    stmt = select(LocalRole).where(LocalRole.name == payload.name)
    existing = (await db.execute(stmt)).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="ชื่อบทบาทนี้มีอยู่แล้ว")
    
    new_role = LocalRole(
        name=payload.name,
        description=payload.description,
        is_system_role=False
    )
    db.add(new_role)
    await db.commit()
    await db.refresh(new_role)
    return new_role

@router.patch("/{role_id}", response_model=RoleResponse)
async def update_role(
    role_id: uuid.UUID,
    payload: RoleUpdateRequest,
    db: AsyncSession = Depends(get_db),
    _current_user = Depends(require_permission("roles"))
):
    stmt = select(LocalRole).where(LocalRole.id == role_id)
    role = (await db.execute(stmt)).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="ไม่พบบทบาทนี้")
    
    # Protect system roles from name changes
    if role.is_system_role and payload.name and payload.name != role.name:
        raise HTTPException(status_code=400, detail="เปลี่ยนชื่อบทบาทของระบบไม่ได้")
    
    if payload.name:
        # Check if new name exists elsewhere
        name_stmt = select(LocalRole).where(LocalRole.name == payload.name, LocalRole.id != role_id)
        existing = (await db.execute(name_stmt)).scalar_one_or_none()
        if existing:
            raise HTTPException(status_code=400, detail="ชื่อบทบาทนี้มีอยู่แล้ว")
        role.name = payload.name
        
    if payload.description is not None:
        role.description = payload.description
        
    await db.commit()
    await db.refresh(role)
    return role

@router.delete("/{role_id}")
async def delete_role(
    role_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _current_user = Depends(require_permission("roles"))
):
    stmt = select(LocalRole).where(LocalRole.id == role_id)
    role = (await db.execute(stmt)).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="ไม่พบบทบาทนี้")
    
    if role.is_system_role:
        raise HTTPException(status_code=400, detail="ลบบทบาทของระบบไม่ได้")

    # Refuse while anyone still holds this role. `local_users.role_id` is a plain FK, so this used to
    # surface as a 500 (IntegrityError) and the page told the admin the server was unreachable
    # (task 045/D5). Counting first makes the reason sayable. A deactivated user still holds the role
    # (they can be re-activated), so they are counted too.
    holder_count = (await db.execute(
        select(func.count()).select_from(LocalUser).where(LocalUser.role_id == role_id)
    )).scalar_one()
    if holder_count:
        raise HTTPException(
            status_code=400,
            detail=(f"มีผู้ใช้ {holder_count} คนใช้บทบาทนี้อยู่ "
                    "กรุณาเปลี่ยนบทบาทของผู้ใช้เหล่านั้นก่อนลบ"),
        )

    # Delete associated permissions first (cascade delete)
    await db.execute(delete(RoleMenuPermission).where(RoleMenuPermission.role_id == role_id))
    
    # Delete the role
    await db.delete(role)
    await db.commit()
    return {"status": "success", "message": f"Role '{role.name}' deleted"}

