from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, text
from app.database import get_db
from app.models import AuditLog, LocalUser
from app.dependencies import require_permission
from app.photo_storage import BANGKOK_TZ
from datetime import date, datetime, time, timedelta, timezone
from collections import defaultdict
import random

router = APIRouter(tags=["Logs"])

# ─── day boundaries (task 053) ─────────────────────────────────────────────────────────────────────
# The Logs page asks for calendar dates; the decision is that a "day" there is an **Asia/Bangkok** day.
# `audit_logs.created_at` is a `timestamp without time zone` written by `datetime.utcnow()`, so the column
# carries UTC wall-clock: a Bangkok day is therefore
#     [00:00:00 +07 → the previous UTC day 17:00:00 , next day 00:00:00 +07 → that UTC day 17:00:00)
# The two instants below are converted into that naive-UTC form **before** they reach the comparison, so
# nothing about what is stored, the column type or the response changes — only the interpretation of the
# requested dates (before 053 a date was compared as a UTC day, which is off by up to 7 hours; the time
# shown in the table was already fixed by 047). `BANGKOK_TZ` is the project's single named zone constant.


def bangkok_day_bounds(day: date) -> tuple[datetime, datetime]:
    """A Bangkok calendar day as naive-UTC `(first instant, last instant)` for the audit column.

    Both ends are inclusive, matching how the filter has always compared (`>= from`, `<= to`): the `to`
    side is the last microsecond before the next Bangkok midnight (17:00:00 UTC of that UTC day).
    """
    start = datetime.combine(day, time.min, tzinfo=BANGKOK_TZ).astimezone(timezone.utc).replace(tzinfo=None)
    next_start = datetime.combine(day + timedelta(days=1), time.min, tzinfo=BANGKOK_TZ)
    end = next_start.astimezone(timezone.utc).replace(tzinfo=None) - timedelta(microseconds=1)
    return start, end


def bangkok_period(moment: datetime, group_by: str) -> str:
    """The Bangkok day (`YYYY-MM-DD`) or month (`YYYY-MM`) a stored UTC-naive timestamp belongs to.

    A naive value is read as UTC (that is how it was written), then displayed in Bangkok — so a login at
    16:59 UTC belongs to the previous Bangkok day, not to the one its UTC date suggests.
    """
    local = moment.replace(tzinfo=timezone.utc).astimezone(BANGKOK_TZ)
    return local.strftime("%Y-%m") if group_by == "month" else local.strftime("%Y-%m-%d")


def parse_date_range(date_from_str: str | None, date_to_str: str | None):
    """The requested range as naive-UTC bounds for `audit_logs.created_at`.

    A plain `YYYY-MM-DD` is a **Bangkok** day (task 053). A value that carries a time (`T` in it) keeps the
    literal meaning it always had and is passed through unchanged, malformed values are still ignored
    (no bound at all) instead of answering an error.
    """
    def parse_bound(value: str, upper: bool) -> datetime | None:
        if "T" in value:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        day = datetime.strptime(value, "%Y-%m-%d").date()
        return bangkok_day_bounds(day)[1 if upper else 0]

    dt_from = None
    dt_to = None
    if date_from_str:
        try:
            dt_from = parse_bound(date_from_str, upper=False)
        except Exception as e:
            print(f"Error parsing date_from {date_from_str}: {e}")
    if date_to_str:
        try:
            dt_to = parse_bound(date_to_str, upper=True)
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
    _current_user = Depends(require_permission("logs"))
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
    _current_user = Depends(require_permission("logs"))
):
    try:
        # "Today" on this page means the current **Bangkok** day (task 053), not the UTC day.
        today_start, today_end = bangkok_day_bounds(datetime.now(BANGKOK_TZ).date())
        
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
            dt_from = bangkok_day_bounds(datetime.now(BANGKOK_TZ).date() - timedelta(days=30))[0]
        if not dt_to:
            dt_to = today_end
            
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
    _current_user = Depends(require_permission("logs"))
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
                        period = bangkok_period(login_date, group_by)
                        
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
                        period = bangkok_period(login_date, group_by)
                        
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
                period = bangkok_period(login_date, group_by)
                
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

