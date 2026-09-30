from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, func
from typing import List, Optional
from app.database import get_db
from app.models import AuditLog, LocalRole, LocalMenu, RoleMenuPermission, LocalUser
from app.dependencies import get_current_user_id, require_permission
from pydantic import BaseModel
import uuid

router = APIRouter(prefix="/roles", tags=["Role & Permission Management"])

# ─── Audit (task 046) ─────────────────────────────────────────────────────────
# Every role write leaves one traceable row, written in the same transaction as the change: a
# refusal (role still held, built-in role, the 045 parent rule) writes nothing, and so does a save
# that changes nothing. The rows carry ids, field NAMES, a count and menu **keys** — never a label
# list, never a description's text. The Thai sentence names the entity; the machine-readable half
# (ids, keys) lives in `metadata_json`, the same split 023/036 use.
ROLE_FIELD_LABELS = {"name": "ชื่อบทบาท", "description": "คำอธิบาย"}


def _ip_address(req: Request) -> str:
    """The client IP the way the neighbours record it (a request without one falls back)."""
    return req.client.host if req.client else "127.0.0.1"


def _write_audit(db: AsyncSession, action: str, actor_id: str, details: str,
                 metadata: dict, req: Request) -> None:
    """One audit row per committed write. Ids / field names / keys / counts only."""
    db.add(AuditLog(
        action=action,
        actor_id=actor_id,
        details=details,
        ip_address=_ip_address(req),
        metadata_json=metadata,
    ))

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
    req: Request,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
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
    # The role row is read for the audit trail's Thai sentence only: an unknown role id keeps its old
    # behaviour (the insert still fails on the FK) — this adds no refusal of its own.
    role = (await db.execute(select(LocalRole).where(LocalRole.id == role_id))).scalar_one_or_none()
    role_name = role.name if role is not None else str(role_id)

    # The comparison is on menu **ids**, exactly what the request carries: resolving keys would make
    # an unknown id look like an empty set and turn today's 500 into a silent no-op.
    old_ids = set((await db.execute(
        select(RoleMenuPermission.menu_id).where(RoleMenuPermission.role_id == role_id)
    )).scalars().all())
    requested_ids = set(to_insert)

    if old_ids == requested_ids:
        # Saving the set the role already has is not a write: no delete, no insert, no audit row
        # (the same rule the empty PATCH of task 016 already follows).
        return {"status": "success", "updated_count": len(to_insert)}

    fresh_keys = set((await db.execute(
        select(LocalMenu.key).where(LocalMenu.id.in_(requested_ids))
    )).scalars().all()) if requested_ids else set()
    old_keys = set((await db.execute(
        select(LocalMenu.key).where(LocalMenu.id.in_(old_ids))
    )).scalars().all()) if old_ids else set()

    await db.execute(delete(RoleMenuPermission).where(RoleMenuPermission.role_id == role_id))
    
    # 2. Add new permissions
    new_perms = [
        RoleMenuPermission(role_id=role_id, menu_id=m_id, can_access=True)
        for m_id in to_insert
    ]
    db.add_all(new_perms)
    added = sorted(fresh_keys - old_keys)
    removed = sorted(old_keys - fresh_keys)
    _write_audit(
        db,
        "ROLE_PERMISSIONS_CHANGED",
        actor_id,
        (f"แก้ไขสิทธิ์เมนูของบทบาท {role_name}: รวม {len(fresh_keys)} เมนู"
         f" (เพิ่ม {len(added)} / ลบ {len(removed)})"),
        {
            "role_id": str(role_id),
            "role_name": role_name,
            "menu_count": len(fresh_keys),
            "added_keys": added,
            "removed_keys": removed,
        },
        req,
    )
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
    req: Request,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
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
    await db.flush()  # the id is needed by the audit row
    _write_audit(
        db, "ROLE_CREATED", actor_id,
        f"สร้างบทบาท {new_role.name}",
        {"role_id": str(new_role.id), "name": new_role.name},
        req,
    )
    await db.commit()
    await db.refresh(new_role)
    return new_role

@router.patch("/{role_id}", response_model=RoleResponse)
async def update_role(
    role_id: uuid.UUID,
    payload: RoleUpdateRequest,
    req: Request,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user = Depends(require_permission("roles"))
):
    stmt = select(LocalRole).where(LocalRole.id == role_id)
    role = (await db.execute(stmt)).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="ไม่พบบทบาทนี้")
    
    # Protect system roles from name changes
    if role.is_system_role and payload.name and payload.name != role.name:
        raise HTTPException(status_code=400, detail="เปลี่ยนชื่อบทบาทของระบบไม่ได้")

    changed: list[str] = []
    if payload.name and payload.name != role.name:
        # Check if new name exists elsewhere
        name_stmt = select(LocalRole).where(LocalRole.name == payload.name, LocalRole.id != role_id)
        existing = (await db.execute(name_stmt)).scalar_one_or_none()
        if existing:
            raise HTTPException(status_code=400, detail="ชื่อบทบาทนี้มีอยู่แล้ว")
        role.name = payload.name
        changed.append("name")
        
    if payload.description is not None and payload.description != role.description:
        role.description = payload.description
        changed.append("description")

    if changed:
        # A PATCH that changes nothing writes no row and no UPDATE (the route has no UI yet — task
        # 047 — but it is reachable from the API, so it leaves the same kind of trace as the rest).
        labels = ", ".join(ROLE_FIELD_LABELS[field] for field in changed)
        _write_audit(
            db, "ROLE_UPDATED", actor_id,
            f"แก้ไขบทบาท {role.name}: {labels}",
            {"role_id": str(role_id), "role_name": role.name, "fields": changed},
            req,
        )
        await db.commit()
        await db.refresh(role)
    return role

@router.delete("/{role_id}")
async def delete_role(
    role_id: uuid.UUID,
    req: Request,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
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
    role_name = role.name
    await db.delete(role)
    _write_audit(
        db, "ROLE_DELETED", actor_id,
        f"ลบบทบาท {role_name}",
        {"role_id": str(role_id), "role_name": role_name},
        req,
    )
    await db.commit()
    return {"status": "success", "message": f"Role '{role_name}' deleted"}

