"""Attendance master data — Location Master and Attendance Round Templates (task 014).

Two resources, both master data only (nothing reads them yet; employee assignment is task 015):

* ``/attendance/locations`` — where an employee may check in. Permission key ``locations``.
* ``/attendance/templates`` — a template owns an ordered list of rounds (a round = a window with an
  expected time and a photo flag). Permission key ``attendance-templates``.

All ``time`` values are **wall-clock in Asia/Bangkok**; this module stores and compares them as
``time without time zone`` and performs no timezone conversion. `seq` is always assigned by the
server from time order — clients never send it.
"""
from __future__ import annotations

import math
import re
import uuid
from datetime import date, datetime, time, timezone
from typing import Any, Iterable, Optional

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field, ValidationInfo, field_validator
from sqlalchemy import func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app import attendance_csv
from app import checkin_logic as logic
from app import photo_storage
from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user_id, require_permission
from app.line_identity import LineIdentity, get_bound_employee, get_verified_line_identity
from app.models import (
    AttendanceCheckin,
    AttendanceLocation,
    AttendanceTemplate,
    AttendanceTemplateRound,
    AuditLog,
    EmployeeWorkProfile,
    LocalUser,
)

router = APIRouter(prefix="/attendance", tags=["Attendance Master Data"])

# ─── Limits (also documented in .handoff/current/014-spec.md) ─────────────────
CODE_MAX = 32
NAME_MAX = 120
ADDRESS_MAX = 300
DESCRIPTION_MAX = 300
ROUND_LABEL_MAX = 80
MIN_ROUNDS = 1
MAX_ROUNDS = 10
RADIUS_MIN, RADIUS_MAX, RADIUS_DEFAULT = 10, 1000, 150
GRACE_MIN, GRACE_MAX = 0, 240

# Only a 24-hour HH:MM (optionally :SS) is accepted — "8:30", "24:00" and "7pm" are rejected with
# a 422 that says what to send. The frontend uses <input type="time">, which always sends HH:MM.
_TIME_RE = re.compile(r"^\d{2}:\d{2}(?::\d{2})?$")

# Messages in this module are shown to HR staff as-is by the three admin pages, so they are Thai
# (CONTEXT.md standing rule). Field NAMES (window_start, …) and status codes never change: only the
# sentence does, and these labels are how a Thai sentence names a field.
ROUND_FIELD_LABELS = {
    "window_start": "เริ่มลงเวลาได้",
    "expected_time": "เวลามาตรฐาน",
    "window_end": "ลงเวลาได้ถึง",
    "label": "ชื่อรอบ",
}
TEXT_FIELD_LABELS = {
    "code": "รหัส",
    "name": "ชื่อ",
    "address": "ที่อยู่",
    "description": "รายละเอียด",
}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_time(value: Any, field: str, round_no: int) -> time:
    """Accepts HH:MM / HH:MM:SS (or a real `time`); anything else is a 422 naming the round."""
    label = ROUND_FIELD_LABELS.get(field, field)
    if isinstance(value, time):
        parsed = value
    else:
        text = str(value).strip() if value is not None else ""
        if not _TIME_RE.match(text):
            raise HTTPException(
                status_code=422,
                detail=f"รอบที่ {round_no}: {label} ต้องอยู่ในรูป 24 ชั่วโมง HH:MM หรือ HH:MM:SS (ได้รับ '{value}')",
            )
        parts = text.split(":")
        hour, minute = int(parts[0]), int(parts[1])
        second = int(parts[2]) if len(parts) > 2 else 0
        if hour > 23 or minute > 59 or second > 59:
            raise HTTPException(
                status_code=422,
                detail=f"รอบที่ {round_no}: {label} ไม่ใช่เวลาที่ถูกต้อง (ได้รับ '{value}')",
            )
        parsed = time(hour, minute, second)
    if math.isnan(parsed.hour):  # pragma: no cover - defensive, time() cannot hold NaN
        raise HTTPException(status_code=422, detail=f"รอบที่ {round_no}: {label} ต้องเป็นตัวเลข")
    return parsed


def _write_audit(db: AsyncSession, action: str, actor_id: str, details: str, fields: Iterable[str]) -> None:
    """One audit row per write, carrying the changed field NAMES only — never the row itself."""
    db.add(
        AuditLog(
            action=action,
            actor_id=actor_id,
            details=details,
            metadata_json={"fields": sorted(set(fields))},
        )
    )


def _location_dict(row: AttendanceLocation) -> dict:
    return {
        "id": str(row.id),
        "code": row.code,
        "name": row.name,
        "address": row.address,
        "latitude": float(row.latitude),
        "longitude": float(row.longitude),
        "radius_meters": row.radius_meters,
        "is_active": row.is_active,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "updated_by": row.updated_by,
    }


def _round_dict(row: AttendanceTemplateRound) -> dict:
    return {
        "id": str(row.id),
        "seq": row.seq,
        "label": row.label,
        "window_start": row.window_start.strftime("%H:%M"),
        "expected_time": row.expected_time.strftime("%H:%M"),
        "window_end": row.window_end.strftime("%H:%M"),
        "photo_required": row.photo_required,
    }


def _template_dict(row: AttendanceTemplate) -> dict:
    rounds = sorted(row.rounds, key=lambda r: r.seq)
    return {
        "id": str(row.id),
        "name": row.name,
        "description": row.description,
        "grace_minutes": row.grace_minutes,
        "is_active": row.is_active,
        "round_count": len(rounds),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "updated_by": row.updated_by,
        "rounds": [_round_dict(r) for r in rounds],
    }


async def _load_template(db: AsyncSession, template_id: uuid.UUID) -> AttendanceTemplate:
    stmt = (
        select(AttendanceTemplate)
        .options(selectinload(AttendanceTemplate.rounds))
        .where(AttendanceTemplate.id == template_id)
    )
    row = (await db.execute(stmt)).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="ไม่พบแม่แบบรอบลงเวลา")
    return row


async def _load_location(db: AsyncSession, location_id: uuid.UUID) -> AttendanceLocation:
    row = (
        await db.execute(select(AttendanceLocation).where(AttendanceLocation.id == location_id))
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="ไม่พบสถานที่ทำงาน")
    return row


# ─── assigned_count (task 016) ────────────────────────────────────────────────
# Read-only addition to the two list endpoints: how many employee work profiles point at a row.
# A location counts once per profile even when it is both the workplace and the home point
# (`count(*)` over rows matching either column), and the counter ignores the list's own filters.

def _location_assigned_count():
    return (
        select(func.count(EmployeeWorkProfile.id))
        .where(
            or_(
                EmployeeWorkProfile.location_id == AttendanceLocation.id,
                EmployeeWorkProfile.wfh_location_id == AttendanceLocation.id,
            )
        )
        .correlate(AttendanceLocation)
        .scalar_subquery()
    )


def _template_assigned_count():
    return (
        select(func.count(EmployeeWorkProfile.id))
        .where(EmployeeWorkProfile.template_id == AttendanceTemplate.id)
        .correlate(AttendanceTemplate)
        .scalar_subquery()
    )


# ─── Shared validators ────────────────────────────────────────────────────────

def _clean_text(value: Any, info: ValidationInfo) -> Any:
    """Field validator shared by every request model.

    - strips incoming strings;
    - `code` is upper-cased (human code: LOC-001 == loc-001);
    - `address` / `description` become None when empty (the columns are nullable);
    - `code` / `name` may never be blank and may not be sent as an explicit null.
    """
    if value is None:
        if info.field_name in ("code", "name"):
            raise ValueError(f"กรุณากรอก{TEXT_FIELD_LABELS.get(info.field_name, info.field_name)}")
        return None
    if not isinstance(value, str):
        return value
    value = value.strip()
    if info.field_name == "code":
        value = value.upper()  # human code, normalised so LOC-001 == loc-001
        if value == "":
            raise ValueError("กรุณากรอกรหัส")
        return value
    if info.field_name in ("address", "description"):
        return value or None
    if value == "":
        raise ValueError(f"กรุณากรอก{TEXT_FIELD_LABELS.get(info.field_name, info.field_name)}")
    return value


def _clean_label(value: Any, info: ValidationInfo) -> Any:
    if not isinstance(value, str):
        return value
    value = value.strip()
    if value == "":
        raise ValueError("กรุณากรอกชื่อรอบ")
    return value


# ─── Request schemas ──────────────────────────────────────────────────────────

class LocationCreate(BaseModel):
    code: str = Field(..., max_length=CODE_MAX)
    name: str = Field(..., max_length=NAME_MAX)
    address: Optional[str] = Field(None, max_length=ADDRESS_MAX)
    latitude: float = Field(..., ge=-90, le=90, allow_inf_nan=False)
    longitude: float = Field(..., ge=-180, le=180, allow_inf_nan=False)
    radius_meters: int = Field(RADIUS_DEFAULT, ge=RADIUS_MIN, le=RADIUS_MAX)
    is_active: bool = True

    _clean = field_validator("code", "name", "address", mode="before")(_clean_text)


class LocationUpdate(BaseModel):
    code: Optional[str] = Field(None, max_length=CODE_MAX)
    name: Optional[str] = Field(None, max_length=NAME_MAX)
    address: Optional[str] = Field(None, max_length=ADDRESS_MAX)
    latitude: Optional[float] = Field(None, ge=-90, le=90, allow_inf_nan=False)
    longitude: Optional[float] = Field(None, ge=-180, le=180, allow_inf_nan=False)
    radius_meters: Optional[int] = Field(None, ge=RADIUS_MIN, le=RADIUS_MAX)
    is_active: Optional[bool] = None

    _clean = field_validator("code", "name", "address", mode="before")(_clean_text)


class RoundPayload(BaseModel):
    label: str = Field(..., max_length=ROUND_LABEL_MAX)
    window_start: Any
    expected_time: Any
    window_end: Any
    photo_required: bool = True

    _label = field_validator("label", mode="before")(_clean_label)


class TemplateCreate(BaseModel):
    name: str = Field(..., max_length=NAME_MAX)
    description: Optional[str] = Field(None, max_length=DESCRIPTION_MAX)
    grace_minutes: int = Field(0, ge=GRACE_MIN, le=GRACE_MAX)
    is_active: bool = True
    rounds: list[RoundPayload]

    _clean = field_validator("name", "description", mode="before")(_clean_text)


class TemplateUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=NAME_MAX)
    description: Optional[str] = Field(None, max_length=DESCRIPTION_MAX)
    grace_minutes: Optional[int] = Field(None, ge=GRACE_MIN, le=GRACE_MAX)
    is_active: Optional[bool] = None
    rounds: Optional[list[RoundPayload]] = None

    _clean = field_validator("name", "description", mode="before")(_clean_text)


# ─── Round rules (spec rule 2) ────────────────────────────────────────────────

def build_rounds(payload_rounds: list[RoundPayload]) -> list[dict]:
    """Validate a template's rounds and return them with server-assigned `seq`.

    Every violation is a 422 whose message names the offending round. Nothing is written here —
    callers mutate the session only after this returns.
    """
    if len(payload_rounds) < MIN_ROUNDS:
        raise HTTPException(status_code=422, detail=f"แม่แบบต้องมีอย่างน้อย {MIN_ROUNDS} รอบ")
    if len(payload_rounds) > MAX_ROUNDS:
        raise HTTPException(
            status_code=422,
            detail=f"แม่แบบหนึ่งอันมีได้ไม่เกิน {MAX_ROUNDS} รอบ (ได้รับ {len(payload_rounds)} รอบ)",
        )

    prepared: list[dict] = []
    for index, item in enumerate(payload_rounds, start=1):
        label = item.label
        window_start = _parse_time(item.window_start, "window_start", index)
        expected = _parse_time(item.expected_time, "expected_time", index)
        window_end = _parse_time(item.window_end, "window_end", index)

        if window_start >= window_end:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"รอบที่ {index} ('{label}'): เริ่มลงเวลาได้ ({window_start.strftime('%H:%M')}) "
                    "ต้องอยู่ก่อนลงเวลาได้ถึง — ระบบไม่รองรับรอบข้ามคืน"
                ),
            )
        if not (window_start <= expected <= window_end):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"รอบที่ {index} ('{label}'): เวลามาตรฐาน ({expected.strftime('%H:%M')}) ต้องอยู่ระหว่าง "
                    f"เริ่มลงเวลาได้ ({window_start.strftime('%H:%M')}) กับลงเวลาได้ถึง ({window_end.strftime('%H:%M')})"
                ),
            )
        prepared.append(
            {
                "label": label,
                "window_start": window_start,
                "expected_time": expected,
                "window_end": window_end,
                "photo_required": item.photo_required,
            }
        )

    # The client's order does not matter: the server sorts by time and numbers the rounds 1..N.
    prepared.sort(key=lambda r: (r["window_start"], r["expected_time"], r["window_end"]))
    for position in range(1, len(prepared)):
        previous, current = prepared[position - 1], prepared[position]
        if previous["window_end"] >= current["window_start"]:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"รอบที่ {position + 1} ('{current['label']}'): เริ่มลงเวลาได้ "
                    f"({current['window_start'].strftime('%H:%M')}) ต้องอยู่หลังลงเวลาได้ถึงของรอบก่อนหน้า "
                    f"({previous['window_end'].strftime('%H:%M')}) — รอบต้องไม่ซ้อนกัน"
                ),
            )
    for position, item in enumerate(prepared, start=1):
        item["seq"] = position
    return prepared


# ─── Locations ────────────────────────────────────────────────────────────────

async def _assert_code_free(db: AsyncSession, code: str, exclude_id: uuid.UUID | None = None) -> None:
    stmt = select(AttendanceLocation.id).where(func.upper(AttendanceLocation.code) == code.upper())
    if exclude_id is not None:
        stmt = stmt.where(AttendanceLocation.id != exclude_id)
    if (await db.execute(stmt.limit(1))).scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"มีรหัสสถานที่ '{code}' อยู่แล้ว")


@router.get("/locations")
async def list_locations(
    q: str = "",
    active: Optional[bool] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission("locations")),
):
    """Server-side paged list; `q` matches code or name (case-insensitive), `active` filters state.

    Each row carries `assigned_count` (task 016): profiles using it as workplace or home point.
    """
    stmt = select(AttendanceLocation, _location_assigned_count().label("assigned_count"))
    if q:
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(or_(AttendanceLocation.code.ilike(pattern), AttendanceLocation.name.ilike(pattern)))
    if active is not None:
        stmt = stmt.where(AttendanceLocation.is_active == active)

    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar() or 0
    rows = (
        await db.execute(
            stmt.order_by(AttendanceLocation.code.asc()).offset((page - 1) * page_size).limit(page_size)
        )
    ).all()
    return {
        "items": [{**_location_dict(row), "assigned_count": count} for row, count in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.post("/locations", status_code=201)
async def create_location(
    payload: LocationCreate,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission("locations")),
):
    await _assert_code_free(db, payload.code)
    row = AttendanceLocation(**payload.model_dump(), updated_by=actor_id)
    db.add(row)
    _write_audit(
        db,
        "ATTENDANCE_LOCATION_CREATED",
        actor_id,
        f"เพิ่มสถานที่ลงเวลา {payload.code}",
        payload.model_dump().keys(),
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail=f"มีรหัสสถานที่ '{payload.code}' อยู่แล้ว")
    await db.refresh(row)
    return _location_dict(row)


@router.get("/locations/{location_id}")
async def get_location(
    location_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission("locations")),
):
    return _location_dict(await _load_location(db, location_id))


@router.patch("/locations/{location_id}")
async def update_location(
    location_id: uuid.UUID,
    payload: LocationUpdate,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission("locations")),
):
    """Partial update. An empty body is a no-op (200, no audit row, `updated_at` untouched)."""
    row = await _load_location(db, location_id)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        return _location_dict(row)

    if "code" in changes and changes["code"] != row.code:
        await _assert_code_free(db, changes["code"], exclude_id=row.id)

    for field, value in changes.items():
        setattr(row, field, value)
    row.updated_by = actor_id
    row.updated_at = _now()
    _write_audit(
        db,
        "ATTENDANCE_LOCATION_UPDATED",
        actor_id,
        f"แก้ไขสถานที่ลงเวลา {row.code}",
        changes.keys(),
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail=f"มีรหัสสถานที่ '{changes.get('code')}' อยู่แล้ว")
    await db.refresh(row)
    return _location_dict(row)


# ─── Templates ────────────────────────────────────────────────────────────────

async def _assert_template_name_free(db: AsyncSession, name: str, exclude_id: uuid.UUID | None = None) -> None:
    """Names are compared case-insensitively so "Morning Shift" and "morning shift" clash (409)."""
    stmt = select(AttendanceTemplate.id).where(func.lower(AttendanceTemplate.name) == name.lower())
    if exclude_id is not None:
        stmt = stmt.where(AttendanceTemplate.id != exclude_id)
    if (await db.execute(stmt.limit(1))).scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"มีชื่อแม่แบบ '{name}' อยู่แล้ว")


@router.get("/templates")
async def list_templates(
    db: AsyncSession = Depends(get_db),
    _actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission("attendance-templates")),
):
    stmt = (
        select(AttendanceTemplate, _template_assigned_count().label("assigned_count"))
        .options(selectinload(AttendanceTemplate.rounds))
        .order_by(AttendanceTemplate.name.asc())
    )
    rows = (await db.execute(stmt)).all()
    return {
        "items": [{**_template_dict(row), "assigned_count": count} for row, count in rows],
        "total": len(rows),
    }


@router.post("/templates", status_code=201)
async def create_template(
    payload: TemplateCreate,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission("attendance-templates")),
):
    rounds = build_rounds(payload.rounds)
    await _assert_template_name_free(db, payload.name)

    row = AttendanceTemplate(
        name=payload.name,
        description=payload.description,
        grace_minutes=payload.grace_minutes,
        is_active=payload.is_active,
        updated_by=actor_id,
    )
    row.rounds = [AttendanceTemplateRound(**item) for item in rounds]
    db.add(row)
    fields = [k for k in payload.model_dump().keys() if k != "rounds"] + ["rounds"]
    _write_audit(db, "ATTENDANCE_TEMPLATE_CREATED", actor_id, f"เพิ่มแม่แบบการลงเวลา {payload.name}", fields)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail=f"มีชื่อแม่แบบ '{payload.name}' อยู่แล้ว")
    return _template_dict(await _load_template(db, row.id))


@router.get("/templates/{template_id}")
async def get_template(
    template_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission("attendance-templates")),
):
    return _template_dict(await _load_template(db, template_id))


@router.patch("/templates/{template_id}")
async def update_template(
    template_id: uuid.UUID,
    payload: TemplateUpdate,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission("attendance-templates")),
):
    """Partial update. A body containing `rounds` replaces the whole round list atomically:
    every rule is checked before anything is deleted or written."""
    row = await _load_template(db, template_id)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        return _template_dict(row)

    new_rounds = build_rounds(payload.rounds) if "rounds" in changes else None
    if "name" in changes and changes["name"] != row.name:
        await _assert_template_name_free(db, changes["name"], exclude_id=row.id)

    for field in ("name", "description", "grace_minutes", "is_active"):
        if field in changes:
            setattr(row, field, changes[field])
    if new_rounds is not None:
        row.rounds.clear()
        for item in new_rounds:
            row.rounds.append(AttendanceTemplateRound(**item))
    row.updated_by = actor_id
    row.updated_at = _now()
    _write_audit(
        db,
        "ATTENDANCE_TEMPLATE_UPDATED",
        actor_id,
        f"แก้ไขแม่แบบการลงเวลา {row.name}",
        changes.keys(),
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail=f"มีชื่อแม่แบบ '{changes.get('name')}' อยู่แล้ว")
    return _template_dict(await _load_template(db, template_id))


# ─── Check-in photos (task 020) ───────────────────────────────────────────────
# The storage folder is never mounted as static files: this authenticated route is the only way a
# photo can be read back, and it serves the file that the storage layer itself resolved (a key that
# does not match the generated pattern, or that escapes the storage root, is a 404 — the same answer
# as “no such photo”, so a probe cannot tell the two apart).

@router.get("/photos/{key:path}")
async def get_checkin_photo(
    key: str,
    _current_user=Depends(require_permission("attendance-records")),
):
    """Serve one stored check-in photo to HR staff who may read attendance records.

    Permission key `attendance-records` (task 022 moved it here from `work-profiles`): a photo is
    evidence attached to a person, so it is gated on the records key rather than on the key that
    assigns rounds and locations. The route itself is unchanged — no session, no photo.
    """
    storage = photo_storage.build_storage()
    try:
        path = storage.path_for(key)
    except photo_storage.PhotoKeyError:
        # Covers both “not a key this storage could have produced” and “file is gone”.
        raise HTTPException(status_code=404, detail="ไม่พบรูปภาพนี้") from None
    return FileResponse(
        path,
        media_type=storage.content_type_for(path),
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": "inline",
        },
    )


# ─── Employee check-in (task 021) ─────────────────────────────────────────────
# Two routes for the employee (identity comes from the verified LINE ID token, never from the body)
# and one read-only route for HR. Everything that breaks a rule is a flag on a stored record; only a
# meaningless record is refused. See `checkin_logic` for the rules themselves.

CHECKIN_PATH = "/api/v1/attendance/me/checkin"          # full path, used by the upload guard in main.py
CHECKIN_UNIQUE_INDEX = "uq_attendance_checkins_round"    # one check-in per employee/round/day
CHECKIN_WORK_DATE_INDEX = "ix_attendance_checkins_work_date"          # HR records page (task 022)
CHECKIN_REVIEW_STATUS_INDEX = "ix_attendance_checkins_review_status"  # HR records page (task 022)
CHECKIN_UPLOAD_SLACK_BYTES = 262144                      # multipart overhead allowed on top of the photo limit
CHECKIN_UPLOAD_HARD_FACTOR = 10                          # a body over 10x the photo limit is a plain 413
NO_TEMPLATE_MESSAGE_TH = "ยังไม่ได้กำหนดแม่แบบการลงเวลาให้คุณ กรุณาติดต่อฝ่ายบุคคล"
ALREADY_DONE_MESSAGE_TH = "ลงเวลารอบนี้แล้ว"
UPLOAD_TOO_LARGE_MESSAGE_TH = "ไฟล์รูปใหญ่เกินกำหนด กรุณาลงเวลาใหม่อีกครั้งโดยไม่แนบรูป"
UPLOAD_TOO_LARGE_HARD_MESSAGE_TH = "ข้อมูลที่ส่งมาใหญ่เกินกำหนด กรุณาลองใหม่อีกครั้ง"

# ─── Employee history (task 029) ──────────────────────────────────────────────
# The employee's **own** check-ins, one month at a time. Two deliberate bounds: the window (this month
# and the 12 before it) and the row count. A month cannot realistically be large — the round templates
# give at most a handful of check-ins a day, so ~62 rows a month for one person — but the cap keeps a
# corrupted or hand-edited database from turning one request into a huge answer.
HISTORY_MONTHS_BACK = 12
HISTORY_MAX_ROWS = 500
HISTORY_MONTH_PATTERN = re.compile(r"\d{4}-(0[1-9]|1[0-2])")
HISTORY_BAD_MONTH_TH = "รูปแบบเดือนไม่ถูกต้อง ต้องเป็น ปี-เดือน เช่น 2026-09"
HISTORY_FUTURE_MONTH_TH = "ยังไม่ถึงเดือนที่เลือก กรุณาเลือกเดือนปัจจุบันหรือเดือนก่อนหน้า"
HISTORY_TOO_OLD_MONTH_TH = f"ดูย้อนหลังได้ไม่เกิน {HISTORY_MONTHS_BACK} เดือน"
UNKNOWN_ROUND_NAME_TH = "รอบที่ไม่ระบุ"


def _shift_month(first_of_month: date, months: int) -> date:
    """The first day of the month `months` away from `first_of_month` (negative = back)."""
    index = first_of_month.year * 12 + (first_of_month.month - 1) + months
    return date(index // 12, index % 12 + 1, 1)


def _history_month(month: str | None, today: date) -> date:
    """The month the caller asked for, as its first day — or a Thai 422.

    `today` is the **server's** Bangkok date: the phone clock never decides what "this month" means.
    The default is the current month, and the oldest month the page may show is 12 months back.
    """
    current = today.replace(day=1)
    if month is None or not month.strip():
        return current
    value = month.strip()
    if not HISTORY_MONTH_PATTERN.fullmatch(value):
        raise HTTPException(status_code=422, detail=HISTORY_BAD_MONTH_TH)
    first = date(int(value[:4]), int(value[5:7]), 1)
    if first > current:
        raise HTTPException(status_code=422, detail=HISTORY_FUTURE_MONTH_TH)
    if first < _shift_month(current, -HISTORY_MONTHS_BACK):
        raise HTTPException(status_code=422, detail=HISTORY_TOO_OLD_MONTH_TH)
    return first


def _bangkok_moment(value: datetime | None) -> datetime | None:
    """A stored `checked_at` as a Bangkok-aware datetime.

    The column is `timestamp without time zone` and holds **Bangkok wall-clock** time (that is what a
    check-in writes: `logic.bangkok_now()`). A naive value is therefore marked as Bangkok instead of
    being interpreted in the server's local zone — the answer must not change when the service runs on
    a machine configured for UTC. An aware value (a test fixture, a future migration) is converted.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=logic.BANGKOK_TZ)
    return value.astimezone(logic.BANGKOK_TZ)


def _history_item(row: AttendanceCheckin) -> dict:
    """One check-in as **its owner** reads it.

    Deliberately tiny. Not in the answer, on purpose: the photo key/URL, coordinates, accuracy,
    distance, the HR review note, who reviewed it, the device, and the raw flags of other people. The
    flags that are sent are the employee's own reasons (the page maps them or ignores them silently).
    """
    checked_at = _bangkok_moment(row.checked_at)
    label = (row.round_label or "").strip()
    return {
        "id": str(row.id),
        "round_name": label or None,
        "checkin_time": checked_at.isoformat() if checked_at else None,
        "time_display": checked_at.strftime("%H:%M") if checked_at else None,
        "time_status": row.time_status,
        "location_status": row.location_status,
        "review_status": row.review_status,
        "flags": list(row.flags or []),
    }


def _history_summary(rows: list[AttendanceCheckin], days: int) -> dict:
    """The counts the page's summary line shows, derived from the very rows in the answer."""
    out_of_window = {logic.EARLY_OUT_OF_WINDOW, logic.LATE_OUT_OF_WINDOW}
    return {
        "days_with_checkins": days,
        "on_time": sum(1 for row in rows if row.time_status == logic.ON_TIME),
        "late": sum(1 for row in rows if row.time_status == logic.LATE),
        "out_of_window": sum(1 for row in rows if row.time_status in out_of_window),
        "pending_review": sum(1 for row in rows if row.review_status == logic.REVIEW_PENDING),
    }


def checkin_upload_limits() -> tuple[int, int]:
    """(guard, hard cap) in bytes for a check-in upload, from the current photo limit."""
    photo_limit = photo_storage.resolve_max_bytes(settings.PHOTO_MAX_BYTES)
    return photo_limit + CHECKIN_UPLOAD_SLACK_BYTES, photo_limit * CHECKIN_UPLOAD_HARD_FACTOR


async def _active_template(db: AsyncSession, profile: EmployeeWorkProfile | None) -> AttendanceTemplate | None:
    """The employee's template, or None when they have none / it was deactivated.

    A deactivated template is treated exactly like no template at all: HR switched it off, so the
    employee must not keep checking in against it (they get the Thai "contact HR" message).
    """
    if profile is None or profile.template_id is None:
        return None
    template = (await db.execute(
        select(AttendanceTemplate).where(AttendanceTemplate.id == profile.template_id)
    )).scalar_one_or_none()
    if template is None or not template.is_active:
        return None
    return template


async def _rounds_of(db: AsyncSession, template_id) -> list[AttendanceTemplateRound]:
    return list((await db.execute(
        select(AttendanceTemplateRound)
        .where(AttendanceTemplateRound.template_id == template_id)
        .order_by(AttendanceTemplateRound.seq)
    )).scalars().all())


async def _assigned_locations(db: AsyncSession, profile: EmployeeWorkProfile | None) -> list[AttendanceLocation]:
    """Locations this employee may check in at today.

    The profile's workplace, plus the home point when WFH mode is on. A location that was assigned and
    later deactivated is still used — HR assigned it, and this task does not second-guess that.
    """
    if profile is None:
        return []
    wanted = [profile.location_id]
    if profile.wfh_mode:
        wanted.append(profile.wfh_location_id)
    ids = [value for value in dict.fromkeys(wanted) if value is not None]
    if not ids:
        return []
    rows = (await db.execute(select(AttendanceLocation).where(AttendanceLocation.id.in_(ids)))).scalars().all()
    order = {value: index for index, value in enumerate(ids)}
    return sorted(rows, key=lambda row: order.get(row.id, len(order)))


async def _checkins_on(db: AsyncSession, employee_id: str, work_date) -> list[AttendanceCheckin]:
    return list((await db.execute(
        select(AttendanceCheckin)
        .where(AttendanceCheckin.employee_id == employee_id, AttendanceCheckin.work_date == work_date)
    )).scalars().all())


async def _read_upload_limited(upload: UploadFile, limit: int, chunk_size: int = 64 * 1024) -> bytes | None:
    """Read at most `limit` bytes; None as soon as the upload is bigger.

    Never holds more than the limit in memory. (Starlette has already spooled the part to a temporary
    file by the time this runs — the hard limit on the whole body is enforced earlier, by the
    middleware that rejects an oversize `Content-Length` before anything is read.)
    """
    buffer = bytearray()
    while True:
        block = await upload.read(chunk_size)
        if not block:
            return bytes(buffer)
        if len(buffer) + len(block) > limit:
            return None
        buffer.extend(block)


@router.get("/me/today")
async def get_my_today(
    db: AsyncSession = Depends(get_db),
    identity: LineIdentity = Depends(get_verified_line_identity),
):
    """Today's rounds for the employee identified by the verified LINE token.

    Deliberately carries **no coordinates**: home points are personal data, so the phone only learns
    the names of the places it is allowed to check in at. The employee's own times/locations are the
    only ones in the answer. When HR has not assigned a template, this is still a 200 with a Thai
    message — the page shows it instead of an error.
    """
    employee_id = await get_bound_employee(identity, db)
    now_local = logic.bangkok_now()
    work_date = now_local.date()

    user = (await db.execute(select(LocalUser).where(LocalUser.employee_id == employee_id))).scalar_one_or_none()
    profile = (await db.execute(
        select(EmployeeWorkProfile).where(EmployeeWorkProfile.employee_id == employee_id)
    )).scalar_one_or_none()
    template = await _active_template(db, profile)
    locations = await _assigned_locations(db, profile)

    workplace = next((row.name for row in locations if profile and row.id == profile.location_id), None)
    wfh_home_name = None
    if profile is not None and profile.wfh_mode:
        wfh_home_name = next((row.name for row in locations if row.id == profile.wfh_location_id), None)

    payload = {
        "server_now": now_local.isoformat(),
        "work_date": work_date.isoformat(),
        "employee": {"employee_id": employee_id, "full_name": user.full_name if user else None},
        "template": None,
        "rounds": [],
        "workplace": workplace,
        "wfh_home_name": wfh_home_name,
        "needs_location": bool(workplace or wfh_home_name),
        "message": None,
    }

    if template is None:
        payload["message"] = NO_TEMPLATE_MESSAGE_TH
        return payload

    rounds = await _rounds_of(db, template.id)
    if not rounds:
        payload["message"] = NO_TEMPLATE_MESSAGE_TH
        return payload

    today = {row.round_id: row for row in await _checkins_on(db, employee_id, work_date)}
    payload["template"] = {"name": template.name, "grace_minutes": template.grace_minutes}

    now_minutes = now_local.hour * 60 + now_local.minute
    for row in rounds:
        checkin = today.get(row.id)
        if checkin is not None:
            state = "done"
        elif logic.inside_window(row, now_local):
            state = "open"
        elif now_minutes < row.window_start.hour * 60 + row.window_start.minute:
            state = "upcoming"
        else:
            state = "missed"
        payload["rounds"].append({
            "round_id": str(row.id),
            "seq": row.seq,
            "label": row.label,
            "window_start": row.window_start.strftime("%H:%M"),
            "expected_time": row.expected_time.strftime("%H:%M"),
            "window_end": row.window_end.strftime("%H:%M"),
            "photo_required": row.photo_required,
            "state": state,
            "checkin": (
                {
                    "checked_at": (
                        moment.isoformat() if (moment := _bangkok_moment(checkin.checked_at)) else None
                    ),
                    "time_status": checkin.time_status,
                    "flags": list(checkin.flags or []),
                }
                if checkin is not None
                else None
            ),
        })
    return payload


@router.get("/me/history")
async def get_my_history(
    month: str | None = Query(None, description="ปี-เดือน เช่น 2026-09 (ค่าเริ่มต้น: เดือนปัจจุบัน)"),
    db: AsyncSession = Depends(get_db),
    identity: LineIdentity = Depends(get_verified_line_identity),
):
    """One month of the caller's **own** check-ins (task 029).

    Identity comes only from the verified LINE ID token: `employee_id` is never read from the query
    string or the body, so nobody can ask for somebody else's history (the same rule as `me/today`).
    The answer is read-only — nothing here writes, and no audit row is produced for a read.
    """
    employee_id = await get_bound_employee(identity, db)
    first = _history_month(month, logic.bangkok_now().date())
    next_first = _shift_month(first, 1)

    rows = list((await db.execute(
        select(AttendanceCheckin)
        .where(
            AttendanceCheckin.employee_id == employee_id,
            AttendanceCheckin.work_date >= first,
            AttendanceCheckin.work_date < next_first,
        )
        # Newest day first; inside a day the server's own time order. `work_date` is the Bangkok date
        # the check-in belongs to, so no timezone conversion happens here at all.
        .order_by(AttendanceCheckin.work_date.desc(), AttendanceCheckin.checked_at.asc())
        .limit(HISTORY_MAX_ROWS)
    )).scalars().all())

    days: list[dict] = []
    by_date: dict[str, dict] = {}
    for row in rows:
        key = row.work_date.isoformat()
        day = by_date.get(key)
        if day is None:
            day = {"work_date": key, "items": []}
            by_date[key] = day
            days.append(day)
        day["items"].append(_history_item(row))

    return {
        "month": first.strftime("%Y-%m"),
        "days": days,
        "summary": _history_summary(rows, len(days)),
    }


def _rounds_item(row: AttendanceTemplateRound) -> dict:
    """One round of the employee's schedule (task 030).

    Six keys, and deliberately no `id`: the phone has no use for a round's id, and the employee's answer
    should not carry master-data keys at all. An empty stored label comes back as `null` — the page names
    it ("รอบที่ N") and never shows a blank line.
    """
    label = (row.label or "").strip()
    return {
        "seq": row.seq,
        "name": label or None,
        "window_start": row.window_start.strftime("%H:%M"),
        "expected_time": row.expected_time.strftime("%H:%M"),
        "window_end": row.window_end.strftime("%H:%M"),
        "photo_required": bool(row.photo_required),
    }


async def _rounds_of_profile(db: AsyncSession, profile: EmployeeWorkProfile | None) -> list[dict]:
    """The active template's rounds **in time order** (task 030).

    `seq` is assigned by task 014 from time order, so this is normally identical to seq order; sorting by
    `window_start` (with `seq` as the tie-breaker) is what makes the promise "time order" true even for a
    template somebody edited by hand.
    """
    template = await _active_template(db, profile)
    if template is None:
        return []
    rounds = await _rounds_of(db, template.id)
    ordered = sorted(rounds, key=lambda row: (row.window_start, row.seq))
    return [_rounds_item(row) for row in ordered]


async def _workplace_of(db: AsyncSession, profile: EmployeeWorkProfile | None) -> dict | None:
    """The employee's workplace as the phone may see it: a **name and a radius**, nothing else.

    No id, no address, and above all no coordinates — the phone must never learn where a location is, only
    that it is allowed to check in there (task 021's rule). A deactivated location that is still assigned
    is shown: HR assigned it, and `me/today` follows the same rule.
    """
    if profile is None or profile.location_id is None:
        return None
    row = (await db.execute(
        select(AttendanceLocation).where(AttendanceLocation.id == profile.location_id)
    )).scalar_one_or_none()
    if row is None:
        return None
    return {"name": row.name, "radius_meters": row.radius_meters}


async def _wfh_of(db: AsyncSession, profile: EmployeeWorkProfile | None) -> dict | None:
    """`None` when WFH is off (the page then says nothing about it).

    When it is on, only the home point's **name** is sent — never its radius, address or coordinates, and
    never when HR has deactivated that home point (the name may be personal data, so a retired point is
    not advertised). The key stays present with `home_name: null` in that case, so the page can tell
    "WFH on, home point retired" from "WFH off".
    """
    if profile is None or not profile.wfh_mode:
        return None
    home = None
    if profile.wfh_location_id is not None:
        home = (await db.execute(
            select(AttendanceLocation).where(AttendanceLocation.id == profile.wfh_location_id)
        )).scalar_one_or_none()
    return {"enabled": True, "home_name": home.name if home is not None and home.is_active else None}


@router.get("/me/rounds")
async def get_my_rounds(
    db: AsyncSession = Depends(get_db),
    identity: LineIdentity = Depends(get_verified_line_identity),
):
    """The caller's own check-in schedule (task 030): template, rounds, workplace, WFH.

    This is the answer to "which rounds do I have, when, where and do I need a photo?" — the question an
    employee asks *before* checking in. Read-only, and the same identity rule as `me/today`/`me/history`:
    the employee id comes only from the verified LINE token, so nobody can look at somebody else's
    schedule. No coordinates, no ids, no home radius — see the two helpers above for what each card may
    carry.

    An employee with no profile, no template or an inactive template gets `has_schedule: false` and the
    same Thai sentence `me/today` uses (never an error: HR simply has not set them up yet).
    """
    employee_id = await get_bound_employee(identity, db)
    profile = (await db.execute(
        select(EmployeeWorkProfile).where(EmployeeWorkProfile.employee_id == employee_id)
    )).scalar_one_or_none()

    payload = {
        "has_schedule": False,
        "message": NO_TEMPLATE_MESSAGE_TH,
        "template": None,
        "rounds": [],
        "workplace": await _workplace_of(db, profile),
        "wfh": await _wfh_of(db, profile),
    }

    template = await _active_template(db, profile)
    if template is None:
        return payload

    payload["has_schedule"] = True
    payload["message"] = None
    payload["template"] = {"name": template.name, "grace_minutes": template.grace_minutes}
    payload["rounds"] = await _rounds_of_profile(db, profile)
    return payload


@router.post("/me/checkin", status_code=201)
async def post_my_checkin(
    request: Request,
    lat: str | None = Form(None),
    lng: str | None = Form(None),
    accuracy: str | None = Form(None),
    photo: UploadFile | None = File(None),
    db: AsyncSession = Depends(get_db),
    identity: LineIdentity = Depends(get_verified_line_identity),
):
    """Record one check-in for the employee identified by the verified LINE token.

    Trust boundary: the only identity used is the one inside the ID token, and the only clock is the
    server's. Any other form field a caller invents (`employee_id`, `line_user_id`, `checked_at`, …) is
    simply not read — the request is a check-in for the token's own employee or nothing.

    Everything that breaks a rule is recorded with flags; a failed/oversize/absent photo never fails
    the check-in either (task 020's storage layer reports why).
    """
    employee_id = await get_bound_employee(identity, db)
    now_local = logic.bangkok_now()
    work_date = now_local.date()

    profile = (await db.execute(
        select(EmployeeWorkProfile).where(EmployeeWorkProfile.employee_id == employee_id)
    )).scalar_one_or_none()
    template = await _active_template(db, profile)
    if template is None:
        raise HTTPException(status_code=409, detail=NO_TEMPLATE_MESSAGE_TH)
    rounds = await _rounds_of(db, template.id)
    if not rounds:
        raise HTTPException(status_code=409, detail=NO_TEMPLATE_MESSAGE_TH)

    today_rows = await _checkins_on(db, employee_id, work_date)
    done_ids = [row.round_id for row in today_rows if row.round_id is not None]
    if len(done_ids) >= len(rounds):
        raise HTTPException(status_code=409, detail=ALREADY_DONE_MESSAGE_TH)

    round_row, _out_of_window = logic.select_round(rounds, done_ids, now_local)
    if round_row is None:
        raise HTTPException(status_code=409, detail=ALREADY_DONE_MESSAGE_TH)

    # Pre-check (the partial unique index is the real guarantee, mapped below).
    if any(row.round_id == round_row.id for row in today_rows):
        raise HTTPException(status_code=409, detail=ALREADY_DONE_MESSAGE_TH)

    time_status = logic.time_status_for(round_row, template.grace_minutes, now_local)

    reading = logic.parse_gps(lat, lng, accuracy)
    locations = await _assigned_locations(db, profile)
    location_verdict = logic.evaluate_location(reading, locations)

    # Photo: read with a hard in-memory bound, then hand the bytes to the storage layer.
    photo_limit = photo_storage.resolve_max_bytes(settings.PHOTO_MAX_BYTES)
    sent = False
    save_ok, save_reason = False, None
    photo_key = None
    if photo is not None:
        data = await _read_upload_limited(photo, photo_limit)
        if data is None:
            sent, save_reason = True, "too_large"
        elif data:
            sent = True
            result = photo_storage.build_storage().save(data, photo.content_type)
            save_ok, save_reason, photo_key = result.ok, result.reason, result.key
        # an empty part counts as "not sent"
    photo_status = logic.photo_outcome(round_row.photo_required, sent, save_ok, save_reason)

    flags = logic.build_flags(time_status, location_verdict, photo_status)
    reviewed = logic.review_status_for(flags)

    row = AttendanceCheckin(
        employee_id=employee_id,
        work_date=work_date,
        checked_at=now_local,
        round_id=round_row.id,
        template_name=template.name,
        round_seq=round_row.seq,
        round_label=round_row.label,
        expected_time=round_row.expected_time,
        window_start=round_row.window_start,
        window_end=round_row.window_end,
        grace_minutes=template.grace_minutes,
        photo_required=round_row.photo_required,
        time_status=time_status,
        lat=reading.lat,
        lng=reading.lng,
        accuracy_m=reading.accuracy_m,
        gps_status=location_verdict.gps_status,
        matched_location_id=location_verdict.matched_location_id,
        matched_location_name=location_verdict.matched_location_name,
        distance_m=location_verdict.distance_m,
        location_status=location_verdict.location_status,
        photo_key=photo_key,
        photo_status=photo_status,
        flags=flags,
        review_status=reviewed,
    )
    db.add(row)
    _write_audit(
        db,
        "ATTENDANCE_CHECKIN",
        employee_id,
        # Thai like every other audit row (task 047 / 046 debt item 3). The three outcome codes stay
        # as they are — they are the machine-readable values HR support greps for, and they are what
        # the 022 checks pin (no coordinates, no photo key, no clock time in this sentence).
        f"ลงเวลาของพนักงาน {employee_id} รอบ {round_row.seq} ({round_row.label}): "
        f"{time_status} / {location_verdict.location_status} / {photo_status}",
        ["employee_id", "round_id", "time_status", "location_status", "photo_status", "flags"],
    )
    try:
        await db.commit()
    except IntegrityError as exc:
        # Two taps (or two devices) at the same moment: the partial unique index is the guarantee.
        await db.rollback()
        if CHECKIN_UNIQUE_INDEX in str(getattr(exc, "orig", exc)):
            raise HTTPException(status_code=409, detail=ALREADY_DONE_MESSAGE_TH) from None
        raise

    return {
        "checked_at": now_local.isoformat(),
        "round_label": round_row.label,
        "time_status": time_status,
        "location_status": location_verdict.location_status,
        "photo_status": photo_status,
        "flags": flags,
        "message_th": logic.employee_message_th(now_local, time_status, location_verdict, photo_status),
    }


# ─── HR records + review (task 022) ───────────────────────────────────────────
# Everything here is session + `attendance-records`. Reading a record and reading its photo are the
# same sensitivity, so they share one key. Nothing below changes what the employee side stored.

RECORDS_PERMISSION = "attendance-records"
REVIEW_NOTE_MAX = 500
BULK_REVIEW_MAX = 100
RANGE_MAX_DAYS = 92                                    # cap for the summary aggregate (and the list)
# The `by_location` entry for rows that matched no location (task 056). Thai, like every user-visible string.
LOCATION_UNSPECIFIED_TH = "ไม่ระบุสถานที่"
REVIEW_STATUS_VALUES = ("ACCEPTED", "REJECTED")
REVIEWABLE_STATUSES = (logic.REVIEW_PENDING, logic.REVIEW_ACCEPTED, logic.REVIEW_REJECTED)
NOT_FLAGGED_MESSAGE_TH = "รายการนี้ไม่มีธงที่ต้องตรวจ"
NOTE_REQUIRED_MESSAGE_TH = "กรุณาระบุเหตุผลที่ไม่ยอมรับรายการนี้"
REVIEW_CHANGED_MESSAGE_TH = "บันทึกผลการตรวจสอบแล้ว"
RECORD_NOT_FOUND_MESSAGE_TH = "ไม่พบรายการลงเวลานี้"
BAD_REVIEW_STATUS_MESSAGE_TH = "สถานะการตรวจสอบต้องเป็น ACCEPTED หรือ REJECTED เท่านั้น"
BULK_STATUS_MESSAGE_TH = "การยอมรับหลายรายการทำได้เฉพาะสถานะ ACCEPTED เท่านั้น"
BULK_SIZE_MESSAGE_TH = f"เลือกได้ครั้งละ 1 ถึง {BULK_REVIEW_MAX} รายการ"
NOTE_TOO_LONG_MESSAGE_TH = f"เหตุผลยาวเกินกำหนด (ไม่เกิน {REVIEW_NOTE_MAX} ตัวอักษร)"
RANGE_ORDER_MESSAGE_TH = "ช่วงวันที่ไม่ถูกต้อง: วันที่เริ่มต้องไม่หลังวันที่สิ้นสุด"
RANGE_TOO_LONG_MESSAGE_TH = f"ช่วงวันที่ต้องไม่เกิน {RANGE_MAX_DAYS} วัน"
# `location_id=none` is the "ไม่ระบุสถานที่" group (task 061): the check-ins that matched no location.
# The ids are UUIDs (`models.py:271` `matched_location_id`), so anything else is a bad filter value
# rather than a filter that matches nothing.
LOCATION_FILTER_NONE = "none"
BAD_LOCATION_FILTER_MESSAGE_TH = "ตัวกรองสถานที่ต้องเป็นรหัสสถานที่หรือคำว่า none เท่านั้น"


def _parse_location_filter(raw: str | None) -> tuple[uuid.UUID | None, bool]:
    """`(location_id, matched_none)` from the `location_id` query value.

    Empty/absent means "no filter", the literal `none` means `matched_location_id IS NULL` (the group the
    056 dashboard shows as "ไม่ระบุสถานที่"), and a UUID selects that location. Anything else is refused with
    a Thai 422 — the style `_validate_range` already uses for a bad parameter — because a malformed value
    would otherwise reach asyncpg and come back as a 500.
    """
    if raw is None or not raw.strip():
        return None, False
    value = raw.strip()
    if value.lower() == LOCATION_FILTER_NONE:
        return None, True
    try:
        return uuid.UUID(value), False
    except ValueError:
        raise HTTPException(status_code=422, detail=BAD_LOCATION_FILTER_MESSAGE_TH) from None


def _like_pattern(value: str) -> str:
    """A `%…%` pattern with the caller's wildcards escaped, so `%` in a search is just a character."""
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _validate_range(date_from: date | None, date_to: date | None) -> None:
    """422 (Thai) for an inverted range or one wider than the cap — protects the summary aggregate."""
    if date_from is not None and date_to is not None:
        if date_from > date_to:
            raise HTTPException(status_code=422, detail=RANGE_ORDER_MESSAGE_TH)
        if (date_to - date_from).days + 1 > RANGE_MAX_DAYS:
            raise HTTPException(status_code=422, detail=RANGE_TOO_LONG_MESSAGE_TH)


def _record_conditions(
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    employee_id: str | None = None,
    q: str | None = None,
    flag: str | None = None,
    has_flags: bool | None = None,
    review_status: str | None = None,
    review_statuses: Iterable[str] | None = None,
    time_status: str | None = None,
    location_status: str | None = None,
    location_id: uuid.UUID | None = None,
    location_none: bool = False,
):
    """The WHERE clauses shared by the records list, its count and the CSV export (task 024).

    One builder on purpose: the export must never drift from what the page lists. `review_status` is
    the single value the page's dropdown sends; `review_statuses` is the counted set the export uses.
    """
    conditions = []
    if date_from is not None:
        conditions.append(AttendanceCheckin.work_date >= date_from)
    if date_to is not None:
        conditions.append(AttendanceCheckin.work_date <= date_to)
    if employee_id:
        conditions.append(AttendanceCheckin.employee_id == employee_id)
    if q:
        pattern = _like_pattern(q.strip())
        conditions.append(or_(
            AttendanceCheckin.employee_id.ilike(pattern, escape="\\"),
            LocalUser.full_name.ilike(pattern, escape="\\"),
        ))
    if flag:
        conditions.append(AttendanceCheckin.flags.contains([flag]))
    if has_flags:
        # The page's "เฉพาะที่มีธง" toggle: any flag at all, whatever its code. Added to the filter set
        # the spec lists because a client-side filter would lie once the table is paged.
        conditions.append(func.jsonb_array_length(AttendanceCheckin.flags) > 0)
    if review_status:
        conditions.append(AttendanceCheckin.review_status == review_status)
    if review_statuses:
        conditions.append(AttendanceCheckin.review_status.in_(list(review_statuses)))
    if time_status:
        conditions.append(AttendanceCheckin.time_status == time_status)
    if location_status:
        conditions.append(AttendanceCheckin.location_status == location_status)
    # Task 061. `location_none` and `location_id` are exclusive by construction: `_parse_location_filter`
    # never returns both. The snapshot column is filtered, never `attendance_locations` — a record from a
    # since-deleted location must still be findable by the id/name it was stored with.
    if location_none:
        conditions.append(AttendanceCheckin.matched_location_id.is_(None))
    elif location_id is not None:
        conditions.append(AttendanceCheckin.matched_location_id == location_id)
    return conditions


def _records_select(
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    default_range_to_today: bool = False,
    employee_id: str | None = None,
    q: str | None = None,
    flag: str | None = None,
    has_flags: bool | None = None,
    review_status: str | None = None,
    review_statuses: Iterable[str] | None = None,
    time_status: str | None = None,
    location_status: str | None = None,
    location_id: uuid.UUID | None = None,
    location_none: bool = False,
):
    """(rows statement, count statement) for the same filters.

    The employee join is a LEFT OUTER JOIN on purpose: a check-in whose `local_users` row was deleted
    must still be listed and reviewed (the name simply comes back null).
    """
    _validate_range(date_from, date_to)
    if default_range_to_today and date_from is None and date_to is None:
        today = logic.bangkok_now().date()
        date_from = date_to = today

    conditions = _record_conditions(
        date_from=date_from,
        date_to=date_to,
        employee_id=employee_id,
        q=q,
        flag=flag,
        has_flags=has_flags,
        review_status=review_status,
        review_statuses=review_statuses,
        time_status=time_status,
        location_status=location_status,
        location_id=location_id,
        location_none=location_none,
    )

    rows_stmt = select(
        AttendanceCheckin,
        LocalUser.full_name,
        LocalUser.department,
    ).outerjoin(LocalUser, LocalUser.employee_id == AttendanceCheckin.employee_id)
    count_stmt = select(func.count()).select_from(AttendanceCheckin).outerjoin(
        LocalUser, LocalUser.employee_id == AttendanceCheckin.employee_id
    )

    return rows_stmt.where(*conditions), count_stmt.where(*conditions)


async def _load_record(db: AsyncSession, checkin_id: uuid.UUID):
    """(row, full_name, department) or 404 — used by the detail, review and bulk endpoints."""
    result = (await db.execute(
        select(AttendanceCheckin, LocalUser.full_name, LocalUser.department)
        .outerjoin(LocalUser, LocalUser.employee_id == AttendanceCheckin.employee_id)
        .where(AttendanceCheckin.id == checkin_id)
    )).first()
    if result is None:
        raise HTTPException(status_code=404, detail=RECORD_NOT_FOUND_MESSAGE_TH)
    return result


@router.get("/checkins")
async def list_checkins(
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    employee_id: str | None = Query(None),
    q: str | None = Query(None, max_length=120),
    flag: str | None = Query(None),
    has_flags: bool | None = Query(None),
    review_status: str | None = Query(None),
    time_status: str | None = Query(None),
    location_status: str | None = Query(None),
    location_id: str | None = Query(None, description="location UUID, or `none` for records that matched no location"),
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _current_user=Depends(require_permission(RECORDS_PERMISSION)),
):
    """Check-ins for HR, filtered and paged. Newest first, stable across pages.

    No LINE user id and no token is ever part of an answer — the table does not even store them.
    Filters that do not match a known code (`flag`, `review_status`, `time_status`, `location_status`)
    simply match nothing; the page only ever sends values from its own dropdowns. `location_id` is the
    one exception: a value that is neither a UUID nor `none` is a Thai 422 (task 061), because it would
    otherwise reach asyncpg as a malformed UUID. An id that simply has no rows is not an error.
    """
    parsed_location, location_none = _parse_location_filter(location_id)
    rows_stmt, count_stmt = _records_select(
        date_from=date_from,
        date_to=date_to,
        employee_id=employee_id,
        q=q,
        flag=flag,
        has_flags=has_flags,
        review_status=review_status,
        time_status=time_status,
        location_status=location_status,
        location_id=parsed_location,
        location_none=location_none,
    )
    total = (await db.execute(count_stmt)).scalar() or 0
    rows = (await db.execute(
        rows_stmt.order_by(AttendanceCheckin.checked_at.desc(), AttendanceCheckin.id.desc())
        .offset((page - 1) * page_size).limit(page_size)
    )).all()

    return {
        "items": [_checkin_dict(row, full_name, department) for row, full_name, department in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/checkins/summary")
async def checkins_summary(
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    location_id: str | None = Query(None, description="location UUID, or `none` for records that matched no location"),
    db: AsyncSession = Depends(get_db),
    _current_user=Depends(require_permission(RECORDS_PERMISSION)),
):
    """Counters for the chips above the table. Default range: today (Asia/Bangkok).

    The counts use exactly the same date predicate as the list, so the chips and the table can never
    disagree — but note the one difference: with **no** dates given the summary assumes today, while
    the list has no date filter at all. The page always sends its own range, so this never shows up.

    Task 061: the records page sends **its whole query string** to this endpoint, so `location_id` is
    honoured here too — otherwise the chips above a location-filtered table would count rows the table
    is not showing. The other filters (`q`, `flag`, `review_status`, `time_status`, `location_status`)
    are deliberately still ignored: the page's chips are review-status chips and the summary's
    `by_review_status` is what they render, while a chip count narrowed by a flag would be misleading.
    """
    _validate_range(date_from, date_to)
    parsed_location, location_none = _parse_location_filter(location_id)
    since, until = date_from, date_to
    if since is None and until is None:
        since = until = logic.bangkok_now().date()

    conditions = []
    params: dict[str, Any] = {}
    if since is not None:
        conditions.append("work_date >= :since")
        params["since"] = since
    if until is not None:
        conditions.append("work_date <= :until")
        params["until"] = until
    if location_none:
        conditions.append("matched_location_id IS NULL")
    elif parsed_location is not None:
        conditions.append("matched_location_id = :location_id")
        params["location_id"] = parsed_location
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    review_rows = (await db.execute(text(
        f"SELECT review_status, count(*) FROM attendance_checkins {where} GROUP BY review_status"
    ), params)).all()
    by_review = {status: 0 for status in
                 (logic.REVIEW_CLEAN, logic.REVIEW_PENDING, logic.REVIEW_ACCEPTED, logic.REVIEW_REJECTED)}
    for status, count in review_rows:
        by_review[status] = count

    flag_rows = (await db.execute(text(
        f"SELECT flag, count(*) FROM attendance_checkins "
        f"LEFT JOIN LATERAL jsonb_array_elements_text(flags) AS flag ON TRUE {where} "
        f"GROUP BY flag ORDER BY count(*) DESC, flag"
    ), params)).all()
    by_flag = {flag: count for flag, count in flag_rows if flag is not None}

    # Which location the check-ins were matched to (task 056, for the HR dashboard card). Grouped on the
    # **snapshot** columns the record carries, never joined back to `attendance_locations`: a location renamed
    # or deactivated after the check-in must still be reported as the record itself says it was. Rows that
    # matched no location (GPS missing/outside, `matched_location_id IS NULL`) become one entry with the
    # placeholder name below, so the counts always add up to `total`. No index backs this column (the survey
    # 055 noted it); the aggregate runs over one day, which is why that is acceptable here.
    location_rows = (await db.execute(text(
        f"SELECT matched_location_id, matched_location_name, count(*) FROM attendance_checkins {where} "
        f"GROUP BY matched_location_id, matched_location_name "
        f"ORDER BY count(*) DESC, matched_location_name"
    ), params)).all()
    by_location = [
        {
            "location_id": str(location_id) if location_id else None,
            "location_name": (LOCATION_UNSPECIFIED_TH if location_id is None
                              else (location_name or str(location_id))),
            "count": count,
        }
        for location_id, location_name, count in location_rows
    ]

    return {
        "date_from": since.isoformat() if since else None,
        "date_to": until.isoformat() if until else None,
        "total": sum(by_review.values()),
        "by_review_status": by_review,
        "by_flag": by_flag,
        "by_location": by_location,
    }


# ─── CSV export (task 024) ────────────────────────────────────────────────────────────────────────
#
# Which records count: the two statuses a human has settled on (CLEAN = nothing to review, ACCEPTED =
# HR said it is fine). PENDING_REVIEW is added only when HR ticks the box, REJECTED only when HR
# explicitly asks for it — a payroll file must never quietly contain a row nobody reviewed, and every
# row carries its Thai review status so the reader can see it.
EXPORT_KIND_MESSAGE_TH = "ชนิดไฟล์ที่ส่งออกต้องเป็น detail หรือ daily เท่านั้น"
EXPORT_RANGE_REQUIRED_MESSAGE_TH = "ต้องระบุช่วงวันที่สำหรับการส่งออก (date_from และ date_to)"
EXPORT_COUNTED_STATUSES = (logic.REVIEW_CLEAN, logic.REVIEW_ACCEPTED)
EXPORT_AUDIT_ACTION = "ATTENDANCE_EXPORT"


def _export_too_many_message() -> str:
    """Read the cap at call time so the message matches a cap lowered by a test or an operator."""
    return (
        f"รายการที่จะส่งออกเกิน {attendance_csv.EXPORT_MAX_ROWS:,} แถว "
        f"กรุณาลดช่วงวันที่หรือกรองให้แคบลง"
    )


def _daily_export_select(
    *,
    statuses: Iterable[str],
    date_from: date,
    date_to: date,
    employee_id: str | None = None,
    q: str | None = None,
    location_id: uuid.UUID | None = None,
    location_none: bool = False,
):
    """One row per employee per day, aggregated in the database (the file can be long).

    `จำนวนครั้งที่สาย` counts the time verdict LATE (the code `checkin_logic.time_status_for` sets) —
    the same thing the page shows in its time column, not the LATE flag.
    """
    conditions = _record_conditions(
        date_from=date_from,
        date_to=date_to,
        employee_id=employee_id,
        q=q,
        review_statuses=statuses,
        location_id=location_id,
        location_none=location_none,
    )
    return (
        select(
            AttendanceCheckin.employee_id,
            LocalUser.full_name,
            LocalUser.department,
            AttendanceCheckin.work_date,
            func.count(),
            func.min(AttendanceCheckin.checked_at),
            func.max(AttendanceCheckin.checked_at),
            func.count().filter(AttendanceCheckin.time_status == logic.LATE),
            func.count().filter(func.jsonb_array_length(AttendanceCheckin.flags) > 0),
            func.count().filter(AttendanceCheckin.review_status == logic.REVIEW_PENDING),
            func.count().filter(AttendanceCheckin.review_status == logic.REVIEW_REJECTED),
        )
        .outerjoin(LocalUser, LocalUser.employee_id == AttendanceCheckin.employee_id)
        .where(*conditions)
        .group_by(
            AttendanceCheckin.employee_id,
            LocalUser.full_name,
            LocalUser.department,
            AttendanceCheckin.work_date,
        )
        .order_by(AttendanceCheckin.work_date, AttendanceCheckin.employee_id)
    )


async def _csv_stream(
    db: AsyncSession,
    *,
    kind: str,
    statuses: list[str],
    date_from: date,
    date_to: date,
    employee_id: str | None,
    q: str | None,
    actor_id: str,
    include_pending: bool,
    include_rejected: bool,
    location_id: uuid.UUID | None = None,
    location_none: bool = False,
):
    """The response body, produced row by row.

    `db.stream()` is a server-side cursor, so rows arrive in batches and only one CSV chunk is ever held
    in memory. The `ATTENDANCE_EXPORT` audit row is written **after** the last chunk: an interrupted
    download (or a client that walks away) then writes nothing, which is the honest option — the
    "write it first with the expected count" variant could claim rows that were never delivered.
    """
    writer = attendance_csv.ChunkWriter()
    writer.write_row(attendance_csv.DAILY_HEADERS if kind == "daily" else attendance_csv.DETAIL_HEADERS)
    head = writer.flush()
    if head:
        yield attendance_csv.UTF8_BOM + head

    produced = 0
    if kind == "daily":
        result = await db.stream(_daily_export_select(
            statuses=statuses, date_from=date_from, date_to=date_to, employee_id=employee_id, q=q,
            location_id=location_id, location_none=location_none,
        ))
        async for aggregate in result:
            produced += 1
            chunk = writer.write_row(attendance_csv.daily_row(aggregate))
            if chunk:
                yield chunk
    else:
        rows_stmt, _ = _records_select(
            date_from=date_from, date_to=date_to, employee_id=employee_id, q=q, review_statuses=statuses,
            location_id=location_id, location_none=location_none,
        )
        result = await db.stream(rows_stmt.order_by(
            AttendanceCheckin.work_date,
            AttendanceCheckin.employee_id,
            AttendanceCheckin.checked_at,
            AttendanceCheckin.id,
        ))
        async for row, full_name, department in result:
            produced += 1
            chunk = writer.write_row(attendance_csv.detail_row(row, full_name, department))
            if chunk:
                yield chunk

    tail = writer.flush()
    if tail:
        yield tail

    db.add(AuditLog(
        action=EXPORT_AUDIT_ACTION,
        actor_id=actor_id,
        details=f"ส่งออกไฟล์ลงเวลาแบบ {kind} ช่วง {date_from}..{date_to}",
        metadata_json={
            "kind": kind,
            "date_from": date_from.isoformat(),
            "date_to": date_to.isoformat(),
            "rows": produced,
            "include_pending": include_pending,
            "include_rejected": include_rejected,
            # Which filters narrowed the file, never the values themselves (no employee id in an audit row).
            "filtered_by_employee": bool(employee_id),
            "filtered_by_search": bool(q),
            # Task 061: the location filter, recorded the same way — a boolean for "a location filter was on"
            # plus which one, so a file can be explained afterwards without guessing. The id is a location,
            # not a person, so it is safe to name (the search text and the employee id are not).
            "filtered_by_location": bool(location_id is not None or location_none),
            "location_id": LOCATION_FILTER_NONE if location_none else (str(location_id) if location_id else None),
        },
    ))
    # Committed here rather than left to the request's teardown: the audit row is the record of a
    # download that already happened by this point, so it must not depend on how the caller's session
    # is closed (a test's `get_db` override, for instance, never commits).
    await db.commit()


@router.get("/checkins/export")
async def export_checkins(
    kind: str = Query(..., max_length=16),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    include_pending: bool = Query(False),
    include_rejected: bool = Query(False),
    employee_id: str | None = Query(None),
    q: str | None = Query(None, max_length=120),
    location_id: str | None = Query(None, description="location UUID, or `none` for records that matched no location"),
    db: AsyncSession = Depends(get_db),
    current_user=Depends(require_permission(RECORDS_PERMISSION)),
):
    """Download the attendance records as CSV (`kind=detail`) or a per-employee daily summary.

    Registered **before** `/checkins/{checkin_id}` on purpose: FastAPI matches routes in registration
    order, and `export` is not a UUID. The file carries no coordinates, no photo key and no LINE user
    id — only what payroll needs. `date_from`/`date_to` are required, and both the 92-day cap and the
    from-≤-to rule are the ones the list already enforces. Task 061 added `location_id` so the file
    holds exactly the rows the filtered table shows.
    """
    if kind not in attendance_csv.EXPORT_KINDS:
        raise HTTPException(status_code=422, detail=EXPORT_KIND_MESSAGE_TH)
    if date_from is None or date_to is None:
        raise HTTPException(status_code=422, detail=EXPORT_RANGE_REQUIRED_MESSAGE_TH)
    _validate_range(date_from, date_to)
    parsed_location, location_none = _parse_location_filter(location_id)

    statuses = list(EXPORT_COUNTED_STATUSES)
    if include_pending:
        statuses.append(logic.REVIEW_PENDING)
    if include_rejected:
        statuses.append(logic.REVIEW_REJECTED)

    # Counted up front so an over-large file is refused with a Thai message *before* anything streams.
    # For `kind=daily` this is the detail-row count, which is an upper bound on the grouped rows.
    _, count_stmt = _records_select(
        date_from=date_from, date_to=date_to, employee_id=employee_id, q=q, review_statuses=statuses,
        location_id=parsed_location, location_none=location_none,
    )
    total = (await db.execute(count_stmt)).scalar() or 0
    if total > attendance_csv.EXPORT_MAX_ROWS:
        raise HTTPException(status_code=422, detail=_export_too_many_message())

    filename = attendance_csv.filename_for(kind, date_from, date_to)
    return StreamingResponse(
        _csv_stream(
            db,
            kind=kind,
            statuses=statuses,
            date_from=date_from,
            date_to=date_to,
            employee_id=employee_id,
            q=q,
            actor_id=current_user.employee_id,
            include_pending=include_pending,
            include_rejected=include_rejected,
            location_id=parsed_location,
            location_none=location_none,
        ),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            # A downloaded file is per-request data: never let a proxy or the browser keep it.
            "Cache-Control": "private, no-store",
        },
    )


@router.get("/checkins/locations")
async def checkin_locations(
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    db: AsyncSession = Depends(get_db),
    _current_user=Depends(require_permission(RECORDS_PERMISSION)),
):
    """The location choices for the records filter (task 061).

    Guarded by `attendance-records`, **not** `locations`: filling the filter only needs the right to read
    records. Registered before `/checkins/{checkin_id}` — `locations` is not a UUID, and FastAPI matches
    routes in registration order. The pairs come from the check-ins' own **snapshot** columns, so a location
    deleted from `attendance_locations` still shows up while records reference it, and an id that was renamed
    over time reports its **latest** snapshot name. `date_from`/`date_to` merely narrow which check-ins are
    inspected. An id whose stored name is NULL falls back to the id; the rows that matched no location become
    one entry carrying `LOCATION_UNSPECIFIED_TH` (`location_id: null`), listed last — the same grouping the
    056 dashboard uses.
    """
    _validate_range(date_from, date_to)
    conditions = []
    params: dict[str, Any] = {}
    if date_from is not None:
        conditions.append("work_date >= :date_from")
        params["date_from"] = date_from
    if date_to is not None:
        conditions.append("work_date <= :date_to")
        params["date_to"] = date_to
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    rows = (await db.execute(text(
        f"SELECT location_id, location_name FROM ("
        f"  SELECT DISTINCT ON (matched_location_id) matched_location_id AS location_id,"
        f"         matched_location_name AS location_name, checked_at"
        f"  FROM attendance_checkins {where}"
        f"  ORDER BY matched_location_id, checked_at DESC"
        f") AS latest ORDER BY location_name, location_id"
    ), params)).all()

    items: list[dict[str, Any]] = []
    unspecified: dict[str, Any] | None = None
    for location_id, location_name in rows:
        if location_id is None:
            unspecified = {"location_id": None, "location_name": LOCATION_UNSPECIFIED_TH}
        else:
            items.append({
                "location_id": str(location_id),
                "location_name": location_name or str(location_id),
            })
    if unspecified is not None:
        items.append(unspecified)
    return {"items": items}


# Every review status a flag entry reports, always present (zeros included) so the client never invents one.
FLAG_OUTCOME_STATUSES = (logic.REVIEW_CLEAN, logic.REVIEW_PENDING,
                         logic.REVIEW_ACCEPTED, logic.REVIEW_REJECTED)


@router.get("/checkins/flag-outcomes")
async def checkin_flag_outcomes(
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    location_id: str | None = Query(None, description="location UUID, or `none` for records that matched no location"),
    db: AsyncSession = Depends(get_db),
    _current_user=Depends(require_permission(RECORDS_PERMISSION)),
):
    """Flag × review-outcome counts for the HR report (task 061, round 1 item (c)).

    Aggregated entirely in PostgreSQL: `jsonb_array_elements_text` fans the flags out through a lateral join and
    no check-in row ever reaches Python (the habit the CSV export already follows). One row carrying two flags
    counts once in **each** of its flag entries, so the entries can add up to more than `flagged_checkins` — the
    page says so in words. `total_checkins` counts every row in range (unflagged included), `flagged_checkins`
    only the rows with at least one flag; `by_flag` is ordered by `total` desc then code, and each entry always
    carries all four review statuses. Range rules are the export's: Bangkok `work_date`, the default range is
    today, and the 92-day cap / inverted range are refused with the same Thai 422. Unflagged rows appear in no
    entry, and a flag code this build does not know is still reported under its own code.
    """
    _validate_range(date_from, date_to)
    parsed_location, location_none = _parse_location_filter(location_id)
    since, until = date_from, date_to
    if since is None and until is None:
        since = until = logic.bangkok_now().date()

    conditions = []
    params: dict[str, Any] = {}
    if since is not None:
        conditions.append("work_date >= :since")
        params["since"] = since
    if until is not None:
        conditions.append("work_date <= :until")
        params["until"] = until
    if location_none:
        conditions.append("matched_location_id IS NULL")
    elif parsed_location is not None:
        conditions.append("matched_location_id = :location_id")
        params["location_id"] = parsed_location
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    flagged_where = f"WHERE {' AND '.join([*conditions, 'jsonb_array_length(flags) > 0'])}"

    total = (await db.execute(text(f"SELECT count(*) FROM attendance_checkins {where}"), params)).scalar() or 0
    flagged = (await db.execute(
        text(f"SELECT count(*) FROM attendance_checkins {flagged_where}"), params)).scalar() or 0
    rows = (await db.execute(text(
        f"SELECT flag, review_status, count(*) FROM attendance_checkins "
        f"LEFT JOIN LATERAL jsonb_array_elements_text(flags) AS flag ON TRUE {where} "
        f"GROUP BY flag, review_status"
    ), params)).all()

    grouped: dict[str, dict[str, int]] = {}
    for flag, review_status, count in rows:
        if flag is None:                       # the `LEFT JOIN` row of an unflagged check-in
            continue
        entry = grouped.setdefault(flag, {status: 0 for status in FLAG_OUTCOME_STATUSES})
        entry[review_status] = entry.get(review_status, 0) + count

    by_flag = [
        {"flag": flag, "total": sum(counts.values()), "by_review_status": counts}
        for flag, counts in sorted(grouped.items(), key=lambda item: (-sum(item[1].values()), item[0]))
    ]
    return {
        "date_from": since.isoformat() if since else None,
        "date_to": until.isoformat() if until else None,
        "total_checkins": total,
        "flagged_checkins": flagged,
        "by_flag": by_flag,
    }


@router.get("/checkins/{checkin_id}")
async def get_checkin(
    checkin_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _current_user=Depends(require_permission(RECORDS_PERMISSION)),
):
    """One record with everything HR needs to judge it — plus the photo link, never the photo."""
    row, full_name, department = await _load_record(db, checkin_id)
    return _checkin_dict(row, full_name, department)


@router.patch("/checkins/{checkin_id}/review")
async def review_checkin(
    checkin_id: uuid.UUID,
    payload: dict = Body(...),
    db: AsyncSession = Depends(get_db),
    current_user=Depends(require_permission(RECORDS_PERMISSION)),
):
    """Accept or reject one flagged check-in.

    `ACCEPTED` means "this check-in is valid, the flag is explained"; `REJECTED` means "do not count
    it" and requires a reason. Only a flagged record can be reviewed — a `CLEAN` one has nothing to
    decide, and 409 says so. Re-reviewing (ACCEPTED ↔ REJECTED) is allowed and overwrites the reviewer
    fields; the audit log keeps the history. Nothing here touches the employee's own record or tells
    the employee anything.
    """
    status_value = payload.get("review_status")
    if not isinstance(status_value, str) or status_value.upper() not in REVIEW_STATUS_VALUES:
        raise HTTPException(status_code=422, detail=BAD_REVIEW_STATUS_MESSAGE_TH)
    new_status = status_value.upper()

    raw_note = payload.get("note")
    if raw_note is None:
        note = None
    elif isinstance(raw_note, str):
        note = raw_note.strip() or None
    else:
        raise HTTPException(status_code=422, detail=NOTE_REQUIRED_MESSAGE_TH)
    if note is not None and len(note) > REVIEW_NOTE_MAX:
        raise HTTPException(status_code=422, detail=NOTE_TOO_LONG_MESSAGE_TH)
    if new_status == "REJECTED" and note is None:
        raise HTTPException(status_code=422, detail=NOTE_REQUIRED_MESSAGE_TH)

    row, full_name, department = await _load_record(db, checkin_id)
    if row.review_status not in REVIEWABLE_STATUSES:
        raise HTTPException(status_code=409, detail=NOT_FLAGGED_MESSAGE_TH)

    previous = row.review_status
    row.review_status = new_status
    row.reviewed_by = current_user.employee_id
    row.reviewed_at = _now()
    # The note always overwrites: switching REJECTED → ACCEPTED clears the old reason rather than
    # leaving a rejection reason on an accepted record.
    row.review_note = note

    _write_audit(
        db,
        "ATTENDANCE_REVIEW",
        current_user.employee_id,
        # Thai (task 047 / 046 debt item 3). Only the note's **length** is ever written — the reason
        # an HR person typed never enters the audit trail. `verify022` pins this sentence.
        f"ตรวจสอบรายการลงเวลา {row.id} ของพนักงาน {row.employee_id}: {previous} -> {new_status} "
        f"(ความยาวหมายเหตุ {len(note) if note else 0})",
        ["id", "employee_id", "review_status", "reviewed_by", "reviewed_at", "review_note"],
    )
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    await db.refresh(row)

    return _checkin_dict(row, full_name, department)


@router.post("/checkins/review-bulk")
async def bulk_accept_checkins(
    payload: dict = Body(...),
    db: AsyncSession = Depends(get_db),
    current_user=Depends(require_permission(RECORDS_PERMISSION)),
):
    """Accept many flagged records in one transaction. Rejecting is deliberately not offered here —
    a rejection always carries its own reason, so it stays one record at a time.

    Ids that do not exist, and records that are not `PENDING_REVIEW`, are skipped and counted rather
    than failing the call. Everything else is one `ATTENDANCE_REVIEW` audit row with the count.
    """
    status_value = payload.get("review_status")
    if not isinstance(status_value, str) or status_value.upper() != "ACCEPTED":
        raise HTTPException(status_code=422, detail=BULK_STATUS_MESSAGE_TH)

    raw_ids = payload.get("ids")
    if not isinstance(raw_ids, list):
        raise HTTPException(status_code=422, detail=BULK_SIZE_MESSAGE_TH)
    try:
        ids = [uuid.UUID(str(value)) for value in raw_ids]
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(status_code=422, detail=BULK_SIZE_MESSAGE_TH) from None
    if not ids or len(ids) > BULK_REVIEW_MAX:
        raise HTTPException(status_code=422, detail=BULK_SIZE_MESSAGE_TH)

    updated = 0
    skipped = 0
    try:
        for checkin_id in dict.fromkeys(ids):  # de-duplicate, keep the order
            result = (await db.execute(
                select(AttendanceCheckin).where(AttendanceCheckin.id == checkin_id)
            )).scalar_one_or_none()
            if result is None or result.review_status != logic.REVIEW_PENDING:
                skipped += 1
                continue
            result.review_status = logic.REVIEW_ACCEPTED
            result.reviewed_by = current_user.employee_id
            result.reviewed_at = _now()
            updated += 1

        _write_audit(
            db,
            "ATTENDANCE_REVIEW",
            current_user.employee_id,
            # The third row with this action code — Thai too, or the Logs page would show two
            # languages for one action (task 047).
            f"ตรวจสอบรายการลงเวลาแบบกลุ่ม: ยอมรับ {updated} รายการ ข้าม {skipped} รายการ",
            ["id", "review_status", "reviewed_by", "reviewed_at"],
        )
        await db.commit()
    except Exception:
        # One transaction for the whole call: an injected failure must leave every row untouched.
        await db.rollback()
        raise

    return {"updated": updated, "skipped": skipped, "review_status": logic.REVIEW_ACCEPTED}


def _checkin_dict(row: AttendanceCheckin, full_name: str | None = None, department: str | None = None) -> dict:
    """One check-in as HR reads it: snapshots, statuses, flags, coordinates, review history and a
    photo link (never the photo itself)."""
    return {
        "id": str(row.id),
        "employee_id": row.employee_id,
        "full_name": full_name,
        "department": department,
        "work_date": row.work_date.isoformat(),
        "checked_at": row.checked_at.isoformat(),
        "round_id": str(row.round_id) if row.round_id else None,
        "template_name": row.template_name,
        "round_seq": row.round_seq,
        "round_label": row.round_label,
        "expected_time": row.expected_time.strftime("%H:%M") if row.expected_time else None,
        "window_start": row.window_start.strftime("%H:%M") if row.window_start else None,
        "window_end": row.window_end.strftime("%H:%M") if row.window_end else None,
        "grace_minutes": row.grace_minutes,
        "photo_required": row.photo_required,
        "time_status": row.time_status,
        "lat": float(row.lat) if row.lat is not None else None,
        "lng": float(row.lng) if row.lng is not None else None,
        "accuracy_m": float(row.accuracy_m) if row.accuracy_m is not None else None,
        "gps_status": row.gps_status,
        "matched_location_id": str(row.matched_location_id) if row.matched_location_id else None,
        "matched_location_name": row.matched_location_name,
        "distance_m": float(row.distance_m) if row.distance_m is not None else None,
        "location_status": row.location_status,
        "photo_key": row.photo_key,
        "photo_status": row.photo_status,
        "flags": list(row.flags or []),
        "review_status": row.review_status,
        "reviewed_by": row.reviewed_by,
        "reviewed_at": row.reviewed_at.isoformat() if row.reviewed_at else None,
        "review_note": row.review_note,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "photo_url": f"/api/v1/attendance/photos/{row.photo_key}" if row.photo_key else None,
    }
