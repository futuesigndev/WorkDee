from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from typing import List, Optional
from app.database import get_db
from app.models import LocalMenu, RoleMenuPermission, LocalRole
from app.dependencies import require_permission
from pydantic import BaseModel
import uuid

router = APIRouter(prefix="/menus", tags=["Menu Management"])

# ─── Schemas ──────────────────────────────────────────────────────────────────

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

class MenuCreateRequest(BaseModel):
    key: str
    label: str
    path: str
    icon: Optional[str] = "Circle"
    parent_id: Optional[uuid.UUID] = None
    order: int = 0

class MenuUpdateRequest(BaseModel):
    label: Optional[str] = None
    path: Optional[str] = None
    icon: Optional[str] = None
    order: Optional[int] = None
    is_active: Optional[bool] = None

# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("", response_model=List[MenuResponse])
async def list_menus(
    db: AsyncSession = Depends(get_db),
    _current_user = Depends(require_permission("menus"))
):
    """Return all menus ordered by order field."""
    result = await db.execute(select(LocalMenu).order_by(LocalMenu.order))
    return result.scalars().all()


@router.post("", response_model=MenuResponse, status_code=201)
async def create_menu(
    payload: MenuCreateRequest,
    db: AsyncSession = Depends(get_db),
    _current_user = Depends(require_permission("menus"))
):
    """Create a new menu and auto-grant access to Admin role."""
    # Check key uniqueness
    existing = (await db.execute(
        select(LocalMenu).where(LocalMenu.key == payload.key)
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail=f"คีย์เมนู '{payload.key}' ถูกใช้งานแล้ว")

    # Validate parent exists if provided
    if payload.parent_id:
        parent = (await db.execute(
            select(LocalMenu).where(LocalMenu.id == payload.parent_id)
        )).scalar_one_or_none()
        if not parent:
            raise HTTPException(status_code=404, detail="ไม่พบเมนูแม่ที่เลือก")

    new_menu = LocalMenu(
        key=payload.key,
        label=payload.label,
        path=payload.path,
        icon=payload.icon,
        parent_id=payload.parent_id,
        order=payload.order,
        is_active=True
    )
    db.add(new_menu)
    await db.flush()  # Get ID before commit

    # Auto-grant to Admin role
    admin_role = (await db.execute(
        select(LocalRole).where(LocalRole.name == "Admin")
    )).scalar_one_or_none()

    if admin_role:
        db.add(RoleMenuPermission(
            role_id=admin_role.id,
            menu_id=new_menu.id,
            can_access=True
        ))

    await db.commit()
    await db.refresh(new_menu)
    return new_menu


@router.patch("/{menu_id}", response_model=MenuResponse)
async def update_menu(
    menu_id: uuid.UUID,
    payload: MenuUpdateRequest,
    db: AsyncSession = Depends(get_db),
    _current_user = Depends(require_permission("menus"))
):
    """Update menu properties."""
    menu = (await db.execute(
        select(LocalMenu).where(LocalMenu.id == menu_id)
    )).scalar_one_or_none()
    if not menu:
        raise HTTPException(status_code=404, detail="ไม่พบเมนูนี้")

    if payload.label is not None:
        menu.label = payload.label
    if payload.path is not None:
        menu.path = payload.path
    if payload.icon is not None:
        menu.icon = payload.icon
    if payload.order is not None:
        menu.order = payload.order
    if payload.is_active is not None:
        menu.is_active = payload.is_active

    await db.commit()
    await db.refresh(menu)
    return menu


@router.delete("/{menu_id}")
async def delete_menu(
    menu_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _current_user = Depends(require_permission("menus"))
):
    """Delete a menu and its associated role permissions."""
    menu = (await db.execute(
        select(LocalMenu).where(LocalMenu.id == menu_id)
    )).scalar_one_or_none()
    if not menu:
        raise HTTPException(status_code=404, detail="ไม่พบเมนูนี้")

    # Delete child menus' permissions first
    child_menus = (await db.execute(
        select(LocalMenu).where(LocalMenu.parent_id == menu_id)
    )).scalars().all()

    for child in child_menus:
        await db.execute(
            delete(RoleMenuPermission).where(RoleMenuPermission.menu_id == child.id)
        )
        await db.delete(child)

    # Delete this menu's permissions
    await db.execute(
        delete(RoleMenuPermission).where(RoleMenuPermission.menu_id == menu_id)
    )
    await db.delete(menu)
    await db.commit()

    return {"status": "success", "message": f"Menu '{menu.label}' deleted"}
