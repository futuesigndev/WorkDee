from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update, or_, and_, func
from sqlalchemy.exc import IntegrityError
from app.database import get_db
from app.line_identity import LineIdentity, get_verified_line_identity
from app.models import LineBinding, LocalUser, AuditLog, LocalRole, AppSettings
from app.dependencies import get_current_user_id, require_permission
from app.config import settings
from app.core_api import core_api_client
from app import line_richmenu
from datetime import datetime
from pydantic import BaseModel
import asyncio
import logging
import uuid
import httpx

router = APIRouter(tags=["LINE"])

logger = logging.getLogger("app.line_router")

# Thai messages for the rich menu endpoints (task 025). Failures keep LINE's own words *plus* one
# sentence that says what kind of failure it was: a 400 means LINE disliked the menu **body**, never the
# token (the list call with the same token succeeds), so only a 401/403 may mention the token.
RICH_MENU_NO_TOKEN_DETAIL = "ยังไม่ได้ตั้งค่า Channel Access Token ของ LINE กรุณาตั้งค่าที่หน้า ตั้งค่าระบบ ก่อน"
RICH_MENU_NO_LIFF_DETAIL = "ยังไม่ได้ตั้งค่า LIFF ID กรุณาตั้งค่าให้เรียบร้อยก่อนสร้างเมนู"
RICH_MENU_TOKEN_REJECTED_DETAIL = (
    "LINE ปฏิเสธ Channel Access Token หรือสิทธิ์ของช่องทาง (HTTP {status}) "
    "กรุณาตรวจสอบที่หน้า ตั้งค่าระบบ"
)
RICH_MENU_BODY_REJECTED_DETAIL = "LINE ปฏิเสธรูปแบบเมนู (HTTP 400)"
RICH_MENU_RATE_LIMITED_DETAIL = "LINE จำกัดจำนวนคำขอสร้าง/ลบเมนู (HTTP 429) กรุณารอสักครู่แล้วลองใหม่"
RICH_MENU_LINE_DOWN_DETAIL = "LINE มีปัญหา (HTTP {status}) กรุณาลองใหม่อีกครั้งภายหลัง"
RICH_MENU_UNREACHABLE_DETAIL = "ติดต่อ LINE ไม่ได้ (เครือข่ายหรือหมดเวลา) กรุณาลองใหม่อีกครั้ง"
RICH_MENU_OTHER_DETAIL = "LINE ปฏิเสธคำขอ (HTTP {status})"
RICH_MENU_BODY_INVALID_DETAIL = "เมนูที่ระบบสร้างไม่ถูกต้อง จึงยังไม่ส่งไปที่ LINE"
RICH_MENU_ERROR_DETAIL_SUFFIX = "\nรายละเอียดจาก LINE: {detail}"
RICH_MENU_AUDIT_ACTION = "LINE_RICHMENU_PUBLISHED"
# The hint line under the admin card. It has to be honest about what the status knows: this process
# only remembers menus it created (or found by name), and it never calls LINE just to look.
RICH_MENU_NOTE_TH = (
    "สถานะนี้มาจากการสร้างเมนูในเซิร์ฟเวอร์รอบล่าสุด · กดปุ่มด้านล่างเพื่อสร้าง/อัปเดตให้ตรงกับ LINE จริง"
)

# Partial unique indexes created at startup (task 019 item C). They live here because this module is
# what turns a violation of them into a 409; `app.main` imports the names when it creates them.
LINE_ACTIVE_LINE_USER_INDEX = "uq_line_bindings_active_line_user"
LINE_ACTIVE_EMPLOYEE_INDEX = "uq_line_bindings_active_employee"
LINE_BINDING_INDEX_NAMES = (LINE_ACTIVE_LINE_USER_INDEX, LINE_ACTIVE_EMPLOYEE_INDEX)

# One Thai 409 for "this LINE account / employee already has an active binding": the pre-checks below
# and the database itself (those indexes) both answer with this text.
BINDING_ALREADY_ACTIVE_DETAIL = "บัญชี LINE นี้ผูกกับพนักงานในระบบแล้ว หากต้องการเปลี่ยน กรุณาติดต่อผู้ดูแลระบบ"


def _rich_menu_failure_detail(status: int, detail: str = "") -> str:
    """The Thai sentence for a refused LINE call, plus LINE's own explanation when it sent one.

    The mapping is the point of fix round 1: a 400 on create means LINE disliked the **body**, so it
    must never suggest a token problem (the same token's list call had just succeeded), while a 401/403
    really is about the token or the channel's rights.
    """
    if status in (401, 403):
        text = RICH_MENU_TOKEN_REJECTED_DETAIL.format(status=status)
    elif status == 400:
        text = RICH_MENU_BODY_REJECTED_DETAIL
    elif status == 429:
        text = RICH_MENU_RATE_LIMITED_DETAIL
    elif status >= 500:
        text = RICH_MENU_LINE_DOWN_DETAIL.format(status=status)
    elif status == 0:
        text = RICH_MENU_UNREACHABLE_DETAIL
    else:
        text = RICH_MENU_OTHER_DETAIL.format(status=status)
    if detail:
        text += RICH_MENU_ERROR_DETAIL_SUFFIX.format(detail=detail)
    return text


def _is_active_binding_conflict(exc: IntegrityError) -> bool:
    """True only when the failed statement hit one of the partial unique indexes.

    Any other integrity error (a foreign key, a NOT NULL, ...) keeps its normal behaviour — it is
    re-raised instead of being reported as a duplicate binding.
    """
    message = str(getattr(exc, "orig", exc))
    return any(name in message for name in LINE_BINDING_INDEX_NAMES)


# Request bodies
class ApproveBindingRequest(BaseModel):
    employee_id: str | None = None

class RevokeBindingRequest(BaseModel):
    reason: str

class LineRegisterRequest(BaseModel):
    # Since task 018 the LINE user id comes from the verified ID token, never from this body. The
    # field is kept optional for the transition so an older LIFF page still loads; when it is sent
    # it must agree with the verified identity or the request is refused with 403 (see below).
    line_user_id: str | None = None
    employee_id: str           # พนักงานกรอกรหัสพนักงานตัวเองใน LIFF form
    display_name: str | None = None  # ชื่อที่แสดงใน LINE (optional)

@router.post("/line/register")
async def register_line_binding(
    payload: LineRegisterRequest,
    req: Request,
    db: AsyncSession = Depends(get_db),
    identity: LineIdentity = Depends(get_verified_line_identity),
):
    """
    LIFF/Webview endpoint — ไม่ใช้ session cookie เพราะพนักงานยังไม่มีบัญชีในระบบ
    แต่ **ต้อง** ส่ง LINE ID token ที่ตรวจสอบได้มาใน header `Authorization: Bearer <id_token>` (งาน 018)
    ตัว LINE User ID ที่ใช้บันทึกมาจาก token ที่ตรวจสอบแล้วเท่านั้น
    รับ Employee ID จาก LIFF form แล้วสร้าง PENDING record
    """
    # 0. ตัวตนต้องมาจาก token ที่ตรวจสอบแล้ว — ถ้า body ส่ง line_user_id มาและไม่ตรง ถือว่าเป็นการปลอม
    line_user_id = identity.line_user_id
    if payload.line_user_id is not None and payload.line_user_id != line_user_id:
        raise HTTPException(
            status_code=403,
            detail="ข้อมูล LINE ไม่ตรงกับบัญชีที่ยืนยันแล้ว กรุณาปิดแล้วเปิดหน้านี้ใหม่จาก LINE",
        )

    # 1. ตรวจสอบว่า LINE ID นี้มี PENDING หรือ APPROVED อยู่แล้วหรือไม่
    existing_stmt = select(LineBinding).where(
        and_(
            LineBinding.line_user_id == line_user_id,
            LineBinding.status.in_(["PENDING", "APPROVED"])
        )
    )
    existing = (await db.execute(existing_stmt)).scalar_one_or_none()
    if existing:
        if existing.status == "APPROVED":
            raise HTTPException(status_code=409, detail=BINDING_ALREADY_ACTIVE_DETAIL)
        # PENDING อยู่แล้ว — คืน OK ไม่ต้องสร้างซ้ำ
        return {"message": "ส่งคำขอผูกบัญชีไว้แล้ว กรุณารอผู้ดูแลระบบอนุมัติ", "status": "PENDING"}

    # 2. สร้าง PENDING binding record
    binding = LineBinding(
        line_user_id=line_user_id,
        employee_id=payload.employee_id,
        status="PENDING",
    )
    db.add(binding)

    # 3. บันทึก Audit Log
    ip_addr = req.client.host if req.client else "127.0.0.1"
    audit = AuditLog(
        action="EVENT_LINE_BINDING_REQUESTED",
        actor_id=payload.employee_id,
        details=f"พนักงานรหัส {payload.employee_id} ขอผูกบัญชี LINE",
        ip_address=ip_addr,
        metadata_json={
            "line_user_id": line_user_id,
            "employee_id": payload.employee_id,
            "display_name": payload.display_name or "",
        }
    )
    db.add(audit)

    try:
        await db.commit()
    except IntegrityError as exc:
        # Two requests can pass the pre-checks above at the same time; the partial unique indexes on
        # line_bindings are the real guarantee (task 019 item C), so translate their violation into
        # the same Thai 409 the pre-check uses. Anything else keeps its normal error behaviour.
        await db.rollback()
        if _is_active_binding_conflict(exc):
            raise HTTPException(status_code=409, detail=BINDING_ALREADY_ACTIVE_DETAIL) from None
        raise

    return {
        "message": "ส่งคำขอผูกบัญชีเรียบร้อยแล้ว กรุณารอผู้ดูแลระบบอนุมัติ",
        "status": "PENDING"
    }


async def line_channel_token(db: AsyncSession | None = None) -> str | None:
    """The channel access token to use, or None when LINE is not configured.

    `app_settings` wins over `.env` (an admin can rotate the token from the UI); the placeholder text
    from `.env.example` counts as "not configured" so a fresh install behaves like mock mode instead of
    sending unauthenticated requests to LINE. The value is never logged or returned.
    """
    token = settings.LINE_CHANNEL_ACCESS_TOKEN
    if db is not None:
        try:
            app_settings_db = (await db.execute(select(AppSettings).limit(1))).scalar_one_or_none()
            if app_settings_db and app_settings_db.line_channel_access_token:
                token = app_settings_db.line_channel_access_token
        except Exception as ex:
            print(f"Error fetching LINE token from db: {ex}")
    if not token or token == "YOUR_LINE_ACCESS_TOKEN":
        return None
    return token


async def line_liff_id(db: AsyncSession | None = None) -> str | None:
    """The LIFF id (from `app_settings`, falling back to `.env`), or None when it is not configured."""
    liff_id = settings.LINE_LIFF_ID
    if db is not None:
        try:
            app_settings_db = (await db.execute(select(AppSettings).limit(1))).scalar_one_or_none()
            if app_settings_db and app_settings_db.line_liff_id:
                liff_id = app_settings_db.line_liff_id
        except Exception as ex:
            print(f"Error fetching LIFF id from db: {ex}")
    return (liff_id or "").strip() or None


# The product name people see comes from the database, never from a constant (task 026): the shell, the
# LIFF pages and these LINE texts must all say the same thing, and an admin can change it in Settings.
# It is read per call — a cached name would outlive a Settings change, which is exactly what the spec
# forbids. An empty or missing value falls back to the product's own name so nothing ever renders blank.
BRAND_FALLBACK = "WorkDee"
BRAND_MAX_CHARS = 60


async def brand_name(db: AsyncSession | None = None) -> str:
    """ชื่อระบบที่แสดงให้คนเห็น: อ่านจาก app_settings ทุกครั้ง (ไม่ cache) แล้วตัดความยาว"""
    name = None
    if db is not None:
        try:
            row = (await db.execute(select(AppSettings).limit(1))).scalar_one_or_none()
            if row and row.app_name:
                name = row.app_name
        except Exception as ex:
            print(f"Error fetching app name from db: {ex}")
    return (name or "").strip()[:BRAND_MAX_CHARS] or BRAND_FALLBACK


def welcome_push_text(brand: str) -> str:
    """ข้อความทักทายหลังผูกบัญชีสำเร็จ (ใช้ชื่อระบบจาก Settings)"""
    return (
        "✅ การผูกบัญชีสำเร็จแล้ว!\n"
        f"ยินดีต้อนรับสู่ {brand}\n"
        "คุณสามารถเข้าใช้งานระบบได้ทันที"
    )


async def send_line_welcome_notification(line_user_id: str, db: AsyncSession) -> str:
    """Sends a welcome push notification to the bound LINE account.

    Returns the honest outcome instead of a bare boolean:
      "delivered"          — LINE accepted the push for a friend of the OA
      "skipped_not_friend" — the recipient has not added the OA as a friend (LINE would have
                             answered 200 and silently dropped the message)
      "skipped_no_token"   — no channel access token is configured (mock mode)
      "failed"             — the LINE API call raised
    """
    line_token = await line_channel_token(db)

    if not line_token:
        print(f"[MOCK LINE PUSH] Token not configured. Welcome message would be sent to: {line_user_id}")
        return "skipped_no_token"
        
    try:
        # LINE's push API answers 200 even when the recipient has NOT added the OA as a
        # friend — the message is then silently dropped (and never billed). Look the profile
        # up first so we can report the real outcome instead of claiming success.
        profile_res = await line_richmenu.get_profile(line_token, line_user_id)
        if profile_res.status_code == 404:
            print(f"LINE push skipped: user is not a friend of the OA (profile lookup 404) for {line_user_id}")
            return "skipped_not_friend"
        profile_res.raise_for_status()

        await line_richmenu.push_text(line_token, line_user_id, welcome_push_text(await brand_name(db)))
        print(f"LINE push notification sent successfully to {line_user_id}")
        return "delivered"
    except Exception as e:
        print(f"Failed to send LINE push notification: {e}")
        return "failed"

@router.get("/line/status")
async def get_own_line_binding_status(
    db: AsyncSession = Depends(get_db),
    identity: LineIdentity = Depends(get_verified_line_identity),
):
    """Status of the VERIFIED LINE account only (task 018).

    Used by the LIFF pending screen, which has no session cookie — so the identity comes from the
    LINE ID token instead. The response still carries ONLY the status string: no employee id, name
    or any other PII, and there is no way to ask about a LINE account other than your own.
    """
    return {"status": await _latest_binding_status(db, identity.line_user_id) or "NOT_FOUND"}


async def _latest_binding_status(db: AsyncSession, line_user_id: str) -> str | None:
    """Newest binding status for one LINE account (None when there is no row at all)."""
    stmt = (
        select(LineBinding.status)
        .where(LineBinding.line_user_id == line_user_id)
        .order_by(LineBinding.created_at.desc())
        .limit(1)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


CORE_LOOKUP_MAX_PER_REQUEST = 20


async def _core_lookup_employee(employee_id: str, access_token: str | None) -> tuple[str, str | None]:
    """Read-only Core-API check for one pending employee ID.

    Returns `(core_lookup, core_employee_name)`. `core_lookup` is "not_found" ONLY when Core-API
    clearly answers 404. Every other failure — an expired admin token (401), 5xx, timeout,
    connection error, or a 200 with an unusable body — is reported as "unavailable" so the pending
    list always keeps loading. The admin's token is handed to the client only: it is never logged,
    never stored, and never written into the response.
    """
    if not access_token:
        return "unavailable", None
    try:
        data = await core_api_client.get_employee(access_token, employee_id)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            print(f"[Core-API] pending lookup {employee_id}: not found")
            return "not_found", None
        print(f"[Core-API] pending lookup {employee_id}: unavailable (HTTP {exc.response.status_code})")
        return "unavailable", None
    except Exception as exc:  # timeout, connection error, anything else
        print(f"[Core-API] pending lookup {employee_id}: unavailable ({type(exc).__name__})")
        return "unavailable", None

    name = (data or {}).get("full_name") if isinstance(data, dict) else None
    if not isinstance(name, str) or not name.strip():
        print(f"[Core-API] pending lookup {employee_id}: unavailable (unexpected body)")
        return "unavailable", None
    return "found", name


@router.get("/line/pending")
async def get_pending_bindings(
    req: Request,
    db: AsyncSession = Depends(get_db),
    admin_id: str = Depends(get_current_user_id),
    _current_user = Depends(require_permission("line"))
):
    """Gets the list of pending bindings, joined with employee details if matched.

    Pending employees without a `local_users` row yet are looked up in Core-API using the calling
    admin's own session token (the same cookie `approve_binding()` uses), so the admin sees the real
    name — or a clear "not in Core-API" warning — before approving. Strictly read-only: nothing here
    creates or changes a row; only Approve provisions users as before.
    """
    stmt = (
        select(LineBinding, LocalUser)
        .outerjoin(LocalUser, LineBinding.employee_id == LocalUser.employee_id)
        .where(LineBinding.status == "PENDING")
        .order_by(LineBinding.created_at.desc())
    )
    result = await db.execute(stmt)
    rows = result.all()

    bindings = []
    for row in rows:
        binding, user = row[0], row[1]
        bindings.append({
            "id": binding.id,
            "line_user_id": binding.line_user_id,
            "employee_id": binding.employee_id,
            "status": binding.status,
            "created_at": binding.created_at,
            "employee_name": user.full_name if user else None,
            "department": user.department if user else None,
            "division": user.division if user else None,
            "company": user.company if user else None,
        })

    # Employees with no local row: one Core-API call per distinct ID, concurrently, hard-capped.
    unknown_ids: list[str] = []
    for binding, user in rows:
        if user is None and binding.employee_id not in unknown_ids:
            unknown_ids.append(binding.employee_id)

    looked_up: dict[str, tuple[str, str | None]] = {}
    if unknown_ids:
        access_token = req.cookies.get("access_token")
        capped_ids = unknown_ids[:CORE_LOOKUP_MAX_PER_REQUEST]
        outcomes = await asyncio.gather(
            *(_core_lookup_employee(employee_id, access_token) for employee_id in capped_ids)
        )
        looked_up = dict(zip(capped_ids, outcomes))

    for idx, (binding, user) in enumerate(rows):
        item = bindings[idx]
        if user is not None:
            item["core_employee_name"] = None
            item["core_lookup"] = "local"
        else:
            outcome, name = looked_up.get(binding.employee_id, ("unavailable", None))
            item["core_employee_name"] = name
            item["core_lookup"] = outcome

    return bindings

@router.get("/line/approved")
async def get_approved_bindings(
    search: str = "",
    sort_key: str = "created_at",
    sort_order: str = "desc",
    page: int = 1,
    page_size: int = 10,
    db: AsyncSession = Depends(get_db),
    admin_id: str = Depends(get_current_user_id),
    _current_user = Depends(require_permission("line"))
):
    """Gets the list of active/approved bindings with search, sort, and pagination."""
    # Base query joining LineBinding and LocalUser
    stmt = select(LineBinding, LocalUser).join(
        LocalUser, LineBinding.employee_id == LocalUser.employee_id
    ).where(LineBinding.status == "APPROVED")
    
    if search:
        search_filter = f"%{search}%"
        stmt = stmt.where(
            or_(
                LineBinding.employee_id.ilike(search_filter),
                LineBinding.line_user_id.ilike(search_filter),
                LocalUser.full_name.ilike(search_filter),
                LocalUser.department.ilike(search_filter),
            )
        )
        
    # Count query for pagination
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total_result = await db.execute(count_stmt)
    total_items = total_result.scalar() or 0
    
    # Sort mapping
    order_col = LineBinding.created_at
    if sort_key == "employee_id":
        order_col = LineBinding.employee_id
    elif sort_key == "approved_at":
        order_col = LineBinding.approved_at
        
    if sort_order == "asc":
        stmt = stmt.order_by(order_col.asc())
    else:
        stmt = stmt.order_by(order_col.desc())
        
    # Pagination
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(stmt)
    
    items = []
    for row in result.all():
        binding, user = row[0], row[1]
        items.append({
            "id": binding.id,
            "line_user_id": binding.line_user_id,
            "employee_id": binding.employee_id,
            "status": binding.status,
            "approved_by": binding.approved_by,
            "approved_at": binding.approved_at,
            "created_at": binding.created_at,
            "employee_name": user.full_name if user else None,
            "department": user.department if user else None,
            "division": user.division if user else None,
            "company": user.company if user else None,
        })
        
    return {
        "items": items,
        "total": total_items,
        "page": page,
        "page_size": page_size
    }

@router.post("/line/approve/{binding_id}")
async def approve_binding(
    binding_id: uuid.UUID,
    req: Request,
    payload: ApproveBindingRequest = None,
    db: AsyncSession = Depends(get_db),
    admin_id: str = Depends(get_current_user_id),
    _current_user = Depends(require_permission("line"))
):
    """Approves a LINE binding. Optionally updates the bound employee ID beforehand. Enforces 1:1 active bindings."""
    # Find the request binding
    binding_stmt = select(LineBinding).where(LineBinding.id == binding_id)
    binding = (await db.execute(binding_stmt)).scalar_one_or_none()
    if not binding:
        raise HTTPException(status_code=404, detail="ไม่พบคำขอผูกบัญชีนี้")
        
    # Determine the target employee ID (fallback to current employee_id if not overridden)
    target_employee_id = payload.employee_id if (payload and payload.employee_id) else binding.employee_id
    
    # 1. Verify target employee exists in LocalUser
    user_stmt = select(LocalUser).where(LocalUser.employee_id == target_employee_id)
    user = (await db.execute(user_stmt)).scalar_one_or_none()
    if not user:
        # Attempt to auto-provision user from Core-API
        access_token = req.cookies.get("access_token")
        if not access_token:
            raise HTTPException(
                status_code=400,
                detail=f"ไม่พบรหัสพนักงาน '{target_employee_id}' ในระบบ และไม่พบเซสชันของผู้ดูแลระบบ"
            )
        try:
            emp_data = await core_api_client.get_employee(access_token, target_employee_id)
            # Get or create role "User"
            role_stmt = select(LocalRole).where(LocalRole.name == "User")
            role = (await db.execute(role_stmt)).scalar_one_or_none()
            if not role:
                role = LocalRole(name="User", is_system_role=False)
                db.add(role)
                await db.flush()
            
            user = LocalUser(
                employee_id=emp_data["employee_id"],
                full_name=emp_data["full_name"],
                department=emp_data.get("department", "N/A"),
                division=emp_data.get("division", "N/A"),
                company=emp_data.get("company_name") or emp_data.get("company", "N/A"),
                role_id=role.id,
                is_active=True,
            )
            db.add(user)
            await db.flush()
            
            # Log auto-provisioning
            ip_addr = req.client.host if req.client else "127.0.0.1"
            audit = AuditLog(
                action="USER_PROVISIONED",
                actor_id=admin_id,
                details=f"เพิ่มผู้ใช้ {target_employee_id} (บทบาท User) อัตโนมัติระหว่างอนุมัติผูกบัญชี LINE",
                metadata_json={"role": "User", "employee_id": target_employee_id},
            )
            db.add(audit)
        except Exception as e:
            print(f"Auto-provisioning failed for {target_employee_id}: {e}")
            raise HTTPException(
                status_code=400,
                detail=f"ไม่พบรหัสพนักงาน '{target_employee_id}' ในระบบ และดึงข้อมูลจาก Core-API ไม่สำเร็จ: {str(e)}"
            )

    if not user.is_active:
        raise HTTPException(status_code=400, detail="พนักงานคนนี้ถูกปิดการใช้งานอยู่ กรุณาเปิดการใช้งานก่อน")

    # 2. Security Check: Enforce 1 Employee per 1 LINE (LINE ID cannot be active on another employee)
    dup_line_stmt = select(LineBinding).where(
        and_(
            LineBinding.line_user_id == binding.line_user_id,
            LineBinding.employee_id != target_employee_id,
            LineBinding.status == "APPROVED"
        )
    )
    dup_line = (await db.execute(dup_line_stmt)).scalar_one_or_none()
    if dup_line:
        raise HTTPException(
            status_code=400,
            detail=f"บัญชี LINE นี้ผูกกับพนักงานรหัส {dup_line.employee_id} อยู่แล้ว"
        )

    # 3. Security Rule: Enforce 1 LINE per Employee (Revoke previous active bindings of this employee)
    old_bindings_stmt = select(LineBinding).where(
        and_(
            LineBinding.employee_id == target_employee_id,
            LineBinding.status == "APPROVED",
            LineBinding.id != binding.id
        )
    )
    old_bindings = (await db.execute(old_bindings_stmt)).scalars().all()
    ip_addr = req.client.host if req.client else "127.0.0.1"
    
    for old_bind in old_bindings:
        old_bind.status = "REVOKED"
        old_bind.revoke_reason = "Replaced by new LINE binding approval"
        old_bind.approved_by = admin_id
        old_bind.approved_at = datetime.utcnow()
        
        # Log old binding revocation
        old_audit = AuditLog(
            action="EVENT_LINE_BINDING_REVOKED",
            actor_id=admin_id,
            details=f"ยกเลิกการผูกบัญชี LINE {old_bind.id} อัตโนมัติ เพราะพนักงานมีรายการผูกใหม่",
            ip_address=ip_addr,
            metadata_json={
                "line_user_id": old_bind.line_user_id,
                "employee_id": target_employee_id,
                "reason": "Replaced by new LINE binding approval"
            }
        )
        db.add(old_audit)

    # Flush the revocations BEFORE the target row becomes APPROVED: the partial unique index on
    # line_bindings(employee_id) only allows one active row per employee at a time (task 019 item C),
    # so the old row must stop being APPROVED first.
    if old_bindings:
        await db.flush()

    # 4. Update the target binding status
    binding.status = "APPROVED"
    binding.employee_id = target_employee_id
    binding.approved_by = admin_id
    binding.approved_at = datetime.utcnow()
    
    # 5. Write Audit Log for approval
    audit = AuditLog(
        action="EVENT_LINE_BINDING_APPROVED",
        actor_id=admin_id,
        details=f"อนุมัติการผูกบัญชี LINE ของพนักงานรหัส {target_employee_id}",
        ip_address=ip_addr,
        metadata_json={
            "line_user_id": binding.line_user_id,
            "employee_id": target_employee_id
        }
    )
    db.add(audit)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        if _is_active_binding_conflict(exc):
            raise HTTPException(status_code=409, detail=BINDING_ALREADY_ACTIVE_DETAIL) from None
        raise
    
    # 6. Send push notification — keep the honest outcome so the log/response never claims a
    #    delivery that did not happen (a non-friend recipient is silently dropped by LINE).
    push_status = await send_line_welcome_notification(binding.line_user_id, db)
    print(f"LINE welcome push outcome for employee {target_employee_id}: {push_status}")

    # 7. Give this employee the employee rich menu (task 025). A LINE failure here — including "no menu
    #    has been published yet" — must never undo an approval that is already committed, so the outcome
    #    is reported, not raised, exactly like `push_status` above.
    menu_status = await line_richmenu.ensure_user_link(await line_channel_token(db), binding.line_user_id)
    print(f"LINE rich menu outcome for employee {target_employee_id}: {menu_status}")

    return {
        "message": "Approved successfully",
        "employee_id": target_employee_id,
        "push_status": push_status,
        "menu_status": menu_status,
    }

@router.post("/line/reject/{binding_id}")
async def reject_binding(
    binding_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    admin_id: str = Depends(get_current_user_id),
    _current_user = Depends(require_permission("line"))
):
    """Rejects a pending LINE binding."""
    stmt = update(LineBinding).where(
        and_(
            LineBinding.id == binding_id,
            LineBinding.status == "PENDING"
        )
    ).values(
        status="REJECTED",
        approved_by=admin_id,
        approved_at=datetime.utcnow()
    )
    res = await db.execute(stmt)
    if res.rowcount == 0:
        raise HTTPException(status_code=404, detail="ไม่พบคำขอผูกบัญชีที่รออนุมัติ")
        
    await db.commit()
    return {"message": "Rejected"}

@router.post("/line/revoke/{binding_id}")
async def revoke_binding(
    binding_id: uuid.UUID,
    payload: RevokeBindingRequest,
    req: Request,
    db: AsyncSession = Depends(get_db),
    admin_id: str = Depends(get_current_user_id),
    _current_user = Depends(require_permission("line"))
):
    """Manually revokes an active LINE binding with a provided reason."""
    stmt = select(LineBinding).where(
        and_(
            LineBinding.id == binding_id,
            LineBinding.status == "APPROVED"
        )
    )
    binding = (await db.execute(stmt)).scalar_one_or_none()
    if not binding:
        raise HTTPException(status_code=404, detail="ไม่พบการผูกบัญชี LINE ที่ใช้งานอยู่")
        
    binding.status = "REVOKED"
    binding.revoke_reason = payload.reason
    binding.approved_by = admin_id
    binding.approved_at = datetime.utcnow()
    
    ip_addr = req.client.host if req.client else "127.0.0.1"
    audit = AuditLog(
        action="EVENT_LINE_BINDING_REVOKED",
        actor_id=admin_id,
        details=f"ยกเลิกการผูกบัญชี LINE ของพนักงานรหัส {binding.employee_id} เหตุผล: {payload.reason}",
        ip_address=ip_addr,
        metadata_json={
            "line_user_id": binding.line_user_id,
            "employee_id": binding.employee_id,
            "reason": payload.reason
        }
    )
    db.add(audit)
    await db.commit()

    # Take the employee rich menu away from this LINE account (task 025). Same rule as approve: the
    # revocation is already committed, so a LINE failure is reported in `menu_status`, never raised.
    menu_status = await line_richmenu.ensure_user_unlink(await line_channel_token(db), binding.line_user_id)
    print(f"LINE rich menu unlink outcome for employee {binding.employee_id}: {menu_status}")

    return {"message": "Revoked successfully", "menu_status": menu_status}

import hmac
import hashlib
import base64
from fastapi import Header

def verify_line_signature(body: bytes, signature: str, channel_secret: str) -> bool:
    """Verifies that the webhook request signature matches the channel secret."""
    hash_obj = hmac.new(channel_secret.encode('utf-8'), body, hashlib.sha256).digest()
    expected_signature = base64.b64encode(hash_obj).decode('utf-8')
    return hmac.compare_digest(expected_signature, signature)

async def send_line_reply_messages(reply_token: str, messages: list[dict], db: AsyncSession = None):
    """Replies to a LINE event with a list of message objects."""
    line_token = await line_channel_token(db)

    if not line_token:
        print(f"[MOCK LINE REPLY] Reply Token: {reply_token}, Messages: {messages}")
        return True

    try:
        await line_richmenu.reply_text(line_token, reply_token, messages)
        print(f"LINE reply sent successfully to replyToken {reply_token}")
        return True
    except Exception as e:
        print(f"Failed to send LINE reply: {e}")
        if isinstance(e, httpx.HTTPStatusError):
            print(f"LINE reply error response: {e.response.text}")
        return False

@router.post("/line/rich-menu/publish")
async def publish_rich_menu(
    req: Request,
    db: AsyncSession = Depends(get_db),
    admin_id: str = Depends(get_current_user_id),
    _current_user=Depends(require_permission("line")),
):
    """Create (or replace) the employee rich menu and link it to every APPROVED employee.

    Never sets a **default** menu: only employees whose binding is APPROVED get it per user, so an
    employee who has not been approved still sees no menu at all. Safe to press again — the previous
    `WorkDee-employee` menu is deleted once the new one is live, so exactly one is left.

    The response carries counts only; the audit row records the same counts and **no LINE user ids**.
    """
    token = await line_channel_token(db)
    if not token:
        raise HTTPException(status_code=400, detail=RICH_MENU_NO_TOKEN_DETAIL)
    liff_id = await line_liff_id(db)
    if not liff_id:
        raise HTTPException(status_code=400, detail=RICH_MENU_NO_LIFF_DETAIL)

    # Read (and validate) the picture before touching LINE: a missing picture must not leave a menu
    # behind at LINE that nobody can see.
    try:
        image = line_richmenu.read_menu_image()
    except line_richmenu.RichMenuImageError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    approved_ids = (
        await db.execute(
            select(LineBinding.line_user_id).where(LineBinding.status == "APPROVED")
        )
    ).scalars().all()

    try:
        result = await line_richmenu.publish(token, liff_id, list(approved_ids), image)
    except line_richmenu.RichMenuBodyError as exc:
        # Our own pre-flight refused the body: nothing was sent, and the field is named in our words.
        logger.warning("LINE rich menu body rejected before publish: %s", exc)
        raise HTTPException(status_code=500, detail=f"{RICH_MENU_BODY_INVALID_DETAIL}: {exc}")
    except line_richmenu.RichMenuApiError as exc:
        # One WARNING carrying LINE's own explanation (already scrubbed of token, user ids, menu ids).
        logger.warning("LINE rich menu publish failed at %s (HTTP %s): %s",
                       exc.endpoint, exc.status, exc.detail)
        raise HTTPException(
            status_code=502, detail=_rich_menu_failure_detail(exc.status, exc.detail)
        )
    except httpx.HTTPStatusError as exc:  # a LINE call that did not go through the helper above
        logger.warning("LINE rich menu publish failed with HTTP %s", exc.response.status_code)
        raise HTTPException(
            status_code=502,
            detail=_rich_menu_failure_detail(exc.response.status_code),
        )
    except Exception as exc:  # noqa: BLE001 — a network failure is a 502, not a 500 stack trace
        logger.warning("LINE rich menu publish failed: %s", line_richmenu.safe_error(exc))
        raise HTTPException(status_code=502, detail=_rich_menu_failure_detail(0))

    # Counts only: an audit row must never become a list of who has a LINE account.
    db.add(AuditLog(
        action=RICH_MENU_AUDIT_ACTION,
        actor_id=admin_id,
        details=(
            f"เผยแพร่เมนูพนักงาน: เชื่อมสำเร็จ {result['linked']} จาก "
            f"{len(approved_ids)} รายการที่ผูกบัญชีแล้ว (ไม่สำเร็จ {result['failed']})"
        ),
        ip_address=req.client.host if req.client else "127.0.0.1",
        metadata_json={
            "menu_created": result["menu_created"],
            "approved_bindings": len(approved_ids),
            "linked": result["linked"],
            "failed": result["failed"],
            "skipped": result["skipped"],
        },
    ))
    await db.commit()

    return {
        "menu_created": result["menu_created"],
        "menu_id_suffix": line_richmenu.menu_id_suffix(result["menu_id"]),
        "approved_bindings": len(approved_ids),
        "linked": result["linked"],
        "failed": result["failed"],
        "skipped": result["skipped"],
    }


@router.get("/line/rich-menu/status")
async def rich_menu_status(
    db: AsyncSession = Depends(get_db),
    _current_user=Depends(require_permission("line")),
):
    """What the admin card needs, and nothing that could leak a secret.

    Deliberately **no LINE call**: opening a page must not send traffic to the User's real OA. The price
    is that `menu_exists` means "created by this server process (or found by name at LINE by some earlier
    request of this process)" — after a restart the card honestly shows "ยังไม่ได้สร้าง" until the admin
    presses publish, which is idempotent anyway. Never returns the token, the full menu id or the LIFF
    id — only booleans and the last 6 characters of the menu id.
    """
    token = await line_channel_token(db)
    liff_id = await line_liff_id(db)
    menu_id = line_richmenu.cached_menu_id()
    approved = (
        await db.execute(select(func.count()).select_from(LineBinding).where(LineBinding.status == "APPROVED"))
    ).scalar() or 0
    return {
        "menu_name": line_richmenu.MENU_NAME,
        "menu_exists": menu_id is not None,
        "menu_id_suffix": line_richmenu.menu_id_suffix(menu_id),
        "approved_bindings": int(approved),
        "channel_token_configured": bool(token),
        "liff_id_configured": bool(liff_id),
        "note_th": RICH_MENU_NOTE_TH,
    }


@router.post("/line/webhook")
async def line_webhook(
    request: Request,
    x_line_signature: str = Header(None),
    db: AsyncSession = Depends(get_db)
):
    """
    Webhook endpoint for receiving LINE events.
    Verifies x-line-signature and prints/logs the events payload.
    """
    body = await request.body()
    
    # Try to load app_settings from DB
    settings_stmt = select(AppSettings).limit(1)
    app_settings_db = (await db.execute(settings_stmt)).scalar_one_or_none()
    
    line_secret = (
        app_settings_db.line_channel_secret 
        if (app_settings_db and app_settings_db.line_channel_secret) 
        else settings.LINE_CHANNEL_SECRET
    )
    
    # 1. Signature verification is mandatory — fail closed when no real secret is configured.
    #    An unconfigured integration must not accept unsigned requests from anyone.
    if not line_secret or line_secret == "YOUR_LINE_CHANNEL_SECRET":
        raise HTTPException(
            status_code=503,
            detail="ยังไม่ได้ตั้งค่าการเชื่อมต่อ LINE (ไม่พบ Channel Secret)"
        )

    # 2. With a real secret configured, a signature is required. Missing header and invalid
    #    signature are kept as distinct failures so logs make clear which one fired.
    if not x_line_signature:
        raise HTTPException(status_code=400, detail="ไม่พบ header X-Line-Signature")
    if not verify_line_signature(body, x_line_signature, line_secret):
        raise HTTPException(status_code=401, detail="X-Line-Signature ไม่ถูกต้อง")
            
    # 3. Process events (logging them for system admin review)
    try:
        payload = await request.json()
        events = payload.get("events", [])
        print(f"Received LINE webhook events: {events}")
        
        for event in events:
            reply_token = event.get("replyToken")
            if not reply_token:
                continue
                
            event_type = event.get("type")

            # Placeholder buttons of the employee rich menu (task 025). Any other postback is ignored
            # on purpose — no reply — and the webhook still answers LINE with 200 as before.
            if event_type == "postback":
                postback_data = (event.get("postback") or {}).get("data")
                if line_richmenu.is_soon_postback(postback_data):
                    await send_line_reply_messages(
                        reply_token,
                        [{"type": "text", "text": line_richmenu.SOON_REPLY_TEXT_TH}],
                        db,
                    )
                continue

            should_reply = False
            
            if event_type == "follow":
                should_reply = True
            elif event_type == "message":
                msg = event.get("message", {})
                if msg.get("type") == "text":
                    should_reply = True
                    
            if should_reply:
                # ตรวจสอบว่า LINE User ID นี้ผูกบัญชีและอนุมัติสำเร็จแล้วหรือยัง
                source = event.get("source", {})
                line_user_id = source.get("userId")
                
                is_bound = False
                employee_name = ""
                if line_user_id:
                    bound_stmt = (
                        select(LineBinding, LocalUser)
                        .outerjoin(LocalUser, LineBinding.employee_id == LocalUser.employee_id)
                        .where(
                            and_(
                                LineBinding.line_user_id == line_user_id,
                                LineBinding.status == "APPROVED"
                            )
                        )
                    )
                    bound_res = (await db.execute(bound_stmt)).first()
                    if bound_res:
                        is_bound = True
                        binding, user = bound_res[0], bound_res[1]
                        employee_name = user.full_name if user else binding.employee_id

                if is_bound:
                    # ถ้าผูกบัญชีเรียบร้อยแล้ว ให้ตอบกลับแจ้งสถานะ แทนที่จะส่ง Flex Message ลงทะเบียนซ้ำซาก
                    brand = await brand_name(db)
                    reply_text = {
                        "type": "text",
                        "text": f"สวัสดีค่ะ/ครับ คุณ {employee_name} 🎉\nบัญชี LINE ของคุณผูกกับระบบ {brand} เรียบร้อยแล้วค่ะ/ครับ"
                    }
                    await send_line_reply_messages(reply_token, [reply_text], db)
                else:
                    line_liff_id = (
                        app_settings_db.line_liff_id 
                        if (app_settings_db and app_settings_db.line_liff_id) 
                        else settings.LINE_LIFF_ID
                    )
                    if line_liff_id:
                        liff_url = f"https://liff.line.me/{line_liff_id}"
                        # ชื่อนี้ต้องมาจาก Settings เหมือนที่อื่น (ผู้ใช้เห็นบนมือถือ)
                        brand = await brand_name(db)

                        # ออกแบบ Flex Message แบบพรีเมียมสำหรับการลงทะเบียน
                        flex_message = {
                            "type": "flex",
                            "altText": f"ลงทะเบียนผูกบัญชี {brand}",
                            "contents": {
                                "type": "bubble",
                                "size": "mega",
                                "header": {
                                    "type": "box",
                                    "layout": "vertical",
                                    "backgroundColor": "#06C755",
                                    "contents": [
                                        {
                                            "type": "text",
                                            "text": brand,
                                            "color": "#ffffff",
                                            "weight": "bold",
                                            "size": "lg"
                                        },
                                        {
                                            "type": "text",
                                            "text": "ผูกบัญชี LINE",
                                            "color": "#e2e8f0",
                                            "size": "xs",
                                            "margin": "xs"
                                        }
                                    ],
                                    "paddingAll": "xl"
                                },
                                "body": {
                                    "type": "box",
                                    "layout": "vertical",
                                    "contents": [
                                        {
                                            "type": "text",
                                            "text": f"ยินดีต้อนรับสู่ระบบ {brand}",
                                            "weight": "bold",
                                            "size": "md",
                                            "color": "#1f2937"
                                        },
                                        {
                                            "type": "text",
                                            "text": "กรุณาลงทะเบียนผูกบัญชี LINE ของคุณกับระบบพนักงาน เพื่อเข้าใช้งานและรับการแจ้งเตือนจากบริษัทค่ะ/ครับ",
                                            "size": "sm",
                                            "color": "#4b5563",
                                            "wrap": True,
                                            "margin": "md"
                                        }
                                    ],
                                    "paddingAll": "xl"
                                },
                                "footer": {
                                    "type": "box",
                                    "layout": "vertical",
                                    "spacing": "sm",
                                    "contents": [
                                        {
                                            "type": "button",
                                            "style": "primary",
                                            "color": "#06C755",
                                            "action": {
                                                "type": "uri",
                                                "label": "👉 เริ่มต้นลงทะเบียน 👈",
                                                "uri": liff_url
                                            },
                                            "height": "md"
                                        }
                                    ],
                                    "paddingAll": "xl",
                                    "paddingTop": "none"
                                }
                            }
                        }
                        
                        await send_line_reply_messages(reply_token, [flex_message], db)
                
    except Exception as e:
        print(f"Error parsing LINE webhook payload: {e}")
        
    return {"status": "ok"}


