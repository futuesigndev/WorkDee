import uuid
from datetime import date, datetime, time, timezone
from decimal import Decimal
from sqlalchemy import String, Boolean, Date, DateTime, Text, Time, Integer, Numeric, ForeignKey, JSON, Index
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base

class AppSettings(Base):
    __tablename__ = "app_settings"
    
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    app_name: Mapped[str] = mapped_column(String, default="WorkDee")
    app_logo_url: Mapped[str | None] = mapped_column(String, nullable=True)
    branding_text: Mapped[str] = mapped_column(String, default="Empowering Digital Enterprise")
    sub_text: Mapped[str] = mapped_column(String, default="Experience the next generation of multi-application management with our secure, unified platform.")
    theme: Mapped[str] = mapped_column(String, default="minimalist-slate")
    dark_mode: Mapped[str] = mapped_column(String, default="system")
    timezone_display: Mapped[str] = mapped_column(String, default="Asia/Bangkok")
    updated_by: Mapped[str | None] = mapped_column(String, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # LINE OA settings (Configurable via admin panel, falls back to env vars if null)
    line_channel_access_token: Mapped[str | None] = mapped_column(String, nullable=True)
    line_channel_secret: Mapped[str | None] = mapped_column(String, nullable=True)
    line_liff_id: Mapped[str | None] = mapped_column(String, nullable=True)
    line_basic_id: Mapped[str | None] = mapped_column(String, nullable=True)

class LocalRole(Base):
    __tablename__ = "local_roles"
    
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, unique=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_system_role: Mapped[bool] = mapped_column(Boolean, default=False)

class LocalUser(Base):
    __tablename__ = "local_users"
    
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    employee_id: Mapped[str] = mapped_column(String, unique=True)
    full_name: Mapped[str] = mapped_column(String)
    department: Mapped[str] = mapped_column(String)
    division: Mapped[str] = mapped_column(String)
    company: Mapped[str] = mapped_column(String)
    role_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("local_roles.id"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    deprovisioned_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class LocalMenu(Base):
    __tablename__ = "local_menus"
    
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    key: Mapped[str] = mapped_column(String, unique=True)
    label: Mapped[str] = mapped_column(String)
    path: Mapped[str] = mapped_column(String)
    icon: Mapped[str | None] = mapped_column(String, nullable=True)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("local_menus.id"), nullable=True)
    order: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

class RoleMenuPermission(Base):
    __tablename__ = "role_menu_permissions"
    
    role_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("local_roles.id"), primary_key=True)
    menu_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("local_menus.id"), primary_key=True)
    can_access: Mapped[bool] = mapped_column(Boolean, default=True)

class LineBinding(Base):
    __tablename__ = "line_bindings"
    
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    line_user_id: Mapped[str] = mapped_column(String)
    employee_id: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="PENDING") # PENDING, APPROVED, REJECTED, REVOKED
    approved_by: Mapped[str | None] = mapped_column(String, nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    revoke_reason: Mapped[str | None] = mapped_column(String, nullable=True)

class AuditLog(Base):
    __tablename__ = "audit_logs"
    
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    action: Mapped[str] = mapped_column(String) # e.g., "AUTH_LOGIN_SUCCESS"
    details: Mapped[str | None] = mapped_column(String, nullable=True)
    actor_id: Mapped[str] = mapped_column(String) # employee_id
    ip_address: Mapped[str | None] = mapped_column(String, nullable=True)
    metadata_json: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ─── Attendance master data (task 014) ────────────────────────────────────────
# Unlike the tables above, these timestamps are timezone-aware (timestamptz) on purpose: the
# project template spec requires TIMESTAMPTZ and forbids the naive `utcnow()` pattern, and an
# attendance feature is exactly where a wrong offset would hurt. The older tables are left as
# they are (task 014 must not change existing behaviour).

def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class AttendanceLocation(Base):
    """A place where employees may check in later (Location Master).

    `latitude`/`longitude` are numeric(9, 6) — 6 decimal places, which is ~0.1 m at the equator
    and enough precision for a check-in radius. `radius_meters` is validated in the API (10..1000);
    the DB only enforces NOT NULL and the default.
    """

    __tablename__ = "attendance_locations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    address: Mapped[str | None] = mapped_column(String(300), nullable=True)
    latitude: Mapped[Decimal] = mapped_column(Numeric(9, 6))
    longitude: Mapped[Decimal] = mapped_column(Numeric(9, 6))
    radius_meters: Mapped[int] = mapped_column(Integer, default=150)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utc_now, onupdate=_utc_now)
    updated_by: Mapped[str | None] = mapped_column(String, nullable=True)


class AttendanceTemplate(Base):
    """A reusable set of attendance rounds for one calendar day (Attendance Policy Template).

    A template owns an ordered list of `AttendanceTemplateRound` rows; deleting a template deletes
    its rounds (never done by task 014 — deactivate with `is_active` instead). A round counts as
    late after `expected_time + grace_minutes`; that rule is only documented here, nothing computes
    it yet.
    """

    __tablename__ = "attendance_templates"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    description: Mapped[str | None] = mapped_column(String(300), nullable=True)
    grace_minutes: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utc_now, onupdate=_utc_now)
    updated_by: Mapped[str | None] = mapped_column(String, nullable=True)

    rounds: Mapped[list["AttendanceTemplateRound"]] = relationship(
        back_populates="template",
        cascade="all, delete-orphan",
        order_by="AttendanceTemplateRound.seq",
    )


class AttendanceTemplateRound(Base):
    """One check-in/check-out round inside a template.

    `window_start`, `expected_time` and `window_end` are **wall-clock times in Asia/Bangkok** —
    task 014 stores them as `time without time zone` and performs no conversion. Samples may
    reuse a date part in a later task; today they are only compared with each other.
    """

    __tablename__ = "attendance_template_rounds"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    template_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("attendance_templates.id", ondelete="CASCADE")
    )
    seq: Mapped[int] = mapped_column(Integer)
    label: Mapped[str] = mapped_column(String(80))
    window_start: Mapped[time] = mapped_column(Time)
    expected_time: Mapped[time] = mapped_column(Time)
    window_end: Mapped[time] = mapped_column(Time)
    photo_required: Mapped[bool] = mapped_column(Boolean, default=True)

    template: Mapped["AttendanceTemplate"] = relationship(back_populates="rounds")


class EmployeeWorkProfile(Base):
    """Which template/location an employee uses, and whether they work from home (task 016).

    One row per employee at most (`employee_id` is unique, and the foreign key cascades so the row
    disappears with a hard-deleted `local_users` row).

    A row is **optional**: an active employee with no row counts as "unassigned". Unassigning never
    deletes the row — the columns are set to NULL/false — so `updated_at` / `updated_by` keep saying
    who last touched it. `template_id`, `location_id` and `wfh_location_id` use ON DELETE RESTRICT:
    master data that is still referenced cannot be hard-deleted by accident (task 016 has no delete
    route anyway — deactivate with `is_active` instead).

    `wfh_location_id` is the "home point" used when `wfh_mode` is true; it is an ordinary
    `attendance_locations` row that HR creates for that person (name kept from
    `docs/02-phase0-entities.md`). Timestamps are timestamptz, like the other 014/016 tables.
    """

    __tablename__ = "employee_work_profiles"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    employee_id: Mapped[str] = mapped_column(
        String, ForeignKey("local_users.employee_id", ondelete="CASCADE"), unique=True
    )
    template_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("attendance_templates.id", ondelete="RESTRICT"), nullable=True
    )
    location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("attendance_locations.id", ondelete="RESTRICT"), nullable=True
    )
    wfh_mode: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    wfh_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("attendance_locations.id", ondelete="RESTRICT"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utc_now, onupdate=_utc_now)
    updated_by: Mapped[str | None] = mapped_column(String, nullable=True)


# ─── Check-in records (task 021) ──────────────────────────────────────────────

class AttendanceCheckin(Base):
    """One recorded check-in — evidence of when an employee arrived, and how it looked.

    Philosophy (task 021): a check-in that breaks a rule is **recorded with flags**, never dropped and
    never used to accuse anybody. Only a record that would be meaningless is refused (not bound, no
    assigned template, round already done, garbage input) — see `checkin_logic` and `attendance_router`.

    The columns are deliberately split into three groups:

    * **facts** — `employee_id`, `work_date` (Bangkok date), `checked_at` (server clock). The client's
      own time and identity are never stored.
    * **snapshots** — the round/template fields as they were at check-in time, so editing a round or a
      template tomorrow cannot rewrite what yesterday's record says, plus the matched location's name.
    * **statuses + `flags`** — what the rules concluded. `flags` is a JSON array of short codes and
      `review_status` says whether HR should look (`PENDING_REVIEW`) or not (`CLEAN`).

    `employee_id` carries **no foreign key on purpose**: the record must survive the employee row
    being deactivated or hard-deleted (deleting a `local_users` row cascades to
    `employee_work_profiles`, and attendance evidence must not disappear with it). `round_id` does
    reference the round but with `ON DELETE SET NULL` — the snapshot columns keep the meaning.

    One check-in per round per day is enforced by a partial unique index created at startup (task 019
    SAVEPOINT pattern), not only by the application check.
    """

    __tablename__ = "attendance_checkins"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    employee_id: Mapped[str] = mapped_column(String, index=True)
    # Indexed in the model *and* ensured at startup: `create_all` builds it on a fresh schema, the
    # startup DDL adds it to an install whose table already exists (task 022).
    work_date: Mapped[date] = mapped_column(Date, index=True)
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utc_now)
    round_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("attendance_template_rounds.id", ondelete="SET NULL"), nullable=True
    )

    template_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    round_seq: Mapped[int | None] = mapped_column(Integer, nullable=True)
    round_label: Mapped[str | None] = mapped_column(String(80), nullable=True)
    expected_time: Mapped[time | None] = mapped_column(Time, nullable=True)
    window_start: Mapped[time | None] = mapped_column(Time, nullable=True)
    window_end: Mapped[time | None] = mapped_column(Time, nullable=True)
    grace_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    photo_required: Mapped[bool] = mapped_column(Boolean, default=False)

    time_status: Mapped[str] = mapped_column(String(24))

    lat: Mapped[Decimal | None] = mapped_column(Numeric(9, 6), nullable=True)
    lng: Mapped[Decimal | None] = mapped_column(Numeric(9, 6), nullable=True)
    accuracy_m: Mapped[Decimal | None] = mapped_column(Numeric(7, 1), nullable=True)
    gps_status: Mapped[str] = mapped_column(String(12))
    matched_location_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    matched_location_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    distance_m: Mapped[Decimal | None] = mapped_column(Numeric(9, 2), nullable=True)
    location_status: Mapped[str] = mapped_column(String(24))

    photo_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    photo_status: Mapped[str] = mapped_column(String(24))

    flags: Mapped[list] = mapped_column(JSONB, default=list)
    review_status: Mapped[str] = mapped_column(String(20), default="CLEAN", index=True)

    # HR review (task 022): who decided, when, and why. `review_status` above is the state; nothing in
    # the employee-facing flow writes these three, and ACCEPTED/REJECTED are only ever set by the
    # review endpoints. `review_note` is optional for ACCEPTED and required for REJECTED.
    reviewed_by: Mapped[str | None] = mapped_column(String, nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    review_note: Mapped[str | None] = mapped_column(String(500), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utc_now)


# ─── Company news (task 036) ──────────────────────────────────────────────────

class NewsCategory(Base):
    """A category HR assigns to company news (task 036).

    Categories are **never hard-deleted** — `is_active` is the off switch — so news that already
    points at a category keeps a valid reference and the "seed only when the table is empty" rule
    cannot resurrect a row HR removed. `name` is UNIQUE in the database (exact match) and the API
    additionally refuses a case-insensitive duplicate, the same two-layer pattern the attendance
    master data uses (task 014).

    `news_count` is not a column: the API counts the referencing `news_items` rows on read.
    Timestamps are timestamptz, like every table added since task 014.
    """

    __tablename__ = "news_categories"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(50), unique=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=100)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utc_now, onupdate=_utc_now)
    created_by: Mapped[str | None] = mapped_column(String, nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String, nullable=True)


class NewsItem(Base):
    """One company-news item (task 036). HR writes it; employees will read the published ones (037).

    `body` is **plain text**, stored as typed (trimmed at both ends, `\r\n` normalised to `\n`,
    internal line breaks kept). Nothing in this API renders, sanitises, escapes or auto-links it —
    what HR types is what comes back, and task 037 decides how it is displayed.

    `status` walks DRAFT -> PUBLISHED -> WITHDRAWN -> PUBLISHED; the transitions live in
    `news_router`. `published_at` and `withdrawn_at` keep the history: a republished item keeps the
    previous withdrawal time as well as the new publication time.

    `category_id` is required and uses ON DELETE RESTRICT — categories are deactivated, never
    deleted, so the constraint can only fire on a hand-written delete. Title/body limits are
    **characters** (code points) and are enforced by the API; the column lengths are a safety net.
    """

    __tablename__ = "news_items"
    __table_args__ = (
        # The part-2 read path is "published items, newest first". A plain B-tree on
        # (status, published_at) serves that ordering (PostgreSQL scans the index backwards), and
        # unlike an expression index it is built identically by `create_all` on a fresh schema.
        Index("ix_news_items_status_published_at", "status", "published_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    category_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("news_categories.id", ondelete="RESTRICT"), index=True
    )
    title: Mapped[str] = mapped_column(String(150))
    body: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="DRAFT")
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    withdrawn_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utc_now, onupdate=_utc_now)
    created_by: Mapped[str | None] = mapped_column(String, nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String, nullable=True)

