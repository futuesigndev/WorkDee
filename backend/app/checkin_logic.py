"""Check-in decision rules (task 021) — pure functions, no database, no HTTP.

Kept apart from the router on purpose: this is the part that says whether a check-in is on time, where
it happened and what HR should look at, and it must be testable with an injected clock and no I/O.

The guiding rule is "flag, never block": **every** conclusion here is a status or a flag on a record
that still gets written. The only refusals live in the router (not bound, no template, round already
done, garbage input) because an unrecordable combination is the only thing worth refusing.

Times are Bangkok wall-clock. The server clock is the only clock: nothing the phone sends about time
is accepted, and no conversion of round times happens (task 014 stores them as `time`).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from decimal import Decimal
from typing import Iterable, Sequence

from app.photo_storage import BANGKOK_TZ

# Reason codes / statuses (short, stable strings — the DB column values).
ON_TIME = "ON_TIME"
LATE = "LATE"
EARLY_OUT_OF_WINDOW = "EARLY_OUT_OF_WINDOW"
LATE_OUT_OF_WINDOW = "LATE_OUT_OF_WINDOW"

GPS_OK, GPS_NOT_SENT, GPS_INVALID = "OK", "NOT_SENT", "INVALID"
LOC_INSIDE, LOC_OUTSIDE, LOC_UNKNOWN, LOC_NONE = "INSIDE", "OUTSIDE", "UNKNOWN", "NO_LOCATION_ASSIGNED"

PHOTO_OK = "OK"
PHOTO_NOT_REQUIRED = "NOT_REQUIRED_NOT_SENT"
PHOTO_MISSING_NOT_SENT = "MISSING_NOT_SENT"
PHOTO_MISSING_REJECTED = "MISSING_REJECTED"
PHOTO_MISSING_STORAGE = "MISSING_STORAGE"

FLAG_LATE = "LATE"
FLAG_OUT_OF_WINDOW = "OUT_OF_WINDOW"
FLAG_OUTSIDE_RADIUS = "OUTSIDE_RADIUS"
FLAG_NO_GPS = "NO_GPS"
FLAG_LOW_ACCURACY = "LOW_ACCURACY"
FLAG_NO_LOCATION = "NO_LOCATION_ASSIGNED"
FLAG_PHOTO_MISSING = "PHOTO_MISSING"

REVIEW_CLEAN, REVIEW_PENDING = "CLEAN", "PENDING_REVIEW"
# Reserved for the later HR review task; nothing in this task ever sets them.
REVIEW_ACCEPTED, REVIEW_REJECTED = "ACCEPTED", "REJECTED"

# An accuracy worse than this is worth a look, even when the coordinates are inside the radius.
LOW_ACCURACY_M = 100.0
EARTH_RADIUS_M = 6371008.8  # IUGG mean radius, the value the spec asks for


# ─── time ─────────────────────────────────────────────────────────────────────────────────────

def bangkok_now(now: datetime | None = None) -> datetime:
    """Server time in Asia/Bangkok. A naive datetime is treated as UTC (never as local wall clock)."""
    if now is None:
        return datetime.now(BANGKOK_TZ)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(BANGKOK_TZ)


def work_date_for(now: datetime | None = None) -> date:
    """The Bangkok date a check-in belongs to (a record made at 00:30 Bangkok is that day's)."""
    return bangkok_now(now).date()


def _minutes(value: time) -> int:
    return value.hour * 60 + value.minute


def inside_window(round_row, now_local: datetime) -> bool:
    """`window_start <= now <= window_end` — both ends inclusive (task 014 rounds never span midnight)."""
    now_minutes = now_local.hour * 60 + now_local.minute
    return _minutes(round_row.window_start) <= now_minutes <= _minutes(round_row.window_end)


def time_status_for(round_row, grace_minutes: int, now_local: datetime) -> str:
    """Inside the window: on time up to `expected_time + grace` (inclusive), else late.

    Outside it: which side of the window the check-in landed on. Both are recorded, never refused.
    """
    now_minutes = now_local.hour * 60 + now_local.minute
    start = _minutes(round_row.window_start)
    end = _minutes(round_row.window_end)
    if now_minutes < start:
        return EARLY_OUT_OF_WINDOW
    if now_minutes > end:
        return LATE_OUT_OF_WINDOW
    if now_minutes <= _minutes(round_row.expected_time) + max(0, grace_minutes):
        return ON_TIME
    return LATE


def select_round(rounds: Sequence, done_round_ids: Iterable, now_local: datetime):
    """(round, out_of_window) for this moment, or (None, False) when every round is already done.

    Order of preference:
      1. a not-yet-done round whose window contains now (014 forbids overlapping windows, so there is
         at most one);
      2. otherwise the not-yet-done round with the nearest `expected_time` (ties → the earlier round),
         flagged `out_of_window` so the caller records the out-of-window status too.
    """
    done = {str(value) for value in done_round_ids}
    remaining = [row for row in rounds if str(row.id) not in done]
    if not remaining:
        return None, False

    now_minutes = now_local.hour * 60 + now_local.minute
    for row in remaining:
        if inside_window(row, now_local):
            return row, False

    def distance_to_expected(row) -> tuple[int, int]:
        return abs(_minutes(row.expected_time) - now_minutes), _minutes(row.expected_time)

    return min(remaining, key=distance_to_expected), True


# ─── location ────────────────────────────────────────────────────────────────────────────────

def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres (no dependency; earth radius 6371008.8 m)."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


@dataclass(frozen=True)
class GpsReading:
    """What the phone sent about its position, after strict parsing."""

    status: str
    lat: float | None = None
    lng: float | None = None
    accuracy_m: float | None = None

    @property
    def usable(self) -> bool:
        return self.status == GPS_OK


def _parse_float(raw) -> float | None:
    """Strict: a real number or a numeric string. Rejects blanks, text, NaN and infinities."""
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float, Decimal)):
        value = float(raw)
    else:
        text = str(raw).strip()
        if not text:
            return None
        try:
            value = float(text)
        except ValueError:
            return None
    if math.isnan(value) or math.isinf(value):
        return None
    return value


def parse_gps(lat_raw, lng_raw, accuracy_raw) -> GpsReading:
    """Turn the form fields into a reading.

    * both coordinates absent → `NOT_SENT` (the employee chose "continue without location")
    * present but not usable or out of range (|lat| > 90, |lng| > 180) → `INVALID` (treated like no GPS)
    * accuracy `<= 0` or unparsable → treated as not sent (it is not evidence of anything)
    """
    lat, lng = _parse_float(lat_raw), _parse_float(lng_raw)
    accuracy = _parse_float(accuracy_raw)
    if accuracy is not None and accuracy <= 0:
        accuracy = None

    if lat is None and lng is None:
        return GpsReading(GPS_NOT_SENT, None, None, accuracy)
    if lat is None or lng is None:
        return GpsReading(GPS_INVALID, None, None, accuracy)
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lng <= 180.0):
        return GpsReading(GPS_INVALID, None, None, accuracy)
    return GpsReading(GPS_OK, lat, lng, accuracy)


@dataclass(frozen=True)
class LocationVerdict:
    """Where the check-in happened relative to the locations HR assigned."""

    gps_status: str
    location_status: str
    matched_location_id: str | None = None
    matched_location_name: str | None = None
    distance_m: float | None = None
    low_accuracy: bool = False


def evaluate_location(reading: GpsReading, allowed: Sequence) -> LocationVerdict:
    """Compare the reading with the allowed locations.

    `allowed` are rows from `attendance_locations` (already filtered by the caller to the ones this
    employee may use today). A location that is assigned but later deactivated still counts — HR
    assigned it, and this task does not second-guess that. No allowed location at all is not an error:
    it is a status (`NO_LOCATION_ASSIGNED`) so the record still exists. Distances use the coordinates
    as sent (the GPS accuracy never changes the coordinates verdict, it only adds a flag).
    """
    if not allowed:
        return LocationVerdict(reading.status, LOC_NONE)
    if not reading.usable:
        return LocationVerdict(reading.status, LOC_UNKNOWN)

    nearest, nearest_m = None, None
    for row in allowed:
        meters = haversine_m(reading.lat, reading.lng, float(row.latitude), float(row.longitude))
        if nearest_m is None or meters < nearest_m:
            nearest, nearest_m = row, meters

    radius = float(nearest.radius_meters)
    status = LOC_INSIDE if nearest_m <= radius else LOC_OUTSIDE
    low_accuracy = reading.accuracy_m is not None and (
        reading.accuracy_m > LOW_ACCURACY_M or reading.accuracy_m > radius
    )
    return LocationVerdict(
        gps_status=reading.status,
        location_status=status,
        matched_location_id=str(nearest.id),
        matched_location_name=nearest.name,
        distance_m=nearest_m,
        low_accuracy=low_accuracy,
    )


# ─── photo ───────────────────────────────────────────────────────────────────────────────────

def photo_outcome(photo_required: bool, sent: bool, save_ok: bool, save_reason: str | None) -> str:
    """The photo status. Nothing here ever fails the check-in — it is recorded as missing."""
    if not sent:
        return PHOTO_MISSING_NOT_SENT if photo_required else PHOTO_NOT_REQUIRED
    if save_ok:
        return PHOTO_OK
    if save_reason == "storage_unavailable":
        return PHOTO_MISSING_STORAGE
    return PHOTO_MISSING_REJECTED


# ─── the whole verdict ───────────────────────────────────────────────────────────────────────

def build_flags(
    time_status: str,
    location: LocationVerdict,
    photo_status: str,
) -> list[str]:
    """Short codes HR can filter on. Only real problems appear; a clean check-in has none."""
    flags: list[str] = []
    if time_status == LATE:
        flags.append(FLAG_LATE)
    elif time_status in (EARLY_OUT_OF_WINDOW, LATE_OUT_OF_WINDOW):
        flags.append(FLAG_OUT_OF_WINDOW)
    if location.location_status == LOC_OUTSIDE:
        flags.append(FLAG_OUTSIDE_RADIUS)
    if location.gps_status in (GPS_NOT_SENT, GPS_INVALID):
        flags.append(FLAG_NO_GPS)
    if location.location_status == LOC_NONE:
        flags.append(FLAG_NO_LOCATION)
    if location.low_accuracy:
        flags.append(FLAG_LOW_ACCURACY)
    if photo_status in (PHOTO_MISSING_NOT_SENT, PHOTO_MISSING_REJECTED, PHOTO_MISSING_STORAGE):
        flags.append(FLAG_PHOTO_MISSING)
    return flags


def review_status_for(flags: Sequence[str]) -> str:
    return REVIEW_PENDING if flags else REVIEW_CLEAN


_TIME_STATUS_TH = {
    ON_TIME: "ตรงเวลา",
    LATE: "สาย",
    EARLY_OUT_OF_WINDOW: "เร็วกว่าช่วงที่กำหนด",
    LATE_OUT_OF_WINDOW: "ช้ากว่าช่วงที่กำหนด",
}


def _needs_hr_review(time_status: str, location: LocationVerdict, photo_status: str) -> bool:
    """True when the record carries at least one flag — i.e. HR has something to look at (021/022)."""
    if time_status != ON_TIME:
        return True
    if location.location_status in (LOC_OUTSIDE, LOC_NONE):
        return True
    if location.gps_status in (GPS_NOT_SENT, GPS_INVALID):
        return True
    return photo_status not in (PHOTO_OK, PHOTO_NOT_REQUIRED)


def employee_message_th(
    checked_at_local: datetime,
    time_status: str,
    location: LocationVerdict,
    photo_status: str,
) -> str:
    """One short, kind Thai sentence for the employee. Never blames, never scolds.

    It answers **what happened** ("saved at 08:45, HR will look at it") and deliberately *not* why: the
    result card prints the reasons right underneath, in the employee's own words (`FLAG_TH` in the LIFF
    page), and naming them here as well showed every flagged reason twice — which reads like two separate
    problems rather than one (task 026). Wording only: which flags a record has is decided elsewhere.
    """
    stamp = f"{checked_at_local:%H:%M}"
    message = f"บันทึกเวลา {stamp} แล้ว"
    if not _needs_hr_review(time_status, location, photo_status):
        return f"{message} ตรงเวลา"
    return f"{message} ฝ่ายบุคคลจะตรวจสอบให้"
