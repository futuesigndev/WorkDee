from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, text
from app.database import get_db
from app.models import AuditLog, LocalUser
from app.dependencies import get_current_user_id
from datetime import datetime, time, timedelta
from collections import defaultdict
import random

router = APIRouter(tags=["Logs"])

def parse_date_range(date_from_str: str | None, date_to_str: str | None):
    dt_from = None
    dt_to = None
    if date_from_str:
        try:
            if "T" in date_from_str:
                # Handle ISO format
                dt_from = datetime.fromisoformat(date_from_str.replace("Z", "+00:00"))
            else:
                dt_from = datetime.combine(datetime.strptime(date_from_str, "%Y-%m-%d").date(), time.min)
        except Exception as e:
            print(f"Error parsing date_from {date_from_str}: {e}")
    if date_to_str:
        try:
            if "T" in date_to_str:
                # Handle ISO format
                dt_to = datetime.fromisoformat(date_to_str.replace("Z", "+00:00"))
            else:
                dt_to = datetime.combine(datetime.strptime(date_to_str, "%Y-%m-%d").date(), time.max)
        except Exception as e:
            print(f"Error parsing date_to {date_to_str}: {e}")
    return dt_from, dt_to

@router.get("/logs")
async def get_logs(
    page: int | None = None,
    page_size: int | None = None,
    action_filter: str | None = None,
    actor_filter: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    db: AsyncSession = Depends(get_db),
    admin_id: str = Depends(get_current_user_id)
):
    try:
        stmt = select(AuditLog)
        
        # Apply filters
        conditions = []
        if action_filter and action_filter != "ALL":
            conditions.append(AuditLog.action == action_filter)
        if actor_filter:
            conditions.append(AuditLog.actor_id.ilike(f"%{actor_filter}%"))
            
        dt_from, dt_to = parse_date_range(date_from, date_to)
        if dt_from:
            conditions.append(AuditLog.created_at >= dt_from)
        if dt_to:
            conditions.append(AuditLog.created_at <= dt_to)
            
        if conditions:
            stmt = stmt.where(and_(*conditions))
            
        stmt = stmt.order_by(AuditLog.created_at.desc())
        
        if page is not None or page_size is not None:
            p = page or 1
            ps = page_size or 50
            
            # Get count
            count_stmt = select(func.count()).select_from(stmt.subquery())
            count_result = await db.execute(count_stmt)
            total = count_result.scalar_one()
            
            offset = (p - 1) * ps
            stmt = stmt.offset(offset).limit(ps)
            
            result = await db.execute(stmt)
            logs = result.scalars().all()
            
            return {
                "logs": logs,
                "total": total,
                "page": p,
                "page_size": ps
            }
        else:
            # Default response: raw array of logs
            stmt = stmt.limit(200)
            result = await db.execute(stmt)
            return result.scalars().all()
            
    except Exception as e:
        print(f"Error fetching logs: {e}")
        if page is not None or page_size is not None:
            return {"logs": [], "total": 0, "page": page or 1, "page_size": page_size or 50}
        return []

@router.get("/logs/summary")
async def get_logs_summary(
    date_from: str | None = None,
    date_to: str | None = None,
    db: AsyncSession = Depends(get_db),
    admin_id: str = Depends(get_current_user_id)
):
    try:
        today_start = datetime.combine(datetime.utcnow().date(), time.min)
        today_end = datetime.combine(datetime.utcnow().date(), time.max)
        
        # 1. Total Logins Today
        stmt_today_logins = select(func.count(AuditLog.id)).where(
            AuditLog.action == "AUTH_LOGIN_SUCCESS",
            AuditLog.created_at >= today_start,
            AuditLog.created_at <= today_end
        )
        res_today_logins = await db.execute(stmt_today_logins)
        total_logins_today = res_today_logins.scalar_one()
        
        # 2. Unique Users Today
        stmt_today_users = select(func.count(func.distinct(AuditLog.actor_id))).where(
            AuditLog.action == "AUTH_LOGIN_SUCCESS",
            AuditLog.created_at >= today_start,
            AuditLog.created_at <= today_end
        )
        res_today_users = await db.execute(stmt_today_users)
        unique_users_today = res_today_users.scalar_one()
        
        # 3. Total Logins Period & Top Users
        dt_from, dt_to = parse_date_range(date_from, date_to)
        
        if not dt_from:
            dt_from = datetime.combine((datetime.utcnow() - timedelta(days=30)).date(), time.min)
        if not dt_to:
            dt_to = datetime.combine(datetime.utcnow().date(), time.max)
            
        stmt_period_logins = select(func.count(AuditLog.id)).where(
            AuditLog.action == "AUTH_LOGIN_SUCCESS",
            AuditLog.created_at >= dt_from,
            AuditLog.created_at <= dt_to
        )
        res_period_logins = await db.execute(stmt_period_logins)
        total_logins_period = res_period_logins.scalar_one()
        
        # Top Users
        top_users_stmt = (
            select(
                AuditLog.actor_id,
                func.coalesce(LocalUser.full_name, AuditLog.actor_id).label("full_name"),
                func.count(AuditLog.id).label("login_count")
            )
            .outerjoin(LocalUser, AuditLog.actor_id == LocalUser.employee_id)
            .where(
                AuditLog.action == "AUTH_LOGIN_SUCCESS",
                AuditLog.created_at >= dt_from,
                AuditLog.created_at <= dt_to
            )
            .group_by(AuditLog.actor_id, LocalUser.full_name)
            .order_by(func.count(AuditLog.id).desc())
            .limit(5)
        )
        top_users_res = await db.execute(top_users_stmt)
        top_users = [
            {"actor_id": row[0], "full_name": row[1], "login_count": row[2]}
            for row in top_users_res.all()
        ]
        
        return {
            "total_logins_today": total_logins_today,
            "unique_users_today": unique_users_today,
            "total_logins_period": total_logins_period,
            "top_users": top_users
        }
    except Exception as e:
        print(f"Error fetching summary: {e}")
        return {
            "total_logins_today": 0,
            "unique_users_today": 0,
            "total_logins_period": 0,
            "top_users": []
        }

@router.get("/logs/sessions")
async def get_logs_sessions(
    group_by: str = "month", # "month" or "day"
    actor_filter: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    db: AsyncSession = Depends(get_db),
    admin_id: str = Depends(get_current_user_id)
):
    try:
        dt_from, dt_to = parse_date_range(date_from, date_to)
        
        stmt = select(AuditLog).where(AuditLog.action.in_(["AUTH_LOGIN_SUCCESS", "AUTH_LOGOUT"]))
        if dt_from:
            stmt = stmt.where(AuditLog.created_at >= dt_from)
        if dt_to:
            stmt = stmt.where(AuditLog.created_at <= dt_to)
        if actor_filter:
            stmt = stmt.where(AuditLog.actor_id == actor_filter)
            
        stmt = stmt.order_by(AuditLog.actor_id, AuditLog.created_at.asc())
        result = await db.execute(stmt)
        logs = result.scalars().all()
        
        # Group by actor_id
        user_events = defaultdict(list)
        for log in logs:
            user_events[log.actor_id].append(log)
            
        # Get names map
        user_names_stmt = select(LocalUser.employee_id, LocalUser.full_name)
        user_names_res = await db.execute(user_names_stmt)
        user_names_map = {row[0]: row[1] for row in user_names_res.all()}
        
        aggregates = defaultdict(lambda: {"total_minutes": 0, "session_count": 0})
        
        for actor_id, events in user_events.items():
            active_login_time = None
            
            for event in events:
                if event.action == "AUTH_LOGIN_SUCCESS":
                    if active_login_time is not None:
                        # Close previous active session with estimate
                        diff_sec = (event.created_at - active_login_time).total_seconds()
                        duration_min = min(diff_sec / 60.0, 480.0) # Cap at 8 hours
                        if duration_min < 0.5:
                            duration_min = 30.0 # Default
                            
                        login_date = active_login_time
                        period = login_date.strftime("%Y-%m") if group_by == "month" else login_date.strftime("%Y-%m-%d")
                        
                        aggregates[(actor_id, period)]["total_minutes"] += duration_min
                        aggregates[(actor_id, period)]["session_count"] += 1
                        
                    active_login_time = event.created_at
                elif event.action == "AUTH_LOGOUT":
                    if active_login_time is not None:
                        diff_sec = (event.created_at - active_login_time).total_seconds()
                        duration_min = min(diff_sec / 60.0, 480.0)
                        if duration_min < 1.0:
                            duration_min = 1.0
                            
                        login_date = active_login_time
                        period = login_date.strftime("%Y-%m") if group_by == "month" else login_date.strftime("%Y-%m-%d")
                        
                        aggregates[(actor_id, period)]["total_minutes"] += duration_min
                        aggregates[(actor_id, period)]["session_count"] += 1
                        active_login_time = None
                        
            if active_login_time is not None:
                # Handle leftover open login
                now = datetime.utcnow()
                diff_sec = (now - active_login_time).total_seconds()
                if diff_sec > 0:
                    duration_min = min(diff_sec / 60.0, 480.0)
                else:
                    duration_min = 30.0
                    
                login_date = active_login_time
                period = login_date.strftime("%Y-%m") if group_by == "month" else login_date.strftime("%Y-%m-%d")
                
                aggregates[(actor_id, period)]["total_minutes"] += duration_min
                aggregates[(actor_id, period)]["session_count"] += 1
                
        sessions_output = []
        for (actor_id, period), data in aggregates.items():
            full_name = user_names_map.get(actor_id, actor_id)
            total_min = round(data["total_minutes"], 1)
            session_count = data["session_count"]
            avg_min = round(total_min / session_count, 1) if session_count > 0 else 0
            
            sessions_output.append({
                "actor_id": actor_id,
                "full_name": full_name,
                "period": period,
                "total_minutes": total_min,
                "session_count": session_count,
                "avg_minutes": avg_min
            })
            
        sessions_output.sort(key=lambda x: (x["period"], -x["total_minutes"]))
        
        return {
            "sessions": sessions_output,
            "group_by": group_by
        }
    except Exception as e:
        print(f"Error fetching session logs: {e}")
        return {"sessions": [], "group_by": group_by}

