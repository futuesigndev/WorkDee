"""Employee Work Profile — which template/location an employee uses, plus WFH mode (task 016).

Scope: **assignment only**. Nothing in this module performs or evaluates a check-in; the later
LIFF check-in and the decision engine read these rows.

Conventions
-----------
* Assignable population = rows in ``local_users`` that are active and not deprovisioned. No
  Core-API call is made: Core-API's employee search has ``limit=20`` and no paging (task 013), so
  it cannot back a "who can be assigned" list. The page says this in one line.
* A profile row is optional. An **absent** key leaves a value unchanged, an explicit ``null``
  clears it (``PUT`` and bulk share this rule).
* ``wfh_location_id`` while WFH is off: rejected when sent explicitly, cleared automatically when
  ``wfh_mode`` is switched off without sending a home (see ``_plan_profile``). Turning WFH on
  without an (effective) home location is always a 422.
* Inactive template/location cannot be *newly* assigned, but a value that is already stored stays
  visible and is not an error on unrelated edits — the check is per target and only runs when the
  incoming value differs from what that target already has.
* Timestamps are timestamptz (UTC), like the 014 tables; the UI renders Asia/Bangkok.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Iterable, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user_id, require_permission
from app.models import (
    AttendanceLocation,
    AttendanceTemplate,
    AuditLog,
    EmployeeWorkProfile,
    LocalUser,
)

router = APIRouter(prefix="/attendance", tags=["Employee Work Profile"])

PERMISSION_KEY = "work-profiles"

MAX_BULK_IDS = 500
MAX_BULK_FILTER = 1000
AUDIT_ID_SAMPLE = 100
PAGE_SIZE_DEFAULT = 20
PAGE_SIZE_MAX = 100

CHANGE_FIELDS = ("template_id", "location_id", "wfh_mode", "wfh_location_id")
# These sentences are rendered by the Work Profiles page, so they are Thai; the field NAMES and the
# metadata keys never change (CONTEXT.md standing rule: user-visible text is Thai).
FIELD_LABELS = {
    "template_id": "แม่แบบรอบลงเวลา",
    "location_id": "สถานที่ทำงานหลัก",
    "wfh_mode": "โหมด WFH",
    "wfh_location_id": "จุดบ้าน (WFH)",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ─── Filters ──────────────────────────────────────────────────────────────────

class ProfileFilter(BaseModel):
    """The same filter object is used by the list endpoint and by a bulk "all matching" call."""

    q: str = ""
    department: Optional[str] = None
    division: Optional[str] = None
    company: Optional[str] = None
    template_id: Optional[uuid.UUID] = None
    location_id: Optional[uuid.UUID] = None
    wfh: Optional[bool] = None
    unassigned: Optional[bool] = None


def _clean(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    value = value.strip()
    return value or None


def _escape_like(value: str) -> str:
    """`%` and `_` typed into the search box are matched literally, not as wildcards."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _base_query(f: ProfileFilter):
    """One row per **active** local user, left-joined to their (optional) profile row."""
    stmt = (
        select(LocalUser, EmployeeWorkProfile)
        .outerjoin(EmployeeWorkProfile, EmployeeWorkProfile.employee_id == LocalUser.employee_id)
        .where(LocalUser.is_active.is_(True), LocalUser.deprovisioned_at.is_(None))
    )

    needle = _clean(f.q)
    if needle:
        pattern = f"%{_escape_like(needle)}%"
        stmt = stmt.where(
            or_(
                LocalUser.employee_id.ilike(pattern, escape="\\"),
                LocalUser.full_name.ilike(pattern, escape="\\"),
            )
        )

    for field in ("department", "division", "company"):
        value = _clean(getattr(f, field))
        if value:
            stmt = stmt.where(func.lower(getattr(LocalUser, field)) == value.lower())

    if f.template_id:
        stmt = stmt.where(EmployeeWorkProfile.template_id == f.template_id)
    if f.location_id:
        stmt = stmt.where(EmployeeWorkProfile.location_id == f.location_id)
    if f.wfh is not None:
        # A missing profile row means "not in WFH mode" as much as an explicit false does.
        stmt = stmt.where(
            EmployeeWorkProfile.wfh_mode.is_(True)
            if f.wfh
            else or_(EmployeeWorkProfile.wfh_mode.is_(None), EmployeeWorkProfile.wfh_mode.is_(False))
        )
    if f.unassigned:
        stmt = stmt.where(
            or_(EmployeeWorkProfile.template_id.is_(None), EmployeeWorkProfile.location_id.is_(None))
        )
    return stmt


# ─── Serialisation ────────────────────────────────────────────────────────────

async def _name_maps(
    db: AsyncSession,
    template_ids: Iterable[uuid.UUID],
    location_ids: Iterable[uuid.UUID],
) -> tuple[dict[str, str], dict[str, str]]:
    """id → name for the templates/locations referenced by one page of rows (2 extra queries)."""
    t_ids = {i for i in template_ids if i is not None}
    l_ids = {i for i in location_ids if i is not None}

    templates: dict[str, str] = {}
    if t_ids:
        rows = await db.execute(
            select(AttendanceTemplate.id, AttendanceTemplate.name).where(AttendanceTemplate.id.in_(t_ids))
        )
        templates = {str(r[0]): r[1] for r in rows.all()}

    locations: dict[str, str] = {}
    if l_ids:
        rows = await db.execute(
            select(AttendanceLocation.id, AttendanceLocation.name).where(AttendanceLocation.id.in_(l_ids))
        )
        locations = {str(r[0]): r[1] for r in rows.all()}
    return templates, locations


def _profile_dict(
    user: LocalUser,
    profile: EmployeeWorkProfile | None,
    t_names: dict[str, str],
    l_names: dict[str, str],
) -> dict:
    template_id = profile.template_id if profile else None
    location_id = profile.location_id if profile else None
    wfh_location_id = profile.wfh_location_id if profile else None
    return {
        "employee_id": user.employee_id,
        "full_name": user.full_name,
        "department": user.department,
        "division": user.division,
        "company": user.company,
        "template": {"id": str(template_id), "name": t_names.get(str(template_id))} if template_id else None,
        "location": {"id": str(location_id), "name": l_names.get(str(location_id))} if location_id else None,
        "wfh_mode": bool(profile.wfh_mode) if profile else False,
        "wfh_location": (
            {"id": str(wfh_location_id), "name": l_names.get(str(wfh_location_id))} if wfh_location_id else None
        ),
        "updated_at": profile.updated_at.isoformat() if profile and profile.updated_at else None,
    }


async def _serialise(db: AsyncSession, rows: list[tuple[LocalUser, EmployeeWorkProfile | None]]) -> list[dict]:
    t_names, l_names = await _name_maps(
        db,
        [p.template_id for _, p in rows if p],
        [i for _, p in rows if p for i in (p.location_id, p.wfh_location_id)],
    )
    return [_profile_dict(u, p, t_names, l_names) for u, p in rows]


# ─── Validation / planning ────────────────────────────────────────────────────

class ProfileChanges(BaseModel):
    """Body of PUT and the `changes` object of bulk. Absent key = leave unchanged, null = clear."""

    template_id: Optional[uuid.UUID] = None
    location_id: Optional[uuid.UUID] = None
    wfh_mode: Optional[bool] = None
    wfh_location_id: Optional[uuid.UUID] = None


async def _resolve_refs(db: AsyncSession, changes: dict) -> dict[str, dict[uuid.UUID, bool]]:
    """id → is_active for every template/location id mentioned in `changes` (missing id = unknown)."""
    t_ids = {changes["template_id"]} if changes.get("template_id") else set()
    l_ids = set()
    for key in ("location_id", "wfh_location_id"):
        if changes.get(key):
            l_ids.add(changes[key])

    templates: dict[uuid.UUID, bool] = {}
    if t_ids:
        rows = await db.execute(
            select(AttendanceTemplate.id, AttendanceTemplate.is_active).where(AttendanceTemplate.id.in_(t_ids))
        )
        templates = {r[0]: r[1] for r in rows.all()}

    locations: dict[uuid.UUID, bool] = {}
    if l_ids:
        rows = await db.execute(
            select(AttendanceLocation.id, AttendanceLocation.is_active).where(AttendanceLocation.id.in_(l_ids))
        )
        locations = {r[0]: r[1] for r in rows.all()}

    return {"template": templates, "location": locations}


def _current(profile: EmployeeWorkProfile | None) -> dict:
    return {
        "template_id": profile.template_id if profile else None,
        "location_id": profile.location_id if profile else None,
        "wfh_mode": bool(profile.wfh_mode) if profile else False,
        "wfh_location_id": profile.wfh_location_id if profile else None,
    }


def _plan_profile(
    profile: EmployeeWorkProfile | None,
    changes: dict,
    refs: dict[str, dict[uuid.UUID, bool]],
) -> tuple[dict | None, str | None]:
    """Return the row's next values and the list of fields that really change, or a reason string.

    The rules live here and nowhere else, so PUT and bulk can never drift apart.
    """
    current = _current(profile)
    new = dict(current)

    for field in ("template_id", "location_id", "wfh_location_id"):
        if field not in changes:
            continue
        value = changes[field]
        if value is not None and value != current[field]:
            table = "template" if field == "template_id" else "location"
            if value not in refs[table]:
                return None, f"ไม่พบ{FIELD_LABELS[field]}ที่ระบุ"
            if not refs[table][value]:
                return None, f"{FIELD_LABELS[field]}ถูกปิดใช้งาน จึงกำหนดใหม่ไม่ได้"
        new[field] = value

    if "wfh_mode" in changes:
        new["wfh_mode"] = bool(changes["wfh_mode"])

    if new["wfh_mode"]:
        if new["wfh_location_id"] is None:
            return None, "การเปิดโหมด WFH ต้องระบุจุดบ้าน (WFH)"
    elif "wfh_location_id" not in changes:
        new["wfh_location_id"] = None  # WFH switched off → the stored home point is cleared
    elif new["wfh_location_id"] is not None:
        return None, "ยังระบุจุดบ้าน (WFH) ไม่ได้ขณะปิดโหมด WFH (ให้ส่ง wfh_mode: true หรือล้างค่า)"

    changed = [f for f in CHANGE_FIELDS if new[f] != current[f]]
    return {"values": new, "changed": changed}, None


async def _load_target(db: AsyncSession, employee_id: str) -> tuple[LocalUser, EmployeeWorkProfile | None]:
    """404 when the employee is unknown, 422 when they are inactive/deprovisioned (spec rule 2)."""
    stmt = (
        select(LocalUser, EmployeeWorkProfile)
        .outerjoin(EmployeeWorkProfile, EmployeeWorkProfile.employee_id == LocalUser.employee_id)
        .where(LocalUser.employee_id == employee_id)
    )
    row = (await db.execute(stmt)).one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail=f"ไม่พบรหัสพนักงาน '{employee_id}' ในระบบ")
    user, profile = row
    if not user.is_active or user.deprovisioned_at is not None:
        raise HTTPException(status_code=422, detail=f"พนักงาน '{employee_id}' ถูกปิดใช้งาน จึงกำหนดค่าไม่ได้")
    return user, profile


def _audit(db: AsyncSession, action: str, actor_id: str, details: str, metadata: dict) -> None:
    """One audit row per write. Field names / ids / counts only — never names or other personal data."""
    db.add(AuditLog(action=action, actor_id=actor_id, details=details, metadata_json=metadata))


# ─── Read endpoints ───────────────────────────────────────────────────────────

@router.get("/profiles")
async def list_profiles(
    q: str = "",
    department: Optional[str] = None,
    division: Optional[str] = None,
    company: Optional[str] = None,
    template_id: Optional[uuid.UUID] = None,
    location_id: Optional[uuid.UUID] = None,
    wfh: Optional[bool] = None,
    unassigned: Optional[bool] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(PAGE_SIZE_DEFAULT, ge=1, le=PAGE_SIZE_MAX),
    db: AsyncSession = Depends(get_db),
    _actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission(PERMISSION_KEY)),
):
    """One row per active local user (assigned or not), stable-sorted by `employee_id`."""
    filters = ProfileFilter(
        q=q,
        department=department,
        division=division,
        company=company,
        template_id=template_id,
        location_id=location_id,
        wfh=wfh,
        unassigned=unassigned,
    )
    stmt = _base_query(filters)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar() or 0
    rows = (
        await db.execute(
            stmt.order_by(LocalUser.employee_id.asc()).offset((page - 1) * page_size).limit(page_size)
        )
    ).all()
    return {
        "items": await _serialise(db, list(rows)),
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/profiles/filters")
async def profile_filters(
    db: AsyncSession = Depends(get_db),
    _actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission(PERMISSION_KEY)),
):
    """Distinct non-empty department/division/company values of active local users."""
    out: dict[str, list[str]] = {}
    for field in ("department", "division", "company"):
        column = getattr(LocalUser, field)
        rows = await db.execute(
            select(column)
            .where(
                LocalUser.is_active.is_(True),
                LocalUser.deprovisioned_at.is_(None),
                column.is_not(None),
                func.trim(column) != "",
            )
            .distinct()
            .order_by(column.asc())
        )
        out[field] = [r[0] for r in rows.all()]
    return out


@router.get("/profiles/options")
async def profile_options(
    db: AsyncSession = Depends(get_db),
    _actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission(PERMISSION_KEY)),
):
    """Dropdown options for the page, readable with ONLY the `work-profiles` key.

    Deliberately not reusing `/attendance/templates` and `/attendance/locations`: those need the
    other two permission keys, and an HR user with just `work-profiles` must still be able to fill
    the selects. Active items only — an already-assigned inactive item is rendered by the page from
    the row it is stored on.
    """
    templates = (
        await db.execute(
            select(AttendanceTemplate.id, AttendanceTemplate.name)
            .where(AttendanceTemplate.is_active.is_(True))
            .order_by(AttendanceTemplate.name.asc())
        )
    ).all()
    locations = (
        await db.execute(
            select(AttendanceLocation.id, AttendanceLocation.name, AttendanceLocation.code)
            .where(AttendanceLocation.is_active.is_(True))
            .order_by(AttendanceLocation.name.asc())
        )
    ).all()
    return {
        "templates": [{"id": str(r[0]), "name": r[1]} for r in templates],
        "locations": [{"id": str(r[0]), "name": r[1], "code": r[2]} for r in locations],
    }


# ─── Write endpoints ──────────────────────────────────────────────────────────

@router.put("/profiles/{employee_id}")
async def set_profile(
    employee_id: str,
    payload: ProfileChanges,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission(PERMISSION_KEY)),
):
    """Upsert one employee's assignment. An empty body (or a body that changes nothing) is a
    200 no-op: no write, no audit row, `updated_at` untouched."""
    user, profile = await _load_target(db, employee_id)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        t_names, l_names = await _name_maps(
            db,
            [profile.template_id] if profile else [],
            [i for i in (profile.location_id, profile.wfh_location_id) if i] if profile else [],
        )
        return {**_profile_dict(user, profile, t_names, l_names), "changed": False, "fields": []}

    refs = await _resolve_refs(db, changes)
    plan, error = _plan_profile(profile, changes, refs)
    if error:
        raise HTTPException(status_code=422, detail=error)

    assert plan is not None
    if plan["changed"]:
        if profile is None:
            profile = EmployeeWorkProfile(employee_id=employee_id, **plan["values"], updated_by=actor_id)
            db.add(profile)
        else:
            for field, value in plan["values"].items():
                setattr(profile, field, value)
            profile.updated_at = _now()
            profile.updated_by = actor_id
        _audit(
            db,
            "ATTENDANCE_PROFILE_UPDATED",
            actor_id,
            f"แก้ไขโปรไฟล์การลงเวลาของพนักงาน {employee_id}",
            {"fields": sorted(plan["changed"]), "employee_id": employee_id},
        )
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise HTTPException(status_code=409, detail="มีผู้แก้ไขโปรไฟล์นี้ไปพร้อมกัน กรุณาลองใหม่")
        await db.refresh(profile)

    t_names, l_names = await _name_maps(
        db,
        [profile.template_id] if profile else [],
        [i for i in (profile.location_id, profile.wfh_location_id) if i] if profile else [],
    )
    return {**_profile_dict(user, profile, t_names, l_names), "changed": bool(plan["changed"]), "fields": plan["changed"]}


class BulkRequest(BaseModel):
    employee_ids: Optional[list[str]] = None
    filter: Optional[ProfileFilter] = None
    changes: ProfileChanges


@router.post("/profiles/bulk")
async def bulk_set_profiles(
    payload: BulkRequest,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission(PERMISSION_KEY)),
):
    """Assign the same changes to many employees in one transaction (all or nothing).

    Target selection: explicit `employee_ids` (≤ 500, unknown/inactive ids are reported as
    `skipped`) **or** a `filter` (resolved by the server, ≤ 1000 matches). Counts:
    `matched == updated + unchanged`; `skipped` is reported separately.
    """
    if (payload.employee_ids is None) == (payload.filter is None):
        raise HTTPException(status_code=422, detail="ให้ส่ง employee_ids หรือ filter อย่างใดอย่างหนึ่งเท่านั้น")

    changes = payload.changes.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(
            status_code=422,
            detail="changes ต้องมีอย่างน้อยหนึ่งฟิลด์จาก template_id, location_id, wfh_mode, wfh_location_id",
        )

    skipped: list[dict] = []
    if payload.employee_ids is not None:
        if len(payload.employee_ids) > MAX_BULK_IDS:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"ส่ง employee_ids มา {len(payload.employee_ids)} รายการ ซึ่งเกินกำหนดสูงสุด {MAX_BULK_IDS} รายการ "
                    "ต่อครั้ง — ถ้ามากกว่านี้ให้ใช้รูปแบบตัวกรอง (เลือกทั้งหมดที่ตรงกัน)"
                ),
            )
        ids = list(dict.fromkeys(i.strip() for i in payload.employee_ids if i and i.strip()))
        if not ids:
            raise HTTPException(status_code=422, detail="employee_ids ต้องมีรายชื่ออย่างน้อยหนึ่งรหัส")
        stmt = (
            select(LocalUser, EmployeeWorkProfile)
            .outerjoin(EmployeeWorkProfile, EmployeeWorkProfile.employee_id == LocalUser.employee_id)
            .where(LocalUser.employee_id.in_(ids))
            .order_by(LocalUser.employee_id.asc())
        )
        found = {u.employee_id: (u, p) for u, p in (await db.execute(stmt)).all()}
        targets: list[tuple[LocalUser, EmployeeWorkProfile | None]] = []
        for employee_id in ids:
            pair = found.get(employee_id)
            if pair is None:
                skipped.append({"employee_id": employee_id, "reason": "ไม่พบรหัสนี้ในระบบ"})
            elif not pair[0].is_active or pair[0].deprovisioned_at is not None:
                skipped.append({"employee_id": employee_id, "reason": "ถูกปิดใช้งาน"})
            else:
                targets.append(pair)
    else:
        filters = payload.filter or ProfileFilter()
        stmt = _base_query(filters)
        matched_total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar() or 0
        if matched_total > MAX_BULK_FILTER:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"ตัวกรองนี้ตรงกับพนักงาน {matched_total} คน ซึ่งเกินกำหนดสูงสุด {MAX_BULK_FILTER} คน "
                    "ต่อการเรียกหนึ่งครั้ง กรุณาเพิ่มเงื่อนไขให้แคบลง"
                ),
            )
        targets = list(
            (await db.execute(stmt.order_by(LocalUser.employee_id.asc()))).all()
        )

    refs = await _resolve_refs(db, changes)
    # A non-null id that does not exist at all is a client bug no matter who the targets are, so it
    # is rejected up front (the *inactive* rule stays per target, see _plan_profile).
    for field, table in (("template_id", "template"), ("location_id", "location"), ("wfh_location_id", "location")):
        value = changes.get(field)
        if value is not None and value not in refs[table]:
            raise HTTPException(status_code=422, detail=f"ไม่พบ{FIELD_LABELS[field]}ที่ระบุ")

    plans: list[tuple[LocalUser, EmployeeWorkProfile | None, dict]] = []
    problems: dict[str, int] = {}
    for user, profile in targets:
        plan, error = _plan_profile(profile, changes, refs)
        if error:
            problems[error] = problems.get(error, 0) + 1
        else:
            assert plan is not None
            plans.append((user, profile, plan))

    if problems:
        detail = "; ".join(f"{reason} ({count})" for reason, count in problems.items())
        raise HTTPException(
            status_code=422,
            detail=(
                f"ยังไม่มีการบันทึกใด ๆ: จากพนักงานที่เลือก {len(targets)} คน มี {sum(problems.values())} คน "
                f"ที่ทำตามคำขอนี้ไม่ได้ — {detail}"
            ),
        )

    changed_ids: list[str] = []
    for user, profile, plan in plans:
        if not plan["changed"]:
            continue
        if profile is None:
            profile = EmployeeWorkProfile(employee_id=user.employee_id, **plan["values"], updated_by=actor_id)
            db.add(profile)
        else:
            for field, value in plan["values"].items():
                setattr(profile, field, value)
            profile.updated_at = _now()
            profile.updated_by = actor_id
        changed_ids.append(user.employee_id)

    if changed_ids:
        _audit(
            db,
            "ATTENDANCE_PROFILE_BULK_UPDATED",
            actor_id,
            f"แก้ไขโปรไฟล์การลงเวลาหลายรายการ: {len(changed_ids)} รายการ",
            {
                "fields": sorted(changes.keys()),
                "template_id": str(changes["template_id"]) if changes.get("template_id") else None,
                "location_id": str(changes["location_id"]) if changes.get("location_id") else None,
                "wfh_mode": changes.get("wfh_mode"),
                "wfh_location_id": str(changes["wfh_location_id"]) if changes.get("wfh_location_id") else None,
                "matched": len(plans),
                "updated": len(changed_ids),
                "unchanged": len(plans) - len(changed_ids),
                "skipped": len(skipped),
                "employee_ids": changed_ids[:AUDIT_ID_SAMPLE],
                "employee_ids_total": len(changed_ids),
            },
        )

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="มีผู้แก้ไขโปรไฟล์บางรายการไปพร้อมกัน กรุณาลองใหม่")

    return {
        "matched": len(plans),
        "updated": len(changed_ids),
        "unchanged": len(plans) - len(changed_ids),
        "skipped": skipped,
        "fields": sorted(changes.keys()),
        "employee_ids": changed_ids,
    }
