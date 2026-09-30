"""CSV bytes for the attendance export (task 024).

The router owns *which* records go into the file (one shared filter builder with the list endpoint);
this module owns the file itself — headers, row shapes, quoting, the formula-injection guard and the
chunking — so all of it is testable without an HTTP request.

Decisions worth knowing:

* **UTF-8 BOM first.** Without it Excel on Windows reads Thai as mojibake, which is the whole reason
  this export is a CSV and not a plain text dump.
* **Formula injection guard.** Employee names and review notes are user-controlled, so any text cell
  that starts with ``=``, ``+``, ``-``, ``@``, TAB or CR is prefixed with a single quote. Numbers and
  dates we generate ourselves are not touched (a negative number is not user text).
* **`csv` module, not string joins.** ``QUOTE_MINIMAL`` handles commas, double quotes and newlines the
  way every spreadsheet expects, so a note with a line break stays one record.
* **Chunked, one buffer.** `ChunkWriter` keeps a single `StringIO` and returns a chunk every
  `EXPORT_CHUNK_ROWS` rows, so memory is bounded by one chunk regardless of the file size.

Times are Bangkok wall-clock (the same zone the check-in logic uses); dates are `YYYY-MM-DD`.
"""
from __future__ import annotations

import csv
import io
from datetime import date, datetime

from app import checkin_logic as logic
from app.attendance_labels import FLAG_LABEL, LOCATION_LABEL, REVIEW_LABEL, TIME_LABEL

UTF8_BOM = "\ufeff"

#: Hard cap for one download. Over it the request is refused before any row is read.
EXPORT_MAX_ROWS = 50_000

#: Rows per yielded chunk (and therefore the memory bound of one buffer).
EXPORT_CHUNK_ROWS = 500

EXPORT_KINDS = ("detail", "daily")

#: Text prefixes that make a spreadsheet treat a cell as a formula.
FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")

DETAIL_HEADERS = [
    "รหัสพนักงาน",
    "ชื่อ-นามสกุล",
    "แผนก",
    "วันที่",
    "รอบ",
    "เวลาที่ควรลง",
    "เวลาที่ลงจริง",
    "ผลด้านเวลา",
    "ผลด้านตำแหน่ง",
    "ระยะห่าง (เมตร)",
    "รูป",
    "ธง",
    "สถานะตรวจ",
    "ผู้ตรวจ",
    "หมายเหตุการตรวจ",
]

DAILY_HEADERS = [
    "รหัสพนักงาน",
    "ชื่อ-นามสกุล",
    "แผนก",
    "วันที่",
    "จำนวนรอบที่ลง",
    "เวลาลงครั้งแรก",
    "เวลาลงครั้งสุดท้าย",
    "จำนวนครั้งที่สาย",
    "จำนวนรายการที่มีธง",
    "จำนวนรายการที่รอตรวจ",
    "สถานะรวม",
]

OVERALL_COMPLETE = "ครบ"
OVERALL_PENDING = "มีรายการรอตรวจ"
# Only reachable with `include_rejected=true`; the spec's two values do not cover a day whose included
# records are all REJECTED, and calling that "ครบ" would be a lie to payroll.
OVERALL_REJECTED = "มีรายการที่ไม่ยอมรับ"

PHOTO_YES = "มี"
PHOTO_NO = "ไม่มี"


def csv_text(value: str | None) -> str:
    """A user-supplied string that is safe to open in a spreadsheet.

    A cell starting with `=`, `+`, `-`, `@`, TAB or CR is executed as a formula by Excel/Sheets/LibreOffice
    when the file is opened, so it gets a leading single quote — the usual defence, and one the reader
    cannot miss. Empty/None becomes an empty cell.
    """
    text = "" if value is None else str(value)
    if text.startswith(FORMULA_PREFIXES):
        return "'" + text
    return text


def _plain(value: object) -> str:
    """Values the server produced itself (codes, numbers, dates) — never formula-guarded."""
    return "" if value is None else str(value)


def label_of(mapping: dict[str, str], code: str | None) -> str:
    """Thai name for a code; an unknown code is shown as-is rather than hidden."""
    if not code:
        return ""
    return mapping.get(code, code)


def flag_text(flags: list[str] | None) -> str:
    """Thai flag names joined with `, ` (empty string when the record has no flags)."""
    if not flags:
        return ""
    return ", ".join(label_of(FLAG_LABEL, flag) for flag in flags)


def bangkok_time(value: datetime | None) -> str:
    return value.astimezone(logic.BANGKOK_TZ).strftime("%H:%M:%S") if value else ""


def bangkok_clock(value) -> str:
    """A `time` column from the template: already Bangkok wall-clock, no conversion."""
    return value.strftime("%H:%M") if value else ""


def date_text(value: date | None) -> str:
    return value.isoformat() if value else ""


def photo_text(photo_status: str | None) -> str:
    return PHOTO_YES if photo_status == logic.PHOTO_OK else PHOTO_NO


def distance_text(value) -> str:
    """Whole metres, blank when the record has no distance (never `None`, never a float repr)."""
    return _plain(round(float(value))) if value is not None else ""


def detail_row(row, full_name: str | None, department: str | None) -> list[str]:
    """One CSV record for one check-in. `row` is an `AttendanceCheckin`."""
    return [
        csv_text(row.employee_id),
        csv_text(full_name),
        csv_text(department),
        date_text(row.work_date),
        csv_text(row.round_label),
        bangkok_clock(row.expected_time),
        bangkok_time(row.checked_at),
        label_of(TIME_LABEL, row.time_status),
        label_of(LOCATION_LABEL, row.location_status),
        distance_text(row.distance_m),
        photo_text(row.photo_status),
        flag_text(row.flags),
        label_of(REVIEW_LABEL, row.review_status),
        csv_text(row.reviewed_by),
        csv_text(row.review_note),
    ]


def overall_status(count_pending: int, count_rejected: int) -> str:
    if count_pending:
        return OVERALL_PENDING
    if count_rejected:
        return OVERALL_REJECTED
    return OVERALL_COMPLETE


def daily_row(aggregate) -> list[str]:
    """One CSV record for one employee-day.

    `aggregate` is the SELECT in `attendance_router._daily_export_select`: employee_id, full_name,
    department, work_date, rounds, first_at, last_at, late_count, flagged_count, pending_count,
    rejected_count.
    """
    (employee_id, full_name, department, work_date, rounds, first_at, last_at,
     late_count, flagged_count, pending_count, rejected_count) = aggregate
    return [
        csv_text(employee_id),
        csv_text(full_name),
        csv_text(department),
        date_text(work_date),
        _plain(rounds),
        bangkok_time(first_at),
        bangkok_time(last_at),
        _plain(late_count),
        _plain(flagged_count),
        _plain(pending_count),
        overall_status(int(pending_count or 0), int(rejected_count or 0)),
    ]


def filename_for(kind: str, date_from: date | None, date_to: date | None) -> str:
    """ASCII file name (no Thai, no spaces) so every browser and mail client can handle it."""
    return f"attendance-{kind}_{date_text(date_from)}_{date_text(date_to)}.csv"


class ChunkWriter:
    """CSV writer over one reusable buffer.

    `write_row` returns the finished chunk (header-prefixed by the caller) whenever the row budget is
    reached, and `None` otherwise; `flush()` returns whatever is left. One `csv.writer` lives for the
    whole export so its quoting state stays consistent.
    """

    def __init__(self, chunk_rows: int | None = None) -> None:
        self._buffer = io.StringIO()
        self._writer = csv.writer(self._buffer, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
        # Resolved at construction, not as a default argument: `EXPORT_CHUNK_ROWS` must stay tunable at
        # runtime (an operator lowering the cap, or a test proving the chunking), and a default argument
        # would freeze the value at import time.
        self.chunk_rows = max(1, int(EXPORT_CHUNK_ROWS if chunk_rows is None else chunk_rows))
        self._rows_in_chunk = 0

    def write_row(self, values: list[str]) -> str | None:
        self._writer.writerow(values)
        self._rows_in_chunk += 1
        if self._rows_in_chunk >= self.chunk_rows:
            return self._drain()
        return None

    def flush(self) -> str | None:
        if self._rows_in_chunk == 0 and self._buffer.tell() == 0:
            return None
        return self._drain()

    def _drain(self) -> str:
        chunk = self._buffer.getvalue()
        self._buffer.seek(0)
        self._buffer.truncate(0)
        self._rows_in_chunk = 0
        return chunk
