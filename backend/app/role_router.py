from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from typing import List, Optional
from app.database import get_db
from app.models import LocalRole, LocalMenu, RoleMenuPermission
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
async def list_roles(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(LocalRole).order_by(LocalRole.name))
    return result.scalars().all()

@router.get("/menus", response_model=List[MenuResponse])
async def list_all_menus(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(LocalMenu).order_by(LocalMenu.order))
    return result.scalars().all()

@router.get("/{role_id}/permissions")
async def get_role_permissions(role_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
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
    db: AsyncSession = Depends(get_db)
):
    # 1. Clear existing permissions for this role
    await db.execute(delete(RoleMenuPermission).where(RoleMenuPermission.role_id == role_id))
    
    # 2. Add new permissions
    new_perms = [
        RoleMenuPermission(role_id=role_id, menu_id=m_id, can_access=True)
        for m_id in payload.menu_ids
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
    db: AsyncSession = Depends(get_db)
):
    # Check if role name already exists
    stmt = select(LocalRole).where(LocalRole.name == payload.name)
    existing = (await db.execute(stmt)).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="Role name already exists")
    
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
    db: AsyncSession = Depends(get_db)
):
    stmt = select(LocalRole).where(LocalRole.id == role_id)
    role = (await db.execute(stmt)).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    
    # Protect system roles from name changes
    if role.is_system_role and payload.name and payload.name != role.name:
        raise HTTPException(status_code=400, detail="Cannot rename system role")
    
    if payload.name:
        # Check if new name exists elsewhere
        name_stmt = select(LocalRole).where(LocalRole.name == payload.name, LocalRole.id != role_id)
        existing = (await db.execute(name_stmt)).scalar_one_or_none()
        if existing:
            raise HTTPException(status_code=400, detail="Role name already exists")
        role.name = payload.name
        
    if payload.description is not None:
        role.description = payload.description
        
    await db.commit()
    await db.refresh(role)
    return role

@router.delete("/{role_id}")
async def delete_role(
    role_id: uuid.UUID,
    db: AsyncSession = Depends(get_db)
):
    stmt = select(LocalRole).where(LocalRole.id == role_id)
    role = (await db.execute(stmt)).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    
    if role.is_system_role:
        raise HTTPException(status_code=400, detail="Cannot delete system role")
    
    # Delete associated permissions first (cascade delete)
    await db.execute(delete(RoleMenuPermission).where(RoleMenuPermission.role_id == role_id))
    
    # Delete the role
    await db.delete(role)
    await db.commit()
    return {"status": "success", "message": f"Role '{role.name}' deleted"}

