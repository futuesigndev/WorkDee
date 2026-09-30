"""LINE Rich Menu for approved employees (task 025).

Everything that talks to the LINE Messaging API about the employee rich menu lives here, so
`line_router.py` only has to orchestrate: this module knows the menu's shape, the endpoints, the
batching rules and the "never let a LINE failure break a binding change" policy.

Design decisions worth knowing before editing:

* **One menu, one picture, four buttons.** The picture carries all four buttons (2500 × 1686, 2 × 2), and
  **all four are live since task 031** — "ลงเวลา" (`uri` → LIFF `/checkin`), "รอบของฉัน" (`/rounds`),
  "ประวัติการลงเวลา" (`/history`) and "ศูนย์รวมบริการ" (`/portal`, the service hub). **Nothing in the menu is
  a placeholder any more**: no tile sends a `postback`, and the picture carries no "เร็วๆ นี้" tag.
  The `soon:*` answers in the webhook stay because phones keep an older menu until the User republishes —
  see `RETIRED_SOON_POSTBACK_DATA` and `is_soon_postback()`.
* **Never the default menu.** The menu is linked **per user** (`POST /v2/bot/user/{userId}/richmenu/
  {id}` / `richmenu/bulk/link`), so people who have not been approved never see it. There is no call to
  `/v2/bot/user/all/richmenu` anywhere in the project.
* **The picture is part of the repository** (`assets/rich_menu/workdee-employee-menu.png`), with the
  HTML source next to it; nothing is rendered at runtime.
* **A LINE failure is never fatal.** Approving or revoking a binding must succeed even when LINE is
  down or the token is wrong: those helpers swallow the error, log one WARNING with the LINE user id
  masked to its last 4 characters, and report an outcome string that the route puts in its response
  (`menu_status`), exactly the way `push_status` already reports the welcome push.
* **Secrets never leave this module.** The channel access token is read per call and only ever placed
  in an `Authorization` header; no function returns it, and error messages/log lines never contain it.

* **A refusal is never silent and never mislabelled (fix round 1).** Every non-2xx answer from LINE is
  turned into a `RichMenuApiError` that carries LINE's own explanation (`message` + `details[].property`)
  scrubbed of the channel token, user ids and menu ids — the admin card and the log both show it. A
  **400 on create means LINE disliked the body**, never the token, so the wording must not blame the
  token; a body of ours that LINE documents as invalid is refused locally *before* any LINE call, and
  LINE's side-effect-free `validate` endpoint is called before `create`.

Endpoints used (LINE Messaging API reference, read 2026-09-29 and again on 2026-09-30 — see the 025
report for the exact pages): validate `POST {api}/v2/bot/richmenu/validate`, create
`POST {api}/v2/bot/richmenu`, upload image `POST {api-data}/v2/bot/richmenu/{id}/content`, list
`GET {api}/v2/bot/richmenu/list`, delete `DELETE {api}/v2/bot/richmenu/{id}`, per-user link
`POST {api}/v2/bot/user/{userId}/richmenu/{id}`, per-user unlink
`DELETE {api}/v2/bot/user/{userId}/richmenu`, bulk link `POST {api}/v2/bot/richmenu/bulk/link`.
"""
from __future__ import annotations

import asyncio
import logging
import re
import struct
import time
from pathlib import Path

import httpx

from app.config import BACKEND_DIR, settings

logger = logging.getLogger("app.line_richmenu")

# ── The menu's fixed shape ────────────────────────────────────────────────────────────────────────

MENU_NAME = "WorkDee-employee"
CHAT_BAR_TEXT = "เมนูพนักงาน"
MENU_SIZE = {"width": 2500, "height": 1686}
TILE_WIDTH = MENU_SIZE["width"] // 2      # 1250
TILE_HEIGHT = MENU_SIZE["height"] // 2    # 843
AREA_COUNT = 4

# Every tile is a live link since task 031: tile → (label, LIFF path suffix). This table is the one place
# the menu's shape is written down; `build_menu_object()` and `menu_definition_problems()` read it.
LIVE_BUTTON_LABEL = "ลงเวลา"
MY_ROUNDS_BUTTON_LABEL = "รอบของฉัน"
HISTORY_BUTTON_LABEL = "ประวัติการลงเวลา"
PORTAL_BUTTON_LABEL = "ศูนย์รวมบริการ"
CHECKIN_TILE, MY_ROUNDS_TILE, HISTORY_TILE, PORTAL_TILE = 0, 1, 2, 3
LIVE_TILES: tuple[tuple[int, str, str], ...] = (
    (CHECKIN_TILE, LIVE_BUTTON_LABEL, "checkin"),
    (MY_ROUNDS_TILE, MY_ROUNDS_BUTTON_LABEL, "rounds"),
    (HISTORY_TILE, HISTORY_BUTTON_LABEL, "history"),
    (PORTAL_TILE, PORTAL_BUTTON_LABEL, "portal"),
)
SOON_DATA_PREFIX = "soon:"
# **No placeholder tile is left**, so the menu sends no `postback` at all (031). The pair stays — empty —
# as the single place a future placeholder would be switched on (one label + one data value per tile that
# is not in `LIVE_TILES`), and `menu_definition_problems()` refuses a half-filled pair instead of letting it
# reach LINE. `RETIRED_SOON_POSTBACK_DATA` is what phones holding older menus still send.
PLACEHOLDER_LABELS: tuple[str, ...] = ()
SOON_POSTBACK_DATA: tuple[str, ...] = ()
# The three values the menu used to send: `soon:history` (retired in 029), `soon:my-rounds` (030) and
# `soon:portal` (031). The webhook answers **any** `soon:*` data, so those phones keep seeing the Thai
# "coming soon" sentence until the User republishes the menu. Listed here so a test can prove all three.
RETIRED_SOON_POSTBACK_DATA = ("soon:portal", "soon:my-rounds", "soon:history")

# The one Thai sentence every placeholder answers with (webhook reply).
SOON_REPLY_TEXT_TH = "ฟังก์ชันนี้กำลังจะเปิดให้ใช้เร็วๆ นี้ค่ะ/ครับ"

# LINE's own limit for one bulk-link request. The User's OA has far fewer approved employees today,
# but the batching is what makes a 1,203-employee OA work, so it is part of the design, not a nicety.
BULK_LINK_BATCH_SIZE = 500

# ── LINE's documented limits (fix round 1) ────────────────────────────────────────────────────────
# Re-read from the Messaging API reference on 2026-09-30 ("Rich menu structure", "Validate rich menu
# object" and the action objects — see the 025 report for the pages). They are used twice: to check our
# own body *before* any LINE call (`menu_body_problems`) and as the 025 suite's per-constraint
# assertions. Values are drawn from the docs, not guessed.
MENU_NAME_MAX_CHARS = 300
CHAT_BAR_TEXT_MAX_CHARS = 14
MENU_AREA_MAX_COUNT = 20
ACTION_LABEL_MAX_CHARS = 20          # rich menus: the label is optional, but at most 20 characters
POSTBACK_DATA_MAX_CHARS = 300
ACTION_DISPLAY_TEXT_MAX_CHARS = 300  # optional — and when present it must carry text, never ""
ACTION_URI_MAX_CHARS = 1000
URI_SCHEMES = ("http", "https", "line", "tel")
MENU_WIDTH_MIN, MENU_WIDTH_MAX = 800, 2500
MENU_HEIGHT_MIN = 250
MENU_MIN_ASPECT_RATIO = 1.45
# LINE's error text is shown to an admin: one line of it, not a wall.
LINE_ERROR_DETAIL_MAX_CHARS = 300

# LINE allows 1 MB for a rich menu image; the repository picture is ~130 KB.
MENU_IMAGE_MAX_BYTES = 1024 * 1024

IMAGE_DIR = BACKEND_DIR / "app" / "assets" / "rich_menu"
IMAGE_PATH = IMAGE_DIR / "workdee-employee-menu.png"

LINE_TIMEOUT_SECONDS = 10.0

# How long a menu id looked up by name stays good. Short on purpose: a menu can be replaced by a
# publish at any moment, and re-linking one user is rare enough that a lookup is cheap.
MENU_ID_TTL_SECONDS = 60.0

MENU_MISSING_IMAGE_TH = "ไม่พบไฟล์รูปเมนู"
MENU_BAD_IMAGE_TH = "ไฟล์รูปเมนูไม่ถูกต้อง (ต้องเป็น PNG ขนาด 2500 × 1686 และไม่เกิน 1 MB)"


class RichMenuImageError(Exception):
    """The picture on disk cannot be uploaded. The message is Thai and safe to show an admin."""


class RichMenuBodyError(Exception):
    """The menu object breaks a rule LINE documents, so it is not sent at all.

    Raised before any LINE call: a body LINE would refuse costs nothing (creating menus is rate-limited)
    and the admin gets our own words naming the field instead of a bare "400".
    """


class RichMenuApiError(Exception):
    """A LINE call was refused, with LINE's own explanation attached.

    `endpoint` is a fixed name ("create", "bulk-link", …) and **not** the URL: the URL of a per-user
    call carries a LINE user id, and nothing here may contain one. `detail` is LINE's description of
    the refusal, already scrubbed of the channel token, user ids and menu ids (`line_error_detail`).
    """

    def __init__(self, endpoint: str, status: int, detail: str) -> None:
        self.endpoint = endpoint
        self.status = status
        self.detail = detail
        super().__init__(f"{endpoint} → HTTP {status}: {detail}")


# ── HTTP plumbing ─────────────────────────────────────────────────────────────────────────────────

# Set by tests (and by the browser-check harness) to an `httpx.MockTransport` / stub. Production
# leaves it as None, which means "real network".
_transport: httpx.AsyncBaseTransport | None = None


def set_transport(transport: httpx.AsyncBaseTransport | None) -> None:
    """Replace the transport used for every LINE call (tests only)."""
    global _transport
    _transport = transport


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=LINE_TIMEOUT_SECONDS, transport=_transport)


def _api_url(path: str) -> str:
    return f"{settings.LINE_API_BASE.rstrip('/')}{path}"


def _data_api_url(path: str) -> str:
    return f"{settings.LINE_DATA_API_BASE.rstrip('/')}{path}"


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def mask_user_id(line_user_id: str | None) -> str:
    """A LINE user id shortened for a log line: last 4 characters only, never the whole id."""
    if not line_user_id:
        return "(none)"
    return f"…{line_user_id[-4:]}" if len(line_user_id) > 4 else "…"


# Anything that looks like an identifier we may not keep. LINE sometimes echoes part of the request
# in its error text, and that text is logged and shown on the admin card, so it is scrubbed first.
_LINE_USER_ID_RE = re.compile(r"U[0-9a-f]{32}")
_RICH_MENU_ID_RE = re.compile(r"richmenu-[0-9a-fA-F]{8,}")


def _scrub(text: str, *secrets: str | None) -> str:
    """Remove identifiers that must not leave this module (the token, user ids, menu ids)."""
    for secret in secrets:
        if secret:
            text = text.replace(secret, "…")
    return _RICH_MENU_ID_RE.sub("richmenu-…", _LINE_USER_ID_RE.sub("U…", text))


def line_error_detail(response: httpx.Response, *secrets: str | None) -> str:
    """LINE's own words about a refused request, shortened and safe to show.

    LINE answers `{"message": …, "details": [{"message": …, "property": …}]}` (Messaging API
    reference, "Error responses"), which is exactly what an admin needs: without it a 400 on create is
    indistinguishable from an expired token — the gap that made the first real publish undiagnosable.
    Falls back to the bare status when the body is not that JSON.
    """
    body = None
    try:
        parsed = response.json()
        body = parsed if isinstance(parsed, dict) else None
    except Exception:  # noqa: BLE001 — a non-JSON body is a normal case, not a failure
        body = None
    parts: list[str] = []
    if body:
        message = body.get("message")
        if isinstance(message, str) and message.strip():
            parts.append(message.strip())
        details = body.get("details")
        if isinstance(details, list):
            named: list[str] = []
            for item in details[:3]:
                if not isinstance(item, dict):
                    continue
                property_name = item.get("property")
                item_message = item.get("message")
                if property_name and item_message:
                    named.append(f"{property_name}: {item_message}")
                elif item_message:
                    named.append(str(item_message))
                elif property_name:
                    named.append(str(property_name))
            if named:
                parts.append("(" + "; ".join(named) + ")")
    text = " ".join(parts).strip() or f"HTTP {response.status_code}"
    return _scrub(text, *secrets)[:LINE_ERROR_DETAIL_MAX_CHARS]


def _raise_for_line_status(response: httpx.Response, endpoint: str, *secrets: str | None) -> None:
    """`raise_for_status()` that keeps LINE's explanation (and never the token or a user id)."""
    if response.status_code < 400:
        return
    raise RichMenuApiError(endpoint, response.status_code, line_error_detail(response, *secrets))


def safe_error(exc: Exception) -> str:
    """A description of a failed LINE call that is safe to log.

    Deliberately NOT `str(exc)` for httpx errors: httpx puts the whole request URL in its message, and
    for a per-user call that URL contains the LINE user id in full — which must not end up in a log
    file. `RichMenuApiError` is the exception to that rule *because* it never contains a URL, an id or a
    token: its message is LINE's own explanation, which is the whole point of the fix round.
    """
    if isinstance(exc, RichMenuApiError):
        return str(exc)
    if isinstance(exc, httpx.HTTPStatusError):
        return f"{type(exc).__name__} (HTTP {exc.response.status_code})"
    return type(exc).__name__


# ── The menu object ───────────────────────────────────────────────────────────────────────────────


def area_bounds() -> list[tuple[int, int, int, int]]:
    """The four tile bounds in row-major order: (x, y, width, height).

    They tile the canvas exactly — no overlap, no gap — which is what the acceptance test asserts and
    what the picture was drawn against (`assets/rich_menu/workdee-employee-menu.html`).
    """
    return [
        (col * TILE_WIDTH, row * TILE_HEIGHT, TILE_WIDTH, TILE_HEIGHT)
        for row in range(2)
        for col in range(2)
    ]


def tile_uri(liff_id: str, path: str) -> str:
    """The LIFF URL for one live tile: `https://liff.line.me/<LIFF_ID>/<path>`.

    The LIFF app's Endpoint URL stays at the `/liff` prefix (the entry page forwards the path), so the
    value stored in `app_settings.line_liff_id` is all that is needed. The id is stripped: a stray space
    or newline from a copy-pasted setting would make LINE answer `invalid uri` (`areas[N].action.uri`)
    for a reason that has nothing to do with the URI itself.
    """
    return f"https://liff.line.me/{liff_id.strip()}/{path}"


def checkin_uri(liff_id: str) -> str:
    """Where the first live button goes: the LIFF app's check-in screen."""
    return tile_uri(liff_id, "checkin")


def history_uri(liff_id: str) -> str:
    """Where the third live button goes: the LIFF app's "ประวัติการลงเวลา" screen (task 029)."""
    return tile_uri(liff_id, "history")


def rounds_uri(liff_id: str) -> str:
    """Where the second live button goes: the LIFF app's "รอบของฉัน" screen (task 030)."""
    return tile_uri(liff_id, "rounds")


def portal_uri(liff_id: str) -> str:
    """Where the fourth live button goes: the LIFF app's "ศูนย์รวมบริการ" hub (task 031)."""
    return tile_uri(liff_id, "portal")


def placeholder_tiles() -> tuple[int, ...]:
    """The tiles that must still answer with a `postback`: every tile not in `LIVE_TILES`, in canvas order.

    Derived, never written down twice: adding a tile to `LIVE_TILES` removes it from here, and the
    placeholder label/data tuples must then be shortened to match — which `menu_definition_problems()`
    checks. Empty since task 031, because all four tiles are links.
    """
    live = {tile for tile, _label, _path in LIVE_TILES}
    return tuple(tile for tile in range(AREA_COUNT) if tile not in live)


def menu_definition_problems() -> list[str]:
    """Problems in this module's own tile definition — our mistake, not LINE's.

    Separate from `menu_body_problems()` (which checks a *body* against LINE's documented rules) because
    these are caught earlier and cheaper: a half-filled placeholder pair, a tile with two actions or none,
    a duplicated or over-long label, a live path that is not a plain suffix. A placeholder switched on in
    `SOON_POSTBACK_DATA` but not in `PLACEHOLDER_LABELS` is refused here, before anything could be built.
    """
    problems: list[str] = []
    tiles = [tile for tile, _label, _path in LIVE_TILES]
    placeholders = placeholder_tiles()
    if len(PLACEHOLDER_LABELS) != len(placeholders) or len(SOON_POSTBACK_DATA) != len(placeholders):
        problems.append(
            f"placeholder tiles {placeholders} need one label and one postback data each "
            f"(labels={len(PLACEHOLDER_LABELS)}, data={len(SOON_POSTBACK_DATA)})"
        )
    if len(set(tiles)) != len(tiles):
        problems.append(f"a tile carries two live actions: {tiles}")
    if not tiles:
        problems.append("no tile is live at all")
    if sorted(tiles + list(placeholders)) != list(range(AREA_COUNT)):
        problems.append(
            f"the tiles {sorted(tiles + list(placeholders))} must be exactly 0..{AREA_COUNT - 1}"
        )
    labels = [label for _tile, label, _path in LIVE_TILES] + list(PLACEHOLDER_LABELS)
    if len(set(labels)) != len(labels):
        problems.append(f"duplicate button label: {labels}")
    for label in labels:
        if not 1 <= len(label) <= ACTION_LABEL_MAX_CHARS:
            problems.append(f"label {label!r} must be 1..{ACTION_LABEL_MAX_CHARS} characters")
    for path in (path for _tile, _label, path in LIVE_TILES):
        if not path or path.startswith("/") or any(character.isspace() for character in path):
            problems.append(f"live path {path!r} must be a plain suffix without '/' or spaces")
    for data in SOON_POSTBACK_DATA:
        if not data.startswith(SOON_DATA_PREFIX):
            problems.append(f"postback data {data!r} must start with {SOON_DATA_PREFIX!r}")
    return problems


def tile_actions(liff_id: str) -> dict[int, dict]:
    """One action per tile: a `uri` for every live tile plus a `postback` for every placeholder tile."""
    actions: dict[int, dict] = {
        tile: {"type": "uri", "label": label, "uri": tile_uri(liff_id, path)}
        for tile, label, path in LIVE_TILES
    }
    for position, tile in enumerate(placeholder_tiles()):
        if position < len(SOON_POSTBACK_DATA):
            actions[tile] = {"type": "postback", "label": PLACEHOLDER_LABELS[position],
                             "data": SOON_POSTBACK_DATA[position]}
    return actions


def build_menu_object(liff_id: str) -> dict:
    """The rich menu object sent to `POST /v2/bot/richmenu`.

    Four tiles in canvas (row-major) order, and **every one of them is a link to a LIFF page** since task
    031: ลงเวลา → `/checkin`, รอบของฉัน → `/rounds`, ประวัติการลงเวลา → `/history`, ศูนย์รวมบริการ →
    `/portal`. `selected: true` opens the menu as soon as the chat is opened, and `chatBarText` is what the
    bar under the chat says when the menu is closed.
    """
    actions = tile_actions(liff_id)
    areas = []
    for index, (x, y, width, height) in enumerate(area_bounds()):
        action = actions.get(index)
        if action is None:  # pragma: no cover — `menu_definition_problems()` refuses such a definition
            raise RichMenuBodyError(f"areas[{index}]: no action is defined for this tile")
        # **No `displayText` key on a postback at all.** Tapping a placeholder must not put anything in
        # the chat (the reply message is the answer), and `displayText` is a text field: the documented
        # way to send no text is to omit the key. Sending `""` is what the real OA refused with HTTP 400
        # on 2026-09-30 — see fix round 1 in the 025 report. No tile is a placeholder since 031, so this
        # only matters if a placeholder is switched back on.
        areas.append({"bounds": {"x": x, "y": y, "width": width, "height": height},
                      "action": action})
    return {
        "size": dict(MENU_SIZE),
        "selected": True,
        "name": MENU_NAME,
        "chatBarText": CHAT_BAR_TEXT,
        "areas": areas,
    }


# Sentinel for "the key is not in the object at all" — which is not the same as `None` or `""`.
_ABSENT = object()


def _area_problems(index: int, area) -> list[str]:
    """Documented problems of one area object, named the way LINE names them."""
    prefix = f"areas[{index}]"
    if not isinstance(area, dict):
        return [f"{prefix}: must be an object"]
    problems: list[str] = []
    bounds = area.get("bounds")
    if not isinstance(bounds, dict):
        problems.append(f"{prefix}.bounds: must be an object")
    else:
        for name, minimum in (("x", 0), ("y", 0), ("width", 1), ("height", 1)):
            value = bounds.get(name)
            if not isinstance(value, int) or isinstance(value, bool):
                problems.append(f"{prefix}.bounds.{name}: must be an integer")
            elif value < minimum:
                problems.append(f"{prefix}.bounds.{name}: must be {minimum} or higher")
    action = area.get("action")
    if not isinstance(action, dict):
        problems.append(f"{prefix}.action: must be an object")
        return problems
    kind = action.get("type")
    if kind not in ("uri", "postback", "message", "datetimepicker", "richmenuswitch"):
        problems.append(f"{prefix}.action.type: unsupported type {kind!r}")
    if kind in ("postback", "datetimepicker", "richmenuswitch"):
        data = action.get("data")
        if not isinstance(data, str) or not 1 <= len(data) <= POSTBACK_DATA_MAX_CHARS:
            problems.append(f"{prefix}.action.data: must be 1..{POSTBACK_DATA_MAX_CHARS} characters")
    if kind == "postback" and action.get("displayText", _ABSENT) is not _ABSENT:
        display_text = action.get("displayText")
        if not isinstance(display_text, str) or not 1 <= len(display_text) <= ACTION_DISPLAY_TEXT_MAX_CHARS:
            problems.append(
                f"{prefix}.action.displayText: must be a string of 1..{ACTION_DISPLAY_TEXT_MAX_CHARS} "
                "characters — omit the key to send no text"
            )
    if kind == "uri":
        uri = action.get("uri")
        if not isinstance(uri, str) or not 1 <= len(uri) <= ACTION_URI_MAX_CHARS:
            problems.append(f"{prefix}.action.uri: must be 1..{ACTION_URI_MAX_CHARS} characters")
        elif uri != uri.strip() or any(character.isspace() for character in uri):
            problems.append(f"{prefix}.action.uri: must not contain whitespace")
        elif uri.split(":", 1)[0].lower() not in URI_SCHEMES:
            problems.append(f"{prefix}.action.uri: scheme must be one of {', '.join(URI_SCHEMES)}")
    label = action.get("label")
    if label is not None and (not isinstance(label, str) or not 1 <= len(label) <= ACTION_LABEL_MAX_CHARS):
        problems.append(f"{prefix}.action.label: must be 1..{ACTION_LABEL_MAX_CHARS} characters")
    return problems


def menu_body_problems(menu_object: dict) -> list[str]:
    """Every documented rule this menu object breaks — one entry per broken rule, naming the field.

    The rules are LINE's, re-read on 2026-09-30 from the Messaging API reference ("Rich menu
    structure" for the object and `chatBarText` / `name` / `areas`, the action objects for `label`,
    `data`, `displayText` and `uri`). An empty list means "LINE documents no reason to refuse this
    body" — it is not a promise that LINE will accept it, which is what the `validate` call is for.
    """
    problems: list[str] = []

    size = menu_object.get("size") if isinstance(menu_object.get("size"), dict) else {}
    width, height = size.get("width"), size.get("height")
    for name, value in (("size.width", width), ("size.height", height)):
        if not isinstance(value, int) or isinstance(value, bool):
            problems.append(f"{name}: must be an integer")
    if isinstance(width, int) and not isinstance(width, bool):
        if not MENU_WIDTH_MIN <= width <= MENU_WIDTH_MAX:
            problems.append(f"size.width: must be {MENU_WIDTH_MIN}..{MENU_WIDTH_MAX}")
    if isinstance(height, int) and not isinstance(height, bool):
        if height < MENU_HEIGHT_MIN:
            problems.append(f"size.height: must be at least {MENU_HEIGHT_MIN}")
    if (isinstance(width, int) and isinstance(height, int) and not isinstance(width, bool)
            and not isinstance(height, bool) and height > 0
            and width / height < MENU_MIN_ASPECT_RATIO):
        problems.append(f"size: aspect ratio must be at least {MENU_MIN_ASPECT_RATIO}")

    if not isinstance(menu_object.get("selected"), bool):
        problems.append("selected: must be a boolean")

    name = menu_object.get("name")
    if not isinstance(name, str) or not 1 <= len(name) <= MENU_NAME_MAX_CHARS:
        problems.append(f"name: must be 1..{MENU_NAME_MAX_CHARS} characters")

    chat_bar_text = menu_object.get("chatBarText")
    if not isinstance(chat_bar_text, str) or not 1 <= len(chat_bar_text) <= CHAT_BAR_TEXT_MAX_CHARS:
        problems.append(f"chatBarText: must be 1..{CHAT_BAR_TEXT_MAX_CHARS} characters")

    areas = menu_object.get("areas")
    if not isinstance(areas, list) or not 1 <= len(areas) <= MENU_AREA_MAX_COUNT:
        problems.append(f"areas: must be 1..{MENU_AREA_MAX_COUNT} areas")
        return problems  # what is inside cannot be trusted either
    for index, area in enumerate(areas):
        problems.extend(_area_problems(index, area))
    return problems


def assert_menu_body(menu_object: dict) -> None:
    """Local pre-flight: a body that breaks LINE's documented rules is never sent."""
    problems = menu_body_problems(menu_object)
    if problems:
        raise RichMenuBodyError("; ".join(problems))


def read_menu_image(path: Path | None = None) -> bytes:
    """The picture bytes, validated against LINE's requirements before anything is sent.

    Raising here (with a Thai message) means a broken picture is reported to the admin by this app
    instead of as a LINE 400 that leaves a half-created menu behind.
    """
    target = path or IMAGE_PATH
    if not target.is_file():
        raise RichMenuImageError(MENU_MISSING_IMAGE_TH)
    data = target.read_bytes()
    if len(data) > MENU_IMAGE_MAX_BYTES:
        raise RichMenuImageError(MENU_BAD_IMAGE_TH)
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise RichMenuImageError(MENU_BAD_IMAGE_TH)
    width, height = struct.unpack(">II", data[16:24])
    if (width, height) != (MENU_SIZE["width"], MENU_SIZE["height"]):
        raise RichMenuImageError(MENU_BAD_IMAGE_TH)
    return data


# ── LINE calls ────────────────────────────────────────────────────────────────────────────────────


async def list_menus(token: str) -> list[dict]:
    async with _client() as client:
        res = await client.get(_api_url("/v2/bot/richmenu/list"), headers=_auth(token))
        _raise_for_line_status(res, "list", token)
        return list(res.json().get("richmenus") or [])


async def find_menu_ids_by_name(token: str, name: str = MENU_NAME) -> list[str]:
    """Every menu of ours that LINE still knows about, newest last."""
    return [m["richMenuId"] for m in await list_menus(token) if m.get("name") == name]


async def validate_menu(token: str, menu_object: dict) -> None:
    """LINE's side-effect-free check of the menu object, run **before** creating anything.

    `POST /v2/bot/richmenu/validate` answers 200 for a body LINE would accept and 400 with the same
    `message`/`details` shape for one it would refuse, so the real reason for a refusal is available
    without creating (and then having to delete) a menu.
    """
    async with _client() as client:
        res = await client.post(
            _api_url("/v2/bot/richmenu/validate"), headers=_auth(token), json=menu_object
        )
        _raise_for_line_status(res, "validate", token)


async def create_menu(token: str, menu_object: dict) -> str:
    async with _client() as client:
        res = await client.post(_api_url("/v2/bot/richmenu"), headers=_auth(token), json=menu_object)
        _raise_for_line_status(res, "create", token)
        return res.json()["richMenuId"]


async def upload_menu_image(token: str, menu_id: str, image: bytes) -> None:
    async with _client() as client:
        res = await client.post(
            _data_api_url(f"/v2/bot/richmenu/{menu_id}/content"),
            headers={**_auth(token), "Content-Type": "image/png"},
            content=image,
        )
        _raise_for_line_status(res, "upload", token)


async def delete_menu(token: str, menu_id: str) -> None:
    async with _client() as client:
        res = await client.delete(_api_url(f"/v2/bot/richmenu/{menu_id}"), headers=_auth(token))
        _raise_for_line_status(res, "delete", token)


async def bulk_link(token: str, menu_id: str, user_ids: list[str]) -> tuple[int, int]:
    """Link one batch. Returns (linked, failed) — a failed batch is counted and not raised.

    LINE answers 200 for the whole request or fails it as a whole, so a failed batch is reported as
    "these users did not get the menu" rather than pretending it worked; the caller keeps going with the
    next batch, and the admin can repair with another publish.
    """
    try:
        async with _client() as client:
            res = await client.post(
                _api_url("/v2/bot/richmenu/bulk/link"),
                headers=_auth(token),
                json={"richMenuId": menu_id, "userIds": user_ids},
            )
            _raise_for_line_status(res, "bulk-link", token)
        return len(user_ids), 0
    except Exception as exc:  # noqa: BLE001 — any LINE/network failure is a counted failure
        # LINE's own explanation is logged (already scrubbed) but the ids stay out of it.
        logger.warning(
            "LINE rich menu bulk link failed for %d users (menu %s): %s",
            len(user_ids), mask_user_id(menu_id), safe_error(exc),
        )
        return 0, len(user_ids)


async def link_user(token: str, menu_id: str, line_user_id: str) -> None:
    async with _client() as client:
        res = await client.post(
            _api_url(f"/v2/bot/user/{line_user_id}/richmenu/{menu_id}"), headers=_auth(token)
        )
        _raise_for_line_status(res, "link", token)


async def unlink_user(token: str, line_user_id: str) -> None:
    async with _client() as client:
        res = await client.delete(_api_url(f"/v2/bot/user/{line_user_id}/richmenu"), headers=_auth(token))
        _raise_for_line_status(res, "unlink", token)


# ── Messages and profile: the OA's other outbound LINE traffic ────────────────────────────────────
# These live here (instead of building their own `httpx.AsyncClient` in `line_router`) so that *all*
# LINE traffic of this app goes through one injectable client with one timeout. That is what lets the
# test suite — and the browser-check harness — record every request without any of them leaving the
# machine. Behaviour is unchanged: same URLs, same payloads, same 10 s timeout.


async def push_text(token: str, line_user_id: str, text: str) -> None:
    async with _client() as client:
        res = await client.post(
            _api_url("/v2/bot/message/push"),
            headers={**_auth(token), "Content-Type": "application/json"},
            json={"to": line_user_id, "messages": [{"type": "text", "text": text}]},
        )
        res.raise_for_status()


async def get_profile(token: str, line_user_id: str) -> httpx.Response:
    """The user's profile. The response is returned unraised so the caller can tell 404 (not a friend)."""
    async with _client() as client:
        return await client.get(_api_url(f"/v2/bot/profile/{line_user_id}"), headers=_auth(token))


async def reply_text(token: str, reply_token: str, messages: list[dict]) -> None:
    async with _client() as client:
        res = await client.post(
            _api_url("/v2/bot/message/reply"),
            headers={**_auth(token), "Content-Type": "application/json"},
            json={"replyToken": reply_token, "messages": messages},
        )
        res.raise_for_status()


# ── Menu-id cache (per process, ≤ 60 s) ───────────────────────────────────────────────────────────

_menu_id_cache: tuple[str, float] | None = None


def cached_menu_id() -> str | None:
    if _menu_id_cache and _menu_id_cache[1] > time.monotonic():
        return _menu_id_cache[0]
    return None


def remember_menu_id(menu_id: str, ttl: float = MENU_ID_TTL_SECONDS) -> None:
    global _menu_id_cache
    _menu_id_cache = (menu_id, time.monotonic() + ttl)


def forget_menu_id() -> None:
    global _menu_id_cache
    _menu_id_cache = None


def menu_id_suffix(menu_id: str | None) -> str | None:
    """The last 6 characters of a menu id — enough to recognise it, not enough to call the API."""
    return menu_id[-6:] if menu_id else None


async def current_menu_id(token: str, *, allow_lookup: bool = True) -> str | None:
    """Our published menu id: from the cache when it is fresh, otherwise looked up by name.

    A process that has just started does not know what is at LINE, so the lookup is what makes approve
    work after a restart. `allow_lookup=False` (used by the status endpoint) guarantees no LINE traffic
    at all — the admin card must not call LINE just because a page was opened.
    """
    cached = cached_menu_id()
    if cached:
        return cached
    if not allow_lookup:
        return None
    try:
        ids = await find_menu_ids_by_name(token)
    except Exception as exc:  # noqa: BLE001 — a lookup failure means "unknown", not a broken request
        logger.warning("LINE rich menu lookup failed: %s", safe_error(exc))
        return None
    if not ids:
        return None
    remember_menu_id(ids[-1])
    return ids[-1]


# ── Publishing ────────────────────────────────────────────────────────────────────────────────────

# Two admins pressing publish at the same time must not race each other into two menus: the second one
# waits here and then runs a full publish of its own (which is harmless — it replaces the first menu).
_publish_lock = asyncio.Lock()


async def publish(token: str, liff_id: str, user_ids: list[str], image: bytes) -> dict:
    """Create + upload + link + remove the previous menu. Returns the honest counts.

    Order matters and is asserted by the tests: list (find the old one) → validate → create → upload →
    bulk link → delete the old menu. Linking has to happen *before* the old menu is deleted, or the
    employees who were using it would briefly have nothing. The `validate` step sits before `create`
    because it is free of side effects and returns the same error body, so a body LINE refuses cannot
    leave a half-created menu behind (fix round 1).

    Idempotent: publishing twice leaves exactly one `WorkDee-employee` menu, because every same-named
    menu except the new one is deleted at the end.
    """
    async with _publish_lock:
        menu_object = build_menu_object(liff_id)
        # Our own documented-rule check first: it costs nothing and names the field in our words.
        assert_menu_body(menu_object)
        previous_ids = await find_menu_ids_by_name(token)

        # LINE's own check before anything is created — a refusal here creates nothing at LINE.
        await validate_menu(token, menu_object)

        menu_id = await create_menu(token, menu_object)
        await upload_menu_image(token, menu_id, image)

        unique_ids = list(dict.fromkeys(user_ids))  # duplicates collapse; count them as skipped
        linked = failed = 0
        for start in range(0, len(unique_ids), BULK_LINK_BATCH_SIZE):
            batch = unique_ids[start:start + BULK_LINK_BATCH_SIZE]
            batch_linked, batch_failed = await bulk_link(token, menu_id, batch)
            linked += batch_linked
            failed += batch_failed

        for old_id in previous_ids:
            if old_id == menu_id:
                continue
            try:
                await delete_menu(token, old_id)
            except Exception as exc:  # noqa: BLE001 — the new menu is live; an old one left behind is a warning
                logger.warning("LINE rich menu old menu %s could not be deleted: %s",
                               mask_user_id(old_id), safe_error(exc))

        remember_menu_id(menu_id, ttl=float("inf"))
        return {
            "menu_created": True,
            "menu_id": menu_id,
            "linked": linked,
            "failed": failed,
            "skipped": len(user_ids) - len(unique_ids),
        }


# ── Per-binding link / unlink (must never break approve or revoke) ────────────────────────────────


async def ensure_user_link(token: str | None, line_user_id: str) -> str:
    """Give one approved employee the menu.

    Outcome strings (reported as `menu_status`, the same idea as 006's `push_status`):
      "linked"           — LINE accepted the per-user link
      "skipped_no_token" — no channel access token configured
      "skipped_no_menu"  — no `WorkDee-employee` menu exists yet (publish first)
      "failed"           — LINE refused or was unreachable; the caller still succeeds
    """
    if not token:
        return "skipped_no_token"
    menu_id = await current_menu_id(token)
    if not menu_id:
        return "skipped_no_menu"
    try:
        await link_user(token, menu_id, line_user_id)
        return "linked"
    except Exception as exc:  # noqa: BLE001
        logger.warning("LINE rich menu link failed for user %s: %s", mask_user_id(line_user_id), safe_error(exc))
        return "failed"


async def ensure_user_unlink(token: str | None, line_user_id: str) -> str:
    """Take the menu away from one employee ("unlinked" / "skipped_no_token" / "failed")."""
    if not token:
        return "skipped_no_token"
    try:
        await unlink_user(token, line_user_id)
        return "unlinked"
    except Exception as exc:  # noqa: BLE001
        logger.warning("LINE rich menu unlink failed for user %s: %s", mask_user_id(line_user_id), safe_error(exc))
        return "failed"


def is_soon_postback(data: str | None) -> bool:
    """Whether a postback belongs to one of this menu's placeholders (and the webhook should answer)."""
    return bool(data) and data.startswith(SOON_DATA_PREFIX)
