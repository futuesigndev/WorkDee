"""Company news — the HR side (task 036).

Two tables (`news_categories`, `news_items`), the admin API behind the `news` menu permission, and
the page under `dashboard/operation/news`. **Nothing here is employee-facing yet**: there is no
`/news/me/*` route, no `/liff/news` page and no LINE call of any kind — task 037 adds the employee
side and turns the hub card live.

Design notes worth keeping in mind while reading:

* **Categories are deactivated, never deleted.** That is why there is no delete route: older news
  always keeps a valid reference, and the "seed only when the table is empty" rule can never
  resurrect a row HR removed.
* **`body` is plain text and stays plain text.** This API stores exactly what HR typed (trimmed at
  both ends, `\\r\\n` normalised to `\\n`, internal line breaks kept) and never renders, sanitises,
  escapes or auto-links it. Task 037 decides how it is displayed.
* **Audit rows never carry content.** Each write leaves one row with the action, the actor, the
  entity id, the changed field NAMES and (when the body was written) the body LENGTH — never the
  title text and never the body, the same discipline the 022 review note follows.
* **Character limits count characters, not bytes** (Python `len()` on `str` = code points, so a Thai
  combining mark counts as its own character). The page counts the same way (`Array.from(text)`).
"""

from __future__ import annotations

import unicodedata
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, ValidationInfo, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user_id, require_permission
from app.line_identity import (
    LineIdentity,
    get_bound_employee,
    get_verified_line_identity,
)
from app.models import AuditLog, NewsCategory, NewsItem

router = APIRouter(prefix="/news", tags=["news"])

# The menu key every route below is guarded by (seeded in `seeds.py`, granted to Admin there).
NEWS_PERMISSION = "news"

STATUS_DRAFT = "DRAFT"
STATUS_PUBLISHED = "PUBLISHED"
STATUS_WITHDRAWN = "WITHDRAWN"

CATEGORY_NAME_MAX = 50
TITLE_MAX = 150
BODY_MAX = 5000
SORT_ORDER_DEFAULT = 100
PAGE_SIZE_MAX = 50

# Audit actions. `NEWS_*` for items, `NEWS_CATEGORY_*` for categories (task 036).
AUDIT_CATEGORY_CREATED = "NEWS_CATEGORY_CREATED"
AUDIT_CATEGORY_UPDATED = "NEWS_CATEGORY_UPDATED"
AUDIT_NEWS_CREATED = "NEWS_CREATED"
AUDIT_NEWS_UPDATED = "NEWS_UPDATED"
AUDIT_NEWS_PUBLISHED = "NEWS_PUBLISHED"
AUDIT_NEWS_WITHDRAWN = "NEWS_WITHDRAWN"
AUDIT_NEWS_DELETED = "NEWS_DELETED"

# Thai sentences HR reads as-is. Field NAMES never change — only these sentences do.
CATEGORY_NOT_FOUND_TH = "ไม่พบประเภทข่าว"
NEWS_NOT_FOUND_TH = "ไม่พบข่าว"
CATEGORY_NAME_TAKEN_TH = "มีชื่อประเภทข่าวนี้อยู่แล้ว"
CATEGORY_INACTIVE_TH = "ประเภทข่าวนี้ถูกปิดใช้งาน กรุณาเลือกประเภทข่าวที่ใช้งานอยู่"
WITHDRAW_DRAFT_TH = "ข่าวที่เป็นฉบับร่างยังถอนไม่ได้ กรุณาลบฉบับร่างแทน"
DELETE_NOT_DRAFT_TH = "ลบได้เฉพาะฉบับร่าง — ข่าวที่เผยแพร่แล้วให้ใช้การถอนข่าว"

# ─── Employee side (task 039) ─────────────────────────────────────────────────
# The LIFF page reads only these two routes. Identity is a verified LINE ID token plus an APPROVED
# binding — the same dependency the attendance `/me/*` routes use — so the audience is exactly "every
# employee with an approved binding", and an unbound/pending/rejected/revoked account is refused with
# the identical Thai sentence the other employee routes give.
#
# Reads are **not** audited (the `attendance/me/history` convention: a read writes nothing). A response
# carries no author, no status, no binding and no audit data — an employee may learn that a news item
# is published, and nothing else. A draft, a withdrawn item, an unknown id and a malformed id all
# answer the *same* 404, so a withdrawn item cannot be distinguished from one that never existed.
NEWS_ME_PAGE_SIZE = 20
NEWS_ME_PREVIEW_CHARS = 120
NEWS_ME_NOT_FOUND_TH = "ข่าวนี้ไม่มีให้อ่านแล้ว"
CURSOR_PAIR_TH = "ตัวบอกตำแหน่งของรายการถัดไปไม่ครบ (ต้องส่ง before และ before_id มาคู่กัน)"
CURSOR_TIMEZONE_TH = "เวลาของตัวบอกตำแหน่งต้องระบุเขตเวลา (เช่น 2026-09-30T07:00:00+00:00)"

# Field names → the Thai words the pages use, for messages built here.
CATEGORY_FIELD_LABELS = {"name": "ชื่อประเภทข่าว", "sort_order": "ลำดับ", "is_active": "สถานะใช้งาน"}
ITEM_FIELD_LABELS = {"title": "หัวข้อข่าว", "body": "เนื้อข่าว", "category_id": "ประเภทข่าว"}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _write_audit(
    db: AsyncSession,
    action: str,
    actor_id: str,
    entity_id: uuid.UUID,
    fields: list[str],
    details: str,
    body_length: int | None = None,
) -> None:
    """One audit row per write: entity id + changed field NAMES (+ body length) — never content."""
    metadata: dict[str, Any] = {"entity_id": str(entity_id), "fields": sorted(set(fields))}
    if body_length is not None:
        metadata["body_length"] = body_length
    db.add(AuditLog(action=action, actor_id=actor_id, details=details, metadata_json=metadata))


def _like_pattern(value: str) -> str:
    """A `%…%` pattern with the caller's wildcards escaped, so `%` in a search is just a character."""
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _collapse_spaces(value: str) -> str:
    """Trim and collapse every whitespace run to one space, so " ด่วน  " and "ด่วน" are one name."""
    return " ".join(value.split())


def _category_news_count():
    """How many news items (any status) point at a category — a read-only counter for the list."""
    return (
        select(func.count(NewsItem.id))
        .where(NewsItem.category_id == NewsCategory.id)
        .correlate(NewsCategory)
        .scalar_subquery()
    )


def _category_dict(row: NewsCategory, news_count: int | None = None) -> dict:
    data = {
        "id": str(row.id),
        "name": row.name,
        "sort_order": row.sort_order,
        "is_active": row.is_active,
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
        "created_by": row.created_by,
        "updated_by": row.updated_by,
    }
    if news_count is not None:
        data["news_count"] = news_count
    return data


def _item_dict(row: NewsItem, category_name: str, *, with_body: bool) -> dict:
    data = {
        "id": str(row.id),
        "title": row.title,
        "category_id": str(row.category_id),
        "category_name": category_name,
        "status": row.status,
        "published_at": _iso(row.published_at),
        "withdrawn_at": _iso(row.withdrawn_at),
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
        "created_by": row.created_by,
        "updated_by": row.updated_by,
    }
    if with_body:
        data["body"] = row.body
    return data


async def _load_category(db: AsyncSession, category_id: uuid.UUID) -> NewsCategory:
    row = (
        await db.execute(select(NewsCategory).where(NewsCategory.id == category_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=CATEGORY_NOT_FOUND_TH)
    return row


async def _load_item(db: AsyncSession, news_id: uuid.UUID) -> NewsItem:
    row = (await db.execute(select(NewsItem).where(NewsItem.id == news_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=NEWS_NOT_FOUND_TH)
    return row


async def _category_name(db: AsyncSession, category_id: uuid.UUID) -> str:
    name = (
        await db.execute(select(NewsCategory.name).where(NewsCategory.id == category_id))
    ).scalar_one_or_none()
    return name or ""


async def _detail(db: AsyncSession, row: NewsItem) -> dict:
    return _item_dict(row, await _category_name(db, row.category_id), with_body=True)


async def _assert_name_free(db: AsyncSession, name: str, exclude_id: uuid.UUID | None = None) -> None:
    """Case-insensitive duplicate check — the DB unique constraint only catches exact matches."""
    stmt = select(NewsCategory.id).where(func.lower(NewsCategory.name) == name.lower())
    if exclude_id is not None:
        stmt = stmt.where(NewsCategory.id != exclude_id)
    if (await db.execute(stmt.limit(1))).scalar_one_or_none():
        raise HTTPException(status_code=409, detail=CATEGORY_NAME_TAKEN_TH)


async def _assert_category_active(db: AsyncSession, category_id: uuid.UUID) -> NewsCategory:
    """A category may only be *chosen* while it is active (an unchanged one stays valid)."""
    row = await _load_category(db, category_id)
    if not row.is_active:
        raise HTTPException(status_code=409, detail=CATEGORY_INACTIVE_TH)
    return row


# ─── Validators + request schemas ─────────────────────────────────────────────

def _clean_name(value: Any, info: ValidationInfo) -> Any:
    """Category name: trimmed, inner whitespace collapsed, never blank."""
    if value is None:
        raise ValueError("กรุณากรอกชื่อประเภทข่าว")
    if not isinstance(value, str):
        return value
    cleaned = _collapse_spaces(value)
    if cleaned == "":
        raise ValueError("กรุณากรอกชื่อประเภทข่าว")
    return cleaned


def _clean_title(value: Any, info: ValidationInfo) -> Any:
    """News title: trimmed, `\\r\\n` normalised, never blank (a blank one fails `min_length`)."""
    if value is None:
        raise ValueError("กรุณากรอกหัวข้อข่าว")
    if not isinstance(value, str):
        return value
    return value.replace("\r\n", "\n").replace("\r", "\n").strip()


def _clean_body(value: Any, info: ValidationInfo) -> Any:
    """Plain-text body: trimmed at both ends, `\\r\\n`/`\\r` normalised to `\\n`, inner breaks kept.

    Nothing else happens to it — no escaping, no HTML handling, no link detection. Length is then
    checked by the field constraint against this normalised text.
    """
    if value is None:
        raise ValueError("กรุณากรอกเนื้อข่าว")
    if not isinstance(value, str):
        return value
    return value.replace("\r\n", "\n").replace("\r", "\n").strip()


class CategoryCreate(BaseModel):
    name: str = Field(..., max_length=CATEGORY_NAME_MAX)
    sort_order: int = Field(SORT_ORDER_DEFAULT, ge=0, le=99999)
    is_active: bool = True

    _normalise_name = field_validator("name", mode="before")(_clean_name)


class CategoryUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=CATEGORY_NAME_MAX)
    sort_order: Optional[int] = Field(None, ge=0, le=99999)
    is_active: Optional[bool] = None

    _normalise_name = field_validator("name", mode="before")(_clean_name)


class NewsCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=TITLE_MAX)
    body: str = Field(..., min_length=1, max_length=BODY_MAX)
    category_id: uuid.UUID

    _normalise_title = field_validator("title", mode="before")(_clean_title)
    _normalise_body = field_validator("body", mode="before")(_clean_body)


class NewsUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=TITLE_MAX)
    body: Optional[str] = Field(None, min_length=1, max_length=BODY_MAX)
    category_id: Optional[uuid.UUID] = None

    _normalise_title = field_validator("title", mode="before")(_clean_title)
    _normalise_body = field_validator("body", mode="before")(_clean_body)


# ─── Categories ───────────────────────────────────────────────────────────────

@router.get("/categories")
async def list_categories(
    db: AsyncSession = Depends(get_db),
    _actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission(NEWS_PERMISSION)),
):
    """Every category, ordered for display, each with the number of news items using it.

    No paging: HR manages a handful of categories, and the page shows them all in one table.
    """
    rows = (
        await db.execute(
            select(NewsCategory, _category_news_count().label("news_count"))
            .order_by(NewsCategory.sort_order.asc(), NewsCategory.name.asc())
        )
    ).all()
    return {"items": [_category_dict(row, count) for row, count in rows]}


@router.post("/categories", status_code=201)
async def create_category(
    payload: CategoryCreate,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission(NEWS_PERMISSION)),
):
    await _assert_name_free(db, payload.name)
    row = NewsCategory(**payload.model_dump(), created_by=actor_id, updated_by=actor_id)
    db.add(row)
    _write_audit(
        db,
        AUDIT_CATEGORY_CREATED,
        actor_id,
        row.id,
        list(payload.model_dump().keys()),
        "Created news category",
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail=CATEGORY_NAME_TAKEN_TH)
    await db.refresh(row)
    return _category_dict(row, 0)


@router.patch("/categories/{category_id}")
async def update_category(
    category_id: uuid.UUID,
    payload: CategoryUpdate,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission(NEWS_PERMISSION)),
):
    """Partial update: rename, change the order, activate/deactivate.

    An empty body is a no-op (200, no audit row, `updated_at` untouched). Deactivating a category
    that news already uses is allowed on purpose — those items keep it and keep showing it.
    """
    row = await _load_category(db, category_id)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        # A no-op still answers with the row + its usage count, exactly like a real update does.
        count = (
            await db.execute(select(func.count(NewsItem.id)).where(NewsItem.category_id == row.id))
        ).scalar() or 0
        return _category_dict(row, count)

    if "name" in changes and changes["name"] != row.name:
        await _assert_name_free(db, changes["name"], exclude_id=row.id)

    moment = _now()
    for field, value in changes.items():
        setattr(row, field, value)
    row.updated_by = actor_id
    row.updated_at = moment
    _write_audit(db, AUDIT_CATEGORY_UPDATED, actor_id, row.id, list(changes.keys()), "Updated news category")
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail=CATEGORY_NAME_TAKEN_TH)
    await db.refresh(row)
    count = (
        await db.execute(select(func.count(NewsItem.id)).where(NewsItem.category_id == row.id))
    ).scalar() or 0
    return _category_dict(row, count)


# ─── Employee side: the LIFF page reads these (task 039) ──────────────────────
#
# They are deliberately registered **before** the admin `/{news_id}` routes below: Starlette matches
# routes in registration order, so `/news/me` must claim its path before `/news/{news_id}` can try to
# read "me" as a uuid (which would answer 422 from the admin route instead of 200/401 here).

def _is_joiner(char: str) -> bool:
    """Whether `char` attaches to the character in front of it and must not start a preview.

    Covers the three ways a "single visible character" is really several code points here: a Thai
    combining mark (or any combining category), a zero-width joiner / variation selector (emoji
    sequences), an emoji skin-tone modifier and a regional indicator (the second half of a flag).
    """
    return (
        unicodedata.combining(char) != 0
        or unicodedata.category(char) in ("Mn", "Mc", "Me")
        or char in ("\u200d", "\ufe0e", "\ufe0f")
        or 0x1F3FB <= ord(char) <= 0x1F3FF
        or 0x1F1E6 <= ord(char) <= 0x1F1FF
    )


def _preview(body: str, limit: int = NEWS_ME_PREVIEW_CHARS) -> str:
    """A one-paragraph preview of a news body, cut on a character boundary.

    Whitespace runs collapse to single spaces (a card shows one paragraph; the full body with its line
    breaks is what the detail view is for). The cut counts **code points**, exactly like the 150/5000
    limits do, and it moves forward over any code point that would otherwise be split from the one
    before it and back off a trailing zero-width joiner / variation selector — so a preview can never
    end with half an emoji, a bare Thai tone mark or a dangling joiner. `…` marks a real cut.
    """
    text = " ".join(body.split())
    if len(text) <= limit:
        return text

    chars = list(text)
    cut = limit
    while cut < len(chars) and _is_joiner(chars[cut]):
        cut += 1
    while cut > 0 and chars[cut - 1] in ("\u200d", "\ufe0e", "\ufe0f"):
        cut -= 1
    return text[:cut].rstrip() + "…"


def _me_item_dict(row: NewsItem, category_name: str) -> dict:
    """One row of the employee list: six keys, no body, no author, no status (task 039)."""
    return {
        "id": str(row.id),
        "title": row.title,
        "category": category_name,
        "published_at": _iso(row.published_at),
        "preview": _preview(row.body),
    }


async def _published_categories(db: AsyncSession) -> list[dict]:
    """The categories that still have at least one published item, in `sort_order` (task 039).

    One query with an `EXISTS` subquery: no duplicates, no counting, and it needs nothing from
    `news_categories.is_active` — HR deactivating a category hides it from the HR picker, but news that
    was already published under it keeps showing (and keeps its filter chip while any such item exists).
    """
    has_published = (
        select(NewsItem.id)
        .where(NewsItem.category_id == NewsCategory.id, NewsItem.status == STATUS_PUBLISHED)
        .exists()
    )
    rows = (await db.execute(
        select(NewsCategory.id, NewsCategory.name)
        .where(has_published)
        .order_by(NewsCategory.sort_order.asc(), NewsCategory.name.asc())
    )).all()
    return [{"id": str(row[0]), "name": row[1]} for row in rows]


@router.get("/me")
async def list_my_news(
    category_id: uuid.UUID | None = Query(None, description="กรองตามประเภทข่าว (ไม่ส่ง = ทุกประเภท)"),
    before: datetime | None = Query(None, description="published_at ของรายการสุดท้ายที่เห็นแล้ว"),
    before_id: uuid.UUID | None = Query(None, description="id ของรายการสุดท้ายที่เห็นแล้ว"),
    db: AsyncSession = Depends(get_db),
    identity: LineIdentity = Depends(get_verified_line_identity),
):
    """Published news, newest first, for the LIFF page (task 039).

    Newest first means `published_at` descending with `id` as the tie-break, and the cursor walks the
    same pair — so an item published between page 1 and page 2 can neither repeat an item already
    shown nor skip one (`page` numbers would do both). A malformed cursor is a Thai 422, never a 500
    and never "start from the top and dump everything".

    The list carries a preview only: the full body belongs to the detail route, which is also what
    makes "one item is withdrawn while the employee is reading the list" harmless.
    """
    await get_bound_employee(identity, db)  # the APPROVED-binding gate only; news is not personal

    if (before is None) != (before_id is None):
        raise HTTPException(status_code=422, detail=CURSOR_PAIR_TH)
    if before is not None and before.tzinfo is None:
        raise HTTPException(status_code=422, detail=CURSOR_TIMEZONE_TH)

    stmt = (
        select(NewsItem, NewsCategory.name)
        .join(NewsCategory, NewsItem.category_id == NewsCategory.id)
        .where(NewsItem.status == STATUS_PUBLISHED)
    )
    if category_id is not None:
        stmt = stmt.where(NewsItem.category_id == category_id)
    if before is not None and before_id is not None:
        stmt = stmt.where(
            (NewsItem.published_at < before)
            | ((NewsItem.published_at == before) & (NewsItem.id < before_id))
        )

    # `+ 1` row answers "is there another page" without a COUNT over the whole table.
    rows = (await db.execute(
        stmt.order_by(NewsItem.published_at.desc(), NewsItem.id.desc()).limit(NEWS_ME_PAGE_SIZE + 1)
    )).all()
    page, extra = rows[:NEWS_ME_PAGE_SIZE], rows[NEWS_ME_PAGE_SIZE:]

    cursor = None
    if extra and page:
        last = page[-1][0]
        cursor = {"before": _iso(last.published_at), "before_id": str(last.id)}

    return {
        "items": [_me_item_dict(row, category_name) for row, category_name in page],
        "categories": await _published_categories(db),
        "next": cursor,
        "page_size": NEWS_ME_PAGE_SIZE,
    }


@router.get("/me/{news_id}")
async def get_my_news(
    news_id: str,
    db: AsyncSession = Depends(get_db),
    identity: LineIdentity = Depends(get_verified_line_identity),
):
    """One published news item with its full body (task 039).

    The path parameter is a **string**, not a uuid: a malformed id must answer the same 404 as an
    unknown one, and letting FastAPI's type validation reject it would answer 422 instead — which is
    itself a hint that the id's *shape* was the problem. A draft and a withdrawn item answer it too.
    """
    await get_bound_employee(identity, db)
    try:
        parsed = uuid.UUID(news_id)
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(status_code=404, detail=NEWS_ME_NOT_FOUND_TH) from None

    row = (await db.execute(
        select(NewsItem, NewsCategory.name)
        .join(NewsCategory, NewsItem.category_id == NewsCategory.id)
        .where(NewsItem.id == parsed, NewsItem.status == STATUS_PUBLISHED)
    )).first()
    if row is None:
        raise HTTPException(status_code=404, detail=NEWS_ME_NOT_FOUND_TH)

    item, category_name = row
    # The body goes out exactly as stored — plain text with `\n` line breaks. No HTML, no escaping, no
    # link detection: the page renders it as text, so a `<script>` in a body is just those characters.
    return {**_me_item_dict(item, category_name), "body": item.body}


# ─── News items ───────────────────────────────────────────────────────────────

@router.get("")
async def list_news(
    status: str | None = Query(None),
    category_id: uuid.UUID | None = Query(None),
    q: str | None = Query(None, max_length=150),
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=PAGE_SIZE_MAX),
    db: AsyncSession = Depends(get_db),
    _actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission(NEWS_PERMISSION)),
):
    """News for the HR table: newest first (published date if there is one, else created date).

    A row carries **no body** — the table only needs enough to pick a row; the dialog fetches the
    full item from `GET /news/{id}`. An unknown `status` value simply matches nothing, the same
    convention the attendance records filters follow.
    """
    stmt = select(NewsItem, NewsCategory.name).join(NewsCategory, NewsItem.category_id == NewsCategory.id)
    if status:
        stmt = stmt.where(NewsItem.status == status)
    if category_id is not None:
        stmt = stmt.where(NewsItem.category_id == category_id)
    if q and q.strip():
        stmt = stmt.where(NewsItem.title.ilike(_like_pattern(q.strip())))

    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar() or 0
    rows = (
        await db.execute(
            stmt.order_by(
                func.coalesce(NewsItem.published_at, NewsItem.created_at).desc(),
                NewsItem.id.desc(),
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()
    return {
        "items": [_item_dict(row, category_name, with_body=False) for row, category_name in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.post("", status_code=201)
async def create_news(
    payload: NewsCreate,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission(NEWS_PERMISSION)),
):
    """Creates a **DRAFT**. Publishing is a separate, deliberate step (`/publish`)."""
    await _assert_category_active(db, payload.category_id)
    row = NewsItem(
        title=payload.title,
        body=payload.body,
        category_id=payload.category_id,
        status=STATUS_DRAFT,
        created_by=actor_id,
        updated_by=actor_id,
    )
    db.add(row)
    _write_audit(
        db,
        AUDIT_NEWS_CREATED,
        actor_id,
        row.id,
        list(payload.model_dump().keys()),
        "Created news item",
        body_length=len(payload.body),
    )
    await db.commit()
    await db.refresh(row)
    return await _detail(db, row)


@router.get("/{news_id}")
async def get_news(
    news_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission(NEWS_PERMISSION)),
):
    return await _detail(db, await _load_item(db, news_id))


@router.patch("/{news_id}")
async def update_news(
    news_id: uuid.UUID,
    payload: NewsUpdate,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission(NEWS_PERMISSION)),
):
    """Edit title/body/category **in any status** — fixing a typo on published news is deliberate.

    A category may only be *changed* to an active one; leaving an item on a category that has since
    been deactivated stays valid. An empty body is a no-op (200, no audit row).
    """
    row = await _load_item(db, news_id)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        return await _detail(db, row)

    if "category_id" in changes and changes["category_id"] != row.category_id:
        await _assert_category_active(db, changes["category_id"])

    moment = _now()
    for field, value in changes.items():
        setattr(row, field, value)
    row.updated_by = actor_id
    row.updated_at = moment
    _write_audit(
        db,
        AUDIT_NEWS_UPDATED,
        actor_id,
        row.id,
        list(changes.keys()),
        "Updated news item",
        body_length=len(row.body),
    )
    await db.commit()
    await db.refresh(row)
    return await _detail(db, row)


@router.post("/{news_id}/publish")
async def publish_news(
    news_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission(NEWS_PERMISSION)),
):
    """DRAFT or WITHDRAWN -> PUBLISHED, stamping `published_at`.

    Publishing an already-published item is a **no-op success**: no error, no timestamp change and no
    audit row (nothing happened). The category has to be active *now* — it may have been deactivated
    after the item was written. A previously withdrawn item keeps its old `withdrawn_at` as history.
    """
    row = await _load_item(db, news_id)
    if row.status == STATUS_PUBLISHED:
        return await _detail(db, row)

    await _assert_category_active(db, row.category_id)
    moment = _now()
    row.status = STATUS_PUBLISHED
    row.published_at = moment
    row.updated_by = actor_id
    row.updated_at = moment
    _write_audit(
        db, AUDIT_NEWS_PUBLISHED, actor_id, row.id, ["status", "published_at"], "Published news item"
    )
    await db.commit()
    await db.refresh(row)
    return await _detail(db, row)


@router.post("/{news_id}/withdraw")
async def withdraw_news(
    news_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission(NEWS_PERMISSION)),
):
    """PUBLISHED -> WITHDRAWN, stamping `withdrawn_at`. Idempotent on an already-withdrawn item.

    A DRAFT was never published, so it cannot be withdrawn — 409 in Thai telling HR to delete it.
    """
    row = await _load_item(db, news_id)
    if row.status == STATUS_WITHDRAWN:
        return await _detail(db, row)
    if row.status != STATUS_PUBLISHED:
        raise HTTPException(status_code=409, detail=WITHDRAW_DRAFT_TH)

    moment = _now()
    row.status = STATUS_WITHDRAWN
    row.withdrawn_at = moment
    row.updated_by = actor_id
    row.updated_at = moment
    _write_audit(
        db, AUDIT_NEWS_WITHDRAWN, actor_id, row.id, ["status", "withdrawn_at"], "Withdrew news item"
    )
    await db.commit()
    await db.refresh(row)
    return await _detail(db, row)


@router.delete("/{news_id}")
async def delete_news(
    news_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission(NEWS_PERMISSION)),
):
    """Hard-delete a **DRAFT only** — anything published is withdrawn instead, never erased."""
    row = await _load_item(db, news_id)
    if row.status != STATUS_DRAFT:
        raise HTTPException(status_code=409, detail=DELETE_NOT_DRAFT_TH)

    _write_audit(db, AUDIT_NEWS_DELETED, actor_id, row.id, ["status"], "Deleted news draft")
    await db.delete(row)
    await db.commit()
    return {"deleted": True, "id": str(news_id)}
