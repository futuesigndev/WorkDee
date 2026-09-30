"""Server-side session records for the WorkDee admin session (task 028).

Redis holds three small records per signed-in employee — the store the app already used for the refresh
token (`docs/SYSTEM_SPEC_MultiApp_Webapp_Template_v1_4.md` §3.1):

| key | meaning |
|---|---|
| `<employee_id>:refresh_token` | the **current** refresh token; the revocation gate (task 023, unchanged name) |
| `<employee_id>:session_meta`  | `renewals` + `started_at` — the 60-minute / 3-renewal cap (task 028) |
| `<employee_id>:refresh_fingerprints` | set of every token fingerprint this session has used (for exact cleanup) |
| `refresh_owner:<sha256>`      | reverse index: refresh token → employee id (task 028) |
| `refresh_prev:<sha256>`       | a token this session rotated away from seconds ago (two tabs) |
| `refresh_renewed:<sha256>`    | this token already consumed its renewal (exactly one per token) |

**Why the reverse index exists.** `/auth/refresh` used to read the employee id from the *access-token
cookie's* `sub` claim without verifying its signature (Core-API is the only validator, and WorkDee has
no signing key). A forged cookie could therefore aim the route at somebody else's Redis entry, and the
mismatch branch then **deleted** that entry — i.e. it signed the victim out (denial of service, proven
in `.scratch/probe028_subtrust_before.txt`). Now the refresh token itself is the lookup key and the
employee id comes from **our own record**; the cookie's claim is only a consistency check.

**Never store a token inside a key name.** Keys use `sha256(token)` so a Redis key dump (or a log that
prints keys) never contains a usable credential. Tokens live only as values, exactly as before.

The clock: `started_at` is a Unix timestamp written once at login and never refreshed, so the age cap
is absolute — an idle browser that comes back late cannot stretch the session.
"""
from __future__ import annotations

import hashlib
import time

from app.config import settings
from app.redis_client import refresh_token_key

# How long "the token we just rotated away from" is remembered. Long enough for the second tab of the
# same browser to be told "already renewed" instead of being treated as an error, short enough that a
# replayed old token is not handed anything (it gets a 200 with no cookies — nothing at all).
REFRESH_GRACE_SECONDS = 15

SESSION_META_SUFFIX = "session_meta"
REFRESH_FINGERPRINTS_SUFFIX = "refresh_fingerprints"
REFRESH_OWNER_PREFIX = "refresh_owner:"
ROTATED_FROM_PREFIX = "refresh_prev:"
RENEWED_PREFIX = "refresh_renewed:"


def token_fingerprint(token: str) -> str:
    """SHA-256 of a token — the only form of a token that may appear in a key name."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def session_meta_key(employee_id: str) -> str:
    return f"{employee_id}:{SESSION_META_SUFFIX}"


def fingerprints_key(employee_id: str) -> str:
    """The set of token fingerprints this session has used during its life.

    Needed because a rotation leaves the *old* reverse-index entry behind: without a list of them,
    `end_session` could only drop the entry of the current token and the rest would linger until their
    7-day TTL (harmless — they resolve to a session with no stored token — but not clean).
    """
    return f"{employee_id}:{REFRESH_FINGERPRINTS_SUFFIX}"


def refresh_owner_key(token: str) -> str:
    """Reverse index entry: which employee owns this refresh token."""
    return f"{REFRESH_OWNER_PREFIX}{token_fingerprint(token)}"


def rotated_from_key(token: str) -> str:
    """Short-lived marker for a refresh token that was rotated away from moments ago."""
    return f"{ROTATED_FROM_PREFIX}{token_fingerprint(token)}"


def renewed_key(token: str) -> str:
    """Marker meaning "this exact token already consumed one renewal"."""
    return f"{RENEWED_PREFIX}{token_fingerprint(token)}"


# ─── the session's life: login, renewal, rotation, end ───────────────────────────────────────────


async def start_session(redis, employee_id: str, refresh_token: str) -> None:
    """Record a brand-new session (called by `/auth/login`, after Core-API accepted the password).

    Resets the renewal counter, so signing in again always starts from a full 3 renewals.
    """
    await redis.set(refresh_token_key(employee_id), refresh_token, ex=settings.REFRESH_TOKEN_EXPIRE_SECONDS)
    meta_key = session_meta_key(employee_id)
    await redis.hset(meta_key, mapping={"renewals": 0, "started_at": int(time.time())})
    # The TTL is the session cap and is never extended by a renewal: the cap is absolute.
    await redis.expire(meta_key, settings.session_max_age_seconds)
    await redis.set(
        refresh_owner_key(refresh_token), employee_id, ex=settings.REFRESH_TOKEN_EXPIRE_SECONDS
    )
    await redis.sadd(fingerprints_key(employee_id), token_fingerprint(refresh_token))
    await redis.expire(fingerprints_key(employee_id), settings.REFRESH_TOKEN_EXPIRE_SECONDS)


async def owner_of_token(redis, refresh_token: str) -> str | None:
    """Which employee this refresh token belongs to, according to our own record.

    This is the **only** identity source `/auth/refresh` uses (task 028). `None` means we know nothing
    about this token: the session may be over, or the browser may already have rotated it.
    """
    return await redis.get(refresh_owner_key(refresh_token))


async def was_just_rotated(redis, refresh_token: str) -> str | None:
    """The employee whose session rotated this token away moments ago — the two-tab case.

    A token that was rotated away is not a valid credential any more; knowing that it *was* ours just
    tells us the caller is the same browser asking twice, so the honest answer is "you are already
    renewed" rather than an error.
    """
    return await redis.get(rotated_from_key(refresh_token))


async def session_state(redis, employee_id: str) -> dict | None:
    """`{"renewals": int, "started_at": int}` for a recorded session, or None when there is no record.

    `None` (no record) is treated by the caller as "fail closed": a session that predates task 028, or
    one whose record already expired, cannot be renewed — the person signs in again and gets a record.
    """
    raw = await redis.hgetall(session_meta_key(employee_id))
    if not raw:
        return None
    try:
        return {"renewals": int(raw.get("renewals", 0)), "started_at": int(raw.get("started_at", 0))}
    except (TypeError, ValueError):
        return None


async def register_renewal(redis, employee_id: str, refresh_token: str) -> int | None:
    """Consume one renewal for **this issued token** and return the new count.

    Two guards, both atomic in Redis:

    * `SET ... NX` on a key that belongs to this token is the "once per token" claim, so two tabs
      refreshing at the same instant consume **one** renewal between them (acceptance criterion A4)
      instead of two — the second tab finds the marker already written.
    * `HINCRBY` is what makes the counter itself race-free.

    `None` means there is no session record at all (fail closed).
    """
    meta_key = session_meta_key(employee_id)
    if not await redis.exists(meta_key):
        return None
    claim = await redis.set(renewed_key(refresh_token), employee_id, nx=True,
                            ex=settings.session_max_age_seconds)
    if not claim:
        return int(await redis.hget(meta_key, "renewals") or 0)
    return int(await redis.hincrby(meta_key, "renewals", 1))


async def rotate_session(redis, employee_id: str, old_token: str, new_token: str) -> None:
    """Store the rotated pair (Core-API issues a new refresh token on every use).

    Keeps the renewal counter untouched — a rotation is not a new sign-in.
    """
    await redis.set(refresh_token_key(employee_id), new_token, ex=settings.REFRESH_TOKEN_EXPIRE_SECONDS)
    await redis.set(
        refresh_owner_key(new_token), employee_id, ex=settings.REFRESH_TOKEN_EXPIRE_SECONDS
    )
    if old_token and old_token != new_token:
        await redis.set(rotated_from_key(old_token), employee_id, ex=REFRESH_GRACE_SECONDS)
        await redis.delete(refresh_owner_key(old_token))
        # The old fingerprint stays in the set on purpose: `end_session` uses that set to remove the
        # rotation markers and renewal claims of every token this session ever held. The set is tiny
        # (one entry per renewal — at most four with the default cap) and shares the 7-day TTL.
        await redis.sadd(fingerprints_key(employee_id), token_fingerprint(new_token))
        await redis.expire(fingerprints_key(employee_id), settings.REFRESH_TOKEN_EXPIRE_SECONDS)


async def end_session(redis, employee_id: str) -> None:
    """Remove every server-side record of this employee's session (logout, revoked user, cap hit).

    The forward key and the session meta are the security-relevant pair; the reverse-index entries and
    the rotation markers are cleaned up too, using the session's own fingerprint set, so nothing of the
    session is left behind.
    """
    current = await redis.get(refresh_token_key(employee_id))
    await redis.delete(refresh_token_key(employee_id), session_meta_key(employee_id))
    fingerprints = set(await redis.smembers(fingerprints_key(employee_id)))
    if current:
        fingerprints.add(token_fingerprint(current))
    for fingerprint in fingerprints:
        await redis.delete(
            f"{REFRESH_OWNER_PREFIX}{fingerprint}",
            f"{ROTATED_FROM_PREFIX}{fingerprint}",
            f"{RENEWED_PREFIX}{fingerprint}",
        )
    await redis.delete(fingerprints_key(employee_id))
