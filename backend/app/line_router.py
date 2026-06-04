from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update, or_, and_, func
from app.database import get_db
from app.models import LineBinding, LocalUser, AuditLog, LocalRole, AppSettings
from app.auth_router import get_current_user_id
from app.config import settings
from app.core_api import core_api_client
from datetime import datetime
from pydantic import BaseModel
import uuid
import httpx

router = APIRouter(tags=["LINE"])

# Request bodies
class ApproveBindingRequest(BaseModel):
    employee_id: str | None = None

class RevokeBindingRequest(BaseModel):
    reason: str

class LineRegisterRequest(BaseModel):
    line_user_id: str
    employee_id: str           # พนักงานกรอกรหัสพนักงานตัวเองใน LIFF form
    display_name: str | None = None  # ชื่อที่แสดงใน LINE (optional)

@router.post("/line/register")
async def register_line_binding(
    payload: LineRegisterRequest,
    req: Request,
    db: AsyncSession = Depends(get_db)
):
    """
    LIFF/Webview endpoint — ไม่ต้องการ Auth เพราะพนักงานยังไม่มีบัญชีในระบบ
    รับ LINE User ID + Employee ID จาก LIFF form แล้วสร้าง PENDING record
    """
    # 1. ตรวจสอบว่า LINE ID นี้มี PENDING หรือ APPROVED อยู่แล้วหรือไม่
    existing_stmt = select(LineBinding).where(
        and_(
            LineBinding.line_user_id == payload.line_user_id,
            LineBinding.status.in_(["PENDING", "APPROVED"])
        )
    )
    existing = (await db.execute(existing_stmt)).scalar_one_or_none()
    if existing:
        if existing.status == "APPROVED":
            raise HTTPException(
                status_code=409,
                detail="LINE account is already bound to an employee. Contact admin if you need to change it."
            )
        # PENDING อยู่แล้ว — คืน OK ไม่ต้องสร้างซ้ำ
        return {"message": "Binding request already pending. Please wait for admin approval.", "status": "PENDING"}

    # 2. สร้าง PENDING binding record
    binding = LineBinding(
        line_user_id=payload.line_user_id,
        employee_id=payload.employee_id,
        status="PENDING",
    )
    db.add(binding)

    # 3. บันทึก Audit Log
    ip_addr = req.client.host if req.client else "127.0.0.1"
    audit = AuditLog(
        action="EVENT_LINE_BINDING_REQUESTED",
        actor_id=payload.employee_id,
        details=f"LINE binding request created for employee {payload.employee_id}",
        ip_address=ip_addr,
        metadata_json={
            "line_user_id": payload.line_user_id,
            "employee_id": payload.employee_id,
            "display_name": payload.display_name or "",
        }
    )
    db.add(audit)
    await db.commit()

    return {
        "message": "Binding request submitted successfully. Please wait for admin approval.",
        "status": "PENDING"
    }


async def send_line_welcome_notification(line_user_id: str, db: AsyncSession):
    """Sends a welcome push notification to the bound LINE account."""
    # Try to load token from database first, fallback to settings in .env
    line_token = settings.LINE_CHANNEL_ACCESS_TOKEN
    try:
        settings_stmt = select(AppSettings).limit(1)
        app_settings_db = (await db.execute(settings_stmt)).scalar_one_or_none()
        if app_settings_db and app_settings_db.line_channel_access_token:
            line_token = app_settings_db.line_channel_access_token
    except Exception as ex:
        print(f"Error fetching LINE token from db for welcome push: {ex}")

    if not line_token or line_token == "YOUR_LINE_ACCESS_TOKEN":
        print(f"[MOCK LINE PUSH] Token not configured. Welcome message would be sent to: {line_user_id}")
        return True
        
    url = "https://api.line.me/v2/bot/message/push"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {line_token}"
    }
    payload = {
        "to": line_user_id,
        "messages": [
            {
                "type": "text",
                "text": "✅ การผูกบัญชีสำเร็จแล้ว!\nยินดีต้อนรับสู่ FutureSign\nคุณสามารถเข้าใช้งานระบบได้ทันที"
            }
        ]
    }
    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(url, json=payload, headers=headers, timeout=10.0)
            res.raise_for_status()
            print(f"LINE push notification sent successfully to {line_user_id}")
            return True
    except Exception as e:
        print(f"Failed to send LINE push notification: {e}")
        return False

@router.get("/line/pending")
async def get_pending_bindings(
    db: AsyncSession = Depends(get_db),
    admin_id: str = Depends(get_current_user_id)
):
    """Gets the list of pending bindings, joined with employee details if matched."""
    stmt = (
        select(LineBinding, LocalUser)
        .outerjoin(LocalUser, LineBinding.employee_id == LocalUser.employee_id)
        .where(LineBinding.status == "PENDING")
        .order_by(LineBinding.created_at.desc())
    )
    result = await db.execute(stmt)
    
    bindings = []
    for row in result.all():
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
    return bindings

@router.get("/line/approved")
async def get_approved_bindings(
    search: str = "",
    sort_key: str = "created_at",
    sort_order: str = "desc",
    page: int = 1,
    page_size: int = 10,
    db: AsyncSession = Depends(get_db),
    admin_id: str = Depends(get_current_user_id)
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
    admin_id: str = Depends(get_current_user_id)
):
    """Approves a LINE binding. Optionally updates the bound employee ID beforehand. Enforces 1:1 active bindings."""
    # Find the request binding
    binding_stmt = select(LineBinding).where(LineBinding.id == binding_id)
    binding = (await db.execute(binding_stmt)).scalar_one_or_none()
    if not binding:
        raise HTTPException(status_code=404, detail="LINE binding request not found")
        
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
                detail=f"Employee ID '{target_employee_id}' not found in the local system and admin session token is missing"
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
                details=f"Auto-provisioned {target_employee_id} (User role) during LINE binding approval",
                metadata_json={"role": "User", "employee_id": target_employee_id},
            )
            db.add(audit)
        except Exception as e:
            print(f"Auto-provisioning failed for {target_employee_id}: {e}")
            raise HTTPException(
                status_code=400,
                detail=f"Employee ID '{target_employee_id}' not found locally, and fetching from Core-API failed: {str(e)}"
            )

    if not user.is_active:
        raise HTTPException(status_code=400, detail="Target employee is currently inactive/deprovisioned")

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
            detail=f"This LINE ID is already actively bound to employee ID {dup_line.employee_id}"
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
            details=f"LINE binding {old_bind.id} auto-revoked as employee got new binding.",
            ip_address=ip_addr,
            metadata_json={
                "line_user_id": old_bind.line_user_id,
                "employee_id": target_employee_id,
                "reason": "Replaced by new LINE binding approval"
            }
        )
        db.add(old_audit)

    # 4. Update the target binding status
    binding.status = "APPROVED"
    binding.employee_id = target_employee_id
    binding.approved_by = admin_id
    binding.approved_at = datetime.utcnow()
    
    # 5. Write Audit Log for approval
    audit = AuditLog(
        action="EVENT_LINE_BINDING_APPROVED",
        actor_id=admin_id,
        details=f"Approved LINE binding for employee {target_employee_id}",
        ip_address=ip_addr,
        metadata_json={
            "line_user_id": binding.line_user_id,
            "employee_id": target_employee_id
        }
    )
    db.add(audit)
    await db.commit()
    
    # 6. Send push notification
    await send_line_welcome_notification(binding.line_user_id, db)
    
    return {"message": "Approved successfully", "employee_id": target_employee_id}

@router.post("/line/reject/{binding_id}")
async def reject_binding(
    binding_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    admin_id: str = Depends(get_current_user_id)
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
        raise HTTPException(status_code=404, detail="Pending binding request not found")
        
    await db.commit()
    return {"message": "Rejected"}

@router.post("/line/revoke/{binding_id}")
async def revoke_binding(
    binding_id: uuid.UUID,
    payload: RevokeBindingRequest,
    req: Request,
    db: AsyncSession = Depends(get_db),
    admin_id: str = Depends(get_current_user_id)
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
        raise HTTPException(status_code=404, detail="Active LINE binding not found")
        
    binding.status = "REVOKED"
    binding.revoke_reason = payload.reason
    binding.approved_by = admin_id
    binding.approved_at = datetime.utcnow()
    
    ip_addr = req.client.host if req.client else "127.0.0.1"
    audit = AuditLog(
        action="EVENT_LINE_BINDING_REVOKED",
        actor_id=admin_id,
        details=f"Manually revoked LINE binding for employee {binding.employee_id}. Reason: {payload.reason}",
        ip_address=ip_addr,
        metadata_json={
            "line_user_id": binding.line_user_id,
            "employee_id": binding.employee_id,
            "reason": payload.reason
        }
    )
    db.add(audit)
    await db.commit()
    
    return {"message": "Revoked successfully"}

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
    # Try to load token from database first, fallback to settings in .env
    line_token = settings.LINE_CHANNEL_ACCESS_TOKEN
    if db:
        try:
            settings_stmt = select(AppSettings).limit(1)
            app_settings_db = (await db.execute(settings_stmt)).scalar_one_or_none()
            if app_settings_db and app_settings_db.line_channel_access_token:
                line_token = app_settings_db.line_channel_access_token
        except Exception as ex:
            print(f"Error fetching LINE token from db for reply: {ex}")

    if not line_token or line_token == "YOUR_LINE_ACCESS_TOKEN":
        print(f"[MOCK LINE REPLY] Reply Token: {reply_token}, Messages: {messages}")
        return True
        
    url = "https://api.line.me/v2/bot/message/reply"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {line_token}"
    }
    payload = {
        "replyToken": reply_token,
        "messages": messages
    }
    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(url, json=payload, headers=headers, timeout=10.0)
            res.raise_for_status()
            print(f"LINE reply sent successfully to replyToken {reply_token}")
            return True
    except Exception as e:
        print(f"Failed to send LINE reply: {e}")
        if isinstance(e, httpx.HTTPStatusError):
            print(f"LINE reply error response: {e.response.text}")
        return False

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
    
    # 1. Validate signature if LINE_CHANNEL_SECRET is configured
    if line_secret and line_secret != "YOUR_LINE_CHANNEL_SECRET":
        if not x_line_signature:
            raise HTTPException(status_code=400, detail="Missing X-Line-Signature header")
        if not verify_line_signature(body, x_line_signature, line_secret):
            raise HTTPException(status_code=401, detail="Invalid X-Line-Signature")
            
    # 2. Process events (logging them for system admin review)
    try:
        payload = await request.json()
        events = payload.get("events", [])
        print(f"Received LINE webhook events: {events}")
        
        for event in events:
            reply_token = event.get("replyToken")
            if not reply_token:
                continue
                
            event_type = event.get("type")
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
                    reply_text = {
                        "type": "text",
                        "text": f"สวัสดีค่ะ/ครับ คุณ {employee_name} 🎉\nบัญชี LINE ของคุณผูกกับระบบ FutureSign เรียบร้อยแล้วค่ะ/ครับ"
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
                        
                        # ออกแบบ Flex Message แบบพรีเมียมสำหรับการลงทะเบียน
                        flex_message = {
                            "type": "flex",
                            "altText": "ลงทะเบียนผูกบัญชี FutureSign",
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
                                            "text": "FutureSign",
                                            "color": "#ffffff",
                                            "weight": "bold",
                                            "size": "lg"
                                        },
                                        {
                                            "type": "text",
                                            "text": "LINE Account Binding",
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
                                            "text": "ยินดีต้อนรับสู่ระบบ FutureSign",
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


