from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, func
from typing import List, Optional
from app.database import get_db
from app.models import AuditLog, LocalMenu, RoleMenuPermission, LocalRole
from app.dependencies import get_current_user_id, require_permission
from pydantic import BaseModel
import uuid

router = APIRouter(prefix="/menus", tags=["Menu Management"])

# ─── Audit (task 046) ─────────────────────────────────────────────────────────
# Every menu write leaves one traceable row in the same transaction as the change: a refusal (the 045
# rule about child menus) writes nothing, and so does an edit that changes nothing. A row carries the
# menu's **key** and id plus the NAMES of the fields that changed — never the row itself, and the
# delete carries a count of the grants that went with it, never the role names.
MENU_FIELD_LABELS = {
    "label": "ชื่อเมนู",
    "path": "ลิงก์หน้า",
    "icon": "ไอคอน",
    "order": "ลำดับ",
    "is_active": "สถานะใช้งาน",
}

# The order a PATCH applies its fields in (the toggle is the last one: `is_active`).
MENU_UPDATE_FIELDS = ("label", "path", "icon", "order", "is_active")


def _ip_address(req: Request) -> str:
    """The client IP the way the neighbours record it (a request without one falls back)."""
    return req.client.host if req.client else "127.0.0.1"


def _write_audit(db: AsyncSession, action: str, actor_id: str, details: str,
                 metadata: dict, req: Request) -> None:
    """One audit row per committed write. Key / id / field names / counts only."""
    db.add(AuditLog(
        action=action,
        actor_id=actor_id,
        details=details,
        ip_address=_ip_address(req),
        metadata_json=metadata,
    ))

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
    req: Request,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
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

    _write_audit(
        db, "MENU_CREATED", actor_id,
        f"สร้างเมนู {new_menu.key}",
        {
            "menu_id": str(new_menu.id),
            "key": new_menu.key,
            "parent_id": str(new_menu.parent_id) if new_menu.parent_id else None,
        },
        req,
    )
    await db.commit()
    await db.refresh(new_menu)
    return new_menu


@router.patch("/{menu_id}", response_model=MenuResponse)
async def update_menu(
    menu_id: uuid.UUID,
    payload: MenuUpdateRequest,
    req: Request,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user = Depends(require_permission("menus"))
):
    """Update menu properties. A body that changes nothing is a 200 with no write and no audit row."""
    menu = (await db.execute(
        select(LocalMenu).where(LocalMenu.id == menu_id)
    )).scalar_one_or_none()
    if not menu:
        raise HTTPException(status_code=404, detail="ไม่พบเมนูนี้")

    changed: list[str] = []
    for field in MENU_UPDATE_FIELDS:
        value = getattr(payload, field)
        if value is None:
            continue
        if value != getattr(menu, field):
            setattr(menu, field, value)
            changed.append(field)

    if changed:
        labels = ", ".join(MENU_FIELD_LABELS[field] for field in changed)
        _write_audit(
            db, "MENU_UPDATED", actor_id,
            f"แก้ไขเมนู {menu.key}: {labels}",
            {"menu_id": str(menu_id), "key": menu.key, "fields": changed},
            req,
        )
        await db.commit()
        await db.refresh(menu)
    return menu


@router.delete("/{menu_id}")
async def delete_menu(
    menu_id: uuid.UUID,
    req: Request,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user = Depends(require_permission("menus"))
):
    """Delete a menu and its role grants. A menu that still has children is refused (task 045/D20)."""
    menu = (await db.execute(
        select(LocalMenu).where(LocalMenu.id == menu_id)
    )).scalar_one_or_none()
    if not menu:
        raise HTTPException(status_code=404, detail="ไม่พบเมนูนี้")

    # This used to take every child menu (and their grants) with it, with nothing but the dialog's
    # wording in the way. Losing menus nobody asked to delete is worse than a refusal, so the children
    # are counted first; the page disables the control for exactly this case and shows the same reason.
    child_count = (await db.execute(
        select(func.count()).select_from(LocalMenu).where(LocalMenu.parent_id == menu_id)
    )).scalar_one()
    if child_count:
        raise HTTPException(
            status_code=400,
            detail=f"เมนูนี้มีเมนูย่อย {child_count} รายการ กรุณาลบหรือย้ายเมนูย่อยก่อน",
        )

    # Delete this menu's permissions
    grants_removed = (await db.execute(
        select(func.count()).select_from(RoleMenuPermission)
        .where(RoleMenuPermission.menu_id == menu_id)
    )).scalar_one()
    await db.execute(
        delete(RoleMenuPermission).where(RoleMenuPermission.menu_id == menu_id)
    )
    menu_key = menu.key
    menu_label = menu.label  # the response message keeps saying the label it always said
    await db.delete(menu)
    _write_audit(
        db, "MENU_DELETED", actor_id,
        f"ลบเมนู {menu_key}",
        {"menu_id": str(menu_id), "key": menu_key, "grants_removed": grants_removed},
        req,
    )
    await db.commit()

    return {"status": "success", "message": f"Menu '{menu_label}' deleted"}
