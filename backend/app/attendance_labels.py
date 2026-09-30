"""Thai labels for the attendance export (task 024).

The HR records page has its own TypeScript copies of these maps for on-screen rendering; **this module
is the source of truth for text that leaves the system in a file**, because the file must not depend on
the frontend being up, and a CSV that payroll reads has to be built and tested on the server. The
strings are deliberately identical to the page's — if they ever drift, this file wins and the page is
the one to fix.

Why it lives apart from `checkin_logic.py`: that module decides *what* a check-in means (codes and
verdicts); this one only names them in Thai for people. Keep codes out of it.
"""
from __future__ import annotations

# Time verdict (`checkin_logic.time_status_for`).
TIME_LABEL: dict[str, str] = {
    "ON_TIME": "ตรงเวลา",
    "LATE": "สาย",
    "EARLY_OUT_OF_WINDOW": "ก่อนช่วงเวลา",
    "LATE_OUT_OF_WINDOW": "หลังช่วงเวลา",
}

# Location verdict (`checkin_logic.evaluate_location`).
LOCATION_LABEL: dict[str, str] = {
    "INSIDE": "ในพื้นที่",
    "OUTSIDE": "นอกพื้นที่",
    "UNKNOWN": "ไม่มีตำแหน่ง",
    "NO_LOCATION_ASSIGNED": "ไม่ได้กำหนดสถานที่",
}

# Review status (`checkin_logic.review_status_for` and the HR review actions).
REVIEW_LABEL: dict[str, str] = {
    "CLEAN": "ปกติ",
    "PENDING_REVIEW": "รอตรวจ",
    "ACCEPTED": "ยอมรับแล้ว",
    "REJECTED": "ไม่ยอมรับ",
}

# Every flag code `checkin_logic` can produce (verified against that file, not guessed).
FLAG_LABEL: dict[str, str] = {
    "LATE": "สาย",
    "OUT_OF_WINDOW": "นอกช่วงเวลา",
    "OUTSIDE_RADIUS": "นอกพื้นที่",
    "NO_GPS": "ไม่มีตำแหน่ง",
    "LOW_ACCURACY": "ตำแหน่งไม่แม่นยำ",
    "PHOTO_MISSING": "ไม่มีรูป",
    "NO_LOCATION_ASSIGNED": "ไม่ได้กำหนดสถานที่",
}
