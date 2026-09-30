"""Verified LINE identity for LIFF calls (task 018).

Why this module exists
----------------------
Until task 017 the only identity a LIFF page could hand the backend was a `line_user_id` string in
the body or the URL, which anyone can forge. This module makes the LINE **ID token** the only
source of a LINE user id: the LIFF page sends it as `Authorization: Bearer <id_token>`, the backend
verifies it with LINE's own endpoint, and everything downstream uses `identity.line_user_id`.

Fail-closed rules (no bypass exists on purpose):

* We can only ask LINE for a verdict when we know which LINE Login channel owns the LIFF app. That
  channel id is the prefix of `app_settings.line_liff_id` (`<channelId>-<suffix>`). If the setting is
  empty or not in that form we answer 503 — we never "accept anyway".
* Network error, timeout, HTTP 5xx or an unusable body from LINE → 503, never a pass.
* A verdict LINE clearly gave (`400`/`401`, or a 200 whose `aud`/`sub`/`exp` do not hold up) → 401.

Caching: one LINE call per token, not per request. The cache key is the SHA-256 of the token (the
token itself is never stored, logged or written anywhere), the TTL is `min(token exp, 5 minutes)`
and failures are never cached.

There is deliberately **no** environment flag, debug switch or "trust the client when unset" path.
Tests replace this module's HTTP client factory (`_verify_client`) or the verifier function itself.
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import AppSettings, LineBinding, LocalUser

logger = logging.getLogger("app.line_identity")

# LINE docs: POST https://api.line.me/oauth2/v2.1/verify with form fields `id_token`, `client_id`.
LINE_ID_TOKEN_VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify"
VERIFY_TIMEOUT_SECONDS = 5.0
MAX_TOKEN_LENGTH = 4096
CACHE_MAX_ENTRIES = 1000
CACHE_MAX_TTL_SECONDS = 300.0
# A token LINE still calls valid is not rejected just because this server's clock runs fast.
CLOCK_SKEW_SECONDS = 30.0


class LineIdentityError(Exception):
    """Base class for everything that goes wrong while establishing a LINE identity."""


class LineTokenInvalid(LineIdentityError):
    """LINE rejected the token, or it does not hold up locally → HTTP 401."""


class LineVerificationUnavailable(LineIdentityError):
    """We could not get a trustworthy verdict from LINE (or from our own settings) → HTTP 503."""


@dataclass(frozen=True)
class LineIdentity:
    """Who the caller is, according to a token only LINE could have issued."""

    line_user_id: str
    expires_at: datetime


# ─── Test seams (both are ordinary factories, not switches that skip verification) ─────────────

def _now_epoch() -> float:
    """Current time; tests monkeypatch this to exercise expiry and cache TTL."""
    return time.time()


def _verify_client() -> httpx.AsyncClient:
    """The HTTP client used for the LINE call; tests inject a MockTransport here."""
    return httpx.AsyncClient(timeout=VERIFY_TIMEOUT_SECONDS)


# ─── Cache: sha256(token) -> (identity, epoch when the entry stops being usable) ───────────────

_cache: dict[str, tuple[LineIdentity, float]] = {}


def _cache_key(id_token: str) -> str:
    return hashlib.sha256(id_token.encode("utf-8")).hexdigest()


def _cache_store(key: str, identity: LineIdentity, usable_until: float) -> None:
    if len(_cache) >= CACHE_MAX_ENTRIES:
        now = _now_epoch()
        for stale_key in [k for k, (_, until) in _cache.items() if until <= now]:
            _cache.pop(stale_key, None)
        while len(_cache) >= CACHE_MAX_ENTRIES:
            # Still full: drop the entry that expires first. Nothing here is a source of truth —
            # a dropped entry only costs one extra LINE call.
            oldest_key = min(_cache, key=lambda k: _cache[k][1])
            _cache.pop(oldest_key, None)
    _cache[key] = (identity, usable_until)


def channel_id_from_liff_id(liff_id: str | None) -> str | None:
    """`<channelId>-<suffix>` → `<channelId>`; `None` when the setting cannot be used.

    A LIFF ID is issued by the LINE Login channel that owns the LIFF app, and the part before the
    first `-` is that channel's id — the `client_id` LINE expects when verifying an ID token.
    LINE Login channel ids are numeric, so anything else (empty, no dash, placeholder text, a
    non-numeric prefix) is treated as "not configured" and never sent to LINE.
    """
    if not isinstance(liff_id, str):
        return None
    value = liff_id.strip()
    if not value or "-" not in value:
        return None
    prefix = value.split("-", 1)[0]
    if not (prefix.isascii() and prefix.isdigit()):
        return None
    return prefix


async def resolve_line_login_channel_id(db: AsyncSession) -> str:
    """Read the channel id from Settings on every verification (never frozen at startup).

    Raises `LineVerificationUnavailable` so the caller answers 503 rather than accepting a token
    we cannot check. The value itself is never logged.
    """
    row = (await db.execute(select(AppSettings).limit(1))).scalar_one_or_none()
    channel_id = channel_id_from_liff_id(row.line_liff_id if row else None)
    if channel_id is None:
        logger.warning("LINE identity check unavailable: app_settings.line_liff_id is empty or malformed")
        raise LineVerificationUnavailable("line_liff_id is missing or not in '<channelId>-<suffix>' form")
    return channel_id


def _describe_error(response: httpx.Response) -> str:
    """LINE's `error`/`error_description` for the log line — never the token."""
    try:
        body = response.json()
    except Exception:  # noqa: BLE001 - a non-JSON error body is not worth a second failure
        return ""
    if not isinstance(body, dict):
        return ""
    error = body.get("error")
    description = body.get("error_description")
    if error and description:
        return f"{error}: {description}"
    if error:
        return str(error)
    if description:
        return str(description)
    return ""


async def verify_line_id_token(id_token: str, db: AsyncSession) -> LineIdentity:
    """Verify a LINE ID token and return the identity it proves.

    Raises `LineTokenInvalid` (→ 401) or `LineVerificationUnavailable` (→ 503). Successful results
    are cached; failures are not.
    """
    if not isinstance(id_token, str) or not id_token:
        raise LineTokenInvalid("empty token")

    key = _cache_key(id_token)
    now = _now_epoch()
    cached = _cache.get(key)
    if cached is not None:
        identity, usable_until = cached
        if usable_until > now:
            return identity
        _cache.pop(key, None)

    channel_id = await resolve_line_login_channel_id(db)

    try:
        async with _verify_client() as client:
            response = await client.post(
                LINE_ID_TOKEN_VERIFY_URL,
                data={"id_token": id_token, "client_id": channel_id},
            )
    except Exception as exc:  # noqa: BLE001 - timeout, connection error, DNS, anything else
        # No retry loop on purpose: a hidden retry would turn an outage into a long wait, and the
        # honest answer to the LIFF page is "cannot verify right now" (503).
        raise LineVerificationUnavailable(f"cannot reach LINE ({type(exc).__name__})") from exc

    if response.status_code >= 500:
        raise LineVerificationUnavailable(f"LINE answered HTTP {response.status_code}")

    if response.status_code != 200:
        detail = _describe_error(response)
        logger.warning("LINE rejected an ID token (HTTP %s%s)", response.status_code, f", {detail}" if detail else "")
        raise LineTokenInvalid(detail or f"LINE rejected the token (HTTP {response.status_code})")

    try:
        payload = response.json()
    except Exception as exc:  # noqa: BLE001
        raise LineVerificationUnavailable("LINE answered with a body that is not JSON") from exc

    if not isinstance(payload, dict):
        raise LineVerificationUnavailable("LINE answered with a body that is not a JSON object")

    # Trust the body only as far as it agrees with the channel we asked about, and re-check locally
    # instead of relying on LINE's HTTP status alone.
    if payload.get("aud") != channel_id:
        raise LineTokenInvalid("aud does not belong to this LINE Login channel")

    line_user_id = payload.get("sub")
    if not isinstance(line_user_id, str) or not line_user_id:
        raise LineTokenInvalid("sub is missing or empty")

    expires_raw = payload.get("exp")
    if isinstance(expires_raw, bool) or not isinstance(expires_raw, (int, float)):
        raise LineTokenInvalid("exp is missing or not a number")
    expires_epoch = float(expires_raw)
    if expires_epoch <= now - CLOCK_SKEW_SECONDS:
        raise LineTokenInvalid("token has expired")

    identity = LineIdentity(
        line_user_id=line_user_id,
        expires_at=datetime.fromtimestamp(expires_epoch, tz=timezone.utc),
    )
    # Never cache longer than the token's own lifetime, and never longer than 5 minutes.
    _cache_store(key, identity, min(expires_epoch, now + CACHE_MAX_TTL_SECONDS))
    return identity


# ─── FastAPI dependencies ─────────────────────────────────────────────────────────────────────

LINE_SESSION_EXPIRED_DETAIL = "เซสชัน LINE หมดอายุ กรุณาปิดแล้วเปิดหน้านี้ใหม่จาก LINE"
LINE_CANNOT_VERIFY_DETAIL = "ตรวจสอบตัวตนไม่ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง"
# Task 023: an APPROVED binding is not a licence to use the app. A deleted, deactivated or
# deprovisioned employee is refused here too, with a sentence the employee can act on (and no
# write happens, because every caller resolves the employee id first).
EMPLOYEE_REVOKED_DETAIL = "บัญชีพนักงานของคุณถูกปิดการใช้งานแล้ว กรุณาติดต่อฝ่ายบุคคล"


async def get_verified_line_identity(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> LineIdentity:
    """Identity of the LIFF caller, from `Authorization: Bearer <LINE id_token>`.

    Every failure is fail-closed: a missing/duplicated/oversized/non-ASCII header is 401 without
    ever calling LINE, an unusable verdict from LINE is 503.
    """
    headers = request.headers.getlist("authorization")
    if len(headers) != 1:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=LINE_SESSION_EXPIRED_DETAIL)

    scheme, separator, raw_token = headers[0].partition(" ")
    if not separator or scheme.strip().lower() != "bearer":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=LINE_SESSION_EXPIRED_DETAIL)

    token = raw_token.strip()
    if (
        not token
        or len(token) > MAX_TOKEN_LENGTH
        or not token.isascii()
        or any(char.isspace() for char in token)
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=LINE_SESSION_EXPIRED_DETAIL)

    try:
        return await verify_line_id_token(token, db)
    except LineTokenInvalid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=LINE_SESSION_EXPIRED_DETAIL
        ) from None
    except LineVerificationUnavailable as exc:
        logger.warning("LINE identity check unavailable: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=LINE_CANNOT_VERIFY_DETAIL
        ) from None


async def get_bound_employee(identity: LineIdentity, db: AsyncSession) -> str:
    """`employee_id` of this LINE account's APPROVED binding (task 018 helper, not yet routed).

    Same "newest row wins" rule the status endpoint has always used, so the two can never disagree.
    Refusals are explicit (404 when there is nothing at all, 403 for PENDING/REJECTED/REVOKED) so a
    later check-in endpoint can distinguish "not bound yet" from "was unbound".
    """
    stmt = (
        select(LineBinding.status, LineBinding.employee_id)
        .where(LineBinding.line_user_id == identity.line_user_id)
        .order_by(LineBinding.created_at.desc())
        .limit(1)
    )
    row = (await db.execute(stmt)).first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="ยังไม่พบการผูกบัญชีของ LINE นี้ในระบบ")

    binding_status, employee_id = row
    if binding_status == "APPROVED":
        # The binding is APPROVED but the person may have been deleted or switched off since (task
        # 023). Same three conditions the admin session gate uses, checked before anything is read or
        # written for them.
        local = (await db.execute(
            select(LocalUser.is_active, LocalUser.deprovisioned_at)
            .where(LocalUser.employee_id == employee_id)
        )).first()
        if local is None or not local[0] or local[1] is not None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=EMPLOYEE_REVOKED_DETAIL)
        return employee_id
    if binding_status == "PENDING":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="คำขอผูกบัญชียังอยู่ระหว่างการอนุมัติ")
    if binding_status == "REJECTED":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="คำขอผูกบัญชีนี้ถูกปฏิเสธ กรุณาติดต่อผู้ดูแลระบบ")
    if binding_status == "REVOKED":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="การผูกบัญชีนี้ถูกยกเลิก กรุณาติดต่อผู้ดูแลระบบ")
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="สถานะการผูกบัญชีไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ")
