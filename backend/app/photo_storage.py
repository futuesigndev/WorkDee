"""Photo storage for check-in photos (task 020) — storage layer only.

Photo check-in itself is a later task; this module is the one place that knows *where* a photo goes
and *how* it may be read back. The default backend keeps files in a folder taken from the server
setting `PHOTO_STORAGE_DIR` (inside the backend tree by default, later a mounted NAS). A different
backend (e.g. GCS) can be added later by implementing the same small interface — nothing else in the
app talks to the filesystem directly.

Design rules that matter:

* **Keys are server-generated**: `YYYY/MM/DD/<uuid4-hex>.<ext>`, date = the server's Asia/Bangkok
  date at save time. No employee id, no name, no client filename ever appears in a key.
* **Content is decided by magic bytes**, never by the client's declared content type: JPEG, PNG and
  WebP only. No image library, no re-encoding.
* **Failure is a value, not an exception** for `save()`: the caller (a future check-in) must still be
  able to record the check-in and flag the photo as missing. `read()` raises a typed error that the
  HTTP layer turns into the same 404 for "bad key" and "not found", so a probe cannot tell them apart.
* **Nothing here is public**: the folder is never mounted as static files; a photo is only readable
  through the authenticated endpoint, and only for a key that passes the strict pattern check and
  still resolves inside the storage root.
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Protocol

from app.config import (
    DEFAULT_PHOTO_MAX_BYTES,
    DEFAULT_PHOTO_STORAGE_DIR,
    settings,
)

logger = logging.getLogger("app.photo_storage")

# `YYYY/MM/DD/<32 lowercase hex>.<ext>` — the whole key must match, so `..`, backslashes, absolute
# paths, `%2f`, uppercase ids, other extensions and anything else are rejected before touching disk.
KEY_PATTERN = re.compile(r"^\d{4}/\d{2}/\d{2}/[0-9a-f]{32}\.(?:jpg|png|webp)$")
MAX_KEY_LENGTH = 64

JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
RIFF_MAGIC = b"RIFF"
WEBP_MAGIC = b"WEBP"

MEDIA_TYPE_BY_SUFFIX = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
SUFFIX_BY_MEDIA_TYPE = {value: key.lstrip(".") for key, value in MEDIA_TYPE_BY_SUFFIX.items()}

# Reason codes (short, stable, safe to put in a log line or a record).
REASON_EMPTY = "empty"
REASON_TOO_LARGE = "too_large"
REASON_BAD_TYPE = "bad_type"
REASON_STORAGE_UNAVAILABLE = "storage_unavailable"

# Thailand has never had daylight saving, so +07:00 is exact. `zoneinfo` is preferred (it is the
# real database), and it works on the Ubuntu host; Windows dev machines have no tz database and the
# `tzdata` package is not installed, hence the fixed-offset fallback (no new dependency either way).
try:  # pragma: no cover - depends on the machine, not on the code
    from zoneinfo import ZoneInfo

    BANGKOK_TZ: timezone | ZoneInfo = ZoneInfo("Asia/Bangkok")
except Exception:  # noqa: BLE001
    BANGKOK_TZ = timezone(timedelta(hours=7))


@dataclass(frozen=True)
class StoredPhoto:
    """Outcome of a save attempt. `ok=False` carries a reason code — never an exception to the caller."""

    ok: bool
    key: str | None = None
    content_type: str | None = None
    size: int = 0
    reason: str | None = None


@dataclass(frozen=True)
class StorageStatus:
    """Result of `check()` — is the folder usable, and how much room is left."""

    ok: bool
    reason: str | None = None
    free_bytes: int | None = None
    root: str | None = None


class PhotoKeyError(Exception):
    """The key is not a key this storage may serve. The HTTP layer answers 404 for this."""


class PhotoMissingError(PhotoKeyError):
    """The key is well-formed but there is no such file (also 404 — deliberately indistinguishable)."""


class PhotoStorage(Protocol):
    """The interface a future backend (NAS, GCS, …) implements."""

    def save(self, data: bytes, content_type: str | None = None) -> StoredPhoto: ...

    def read(self, key: str) -> tuple[bytes, str]: ...

    def path_for(self, key: str) -> Path: ...

    def exists(self, key: str) -> bool: ...

    def check(self) -> StorageStatus: ...


# ─── helpers ─────────────────────────────────────────────────────────────────────────────────

def detect_type(data: bytes) -> tuple[str, str] | None:
    """(content_type, extension) from the magic bytes, or None when the bytes are not a supported image."""
    if len(data) < 12:
        # still enough for the JPEG check, which only needs 3 bytes
        if data[:3] == JPEG_MAGIC:
            return "image/jpeg", "jpg"
        return None
    if data[:3] == JPEG_MAGIC:
        return "image/jpeg", "jpg"
    if data[:8] == PNG_MAGIC:
        return "image/png", "png"
    if data[:4] == RIFF_MAGIC and data[8:12] == WEBP_MAGIC:
        return "image/webp", "webp"
    return None


def resolve_max_bytes(raw: str | None) -> int:
    """`PHOTO_MAX_BYTES` → int, falling back to the default (with one WARNING) on anything unusable."""
    text = (raw or "").strip()
    if text:
        try:
            value = int(text)
        except (TypeError, ValueError):
            value = None
        if value is not None and value > 0:
            return value
    if not getattr(resolve_max_bytes, "_warned", False):
        resolve_max_bytes._warned = True  # type: ignore[attr-defined]
        logger.warning(
            "PHOTO_MAX_BYTES=%r is not a positive whole number — using the default of %d bytes",
            raw,
            DEFAULT_PHOTO_MAX_BYTES,
        )
    return DEFAULT_PHOTO_MAX_BYTES


def _is_within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _safe_error(exc: BaseException) -> str:
    """A log-safe description: the error kind and its message, which may name the configured root."""
    return f"{type(exc).__name__}: {getattr(exc, 'strerror', None) or exc}"


class LocalDirectoryStorage:
    """Files under one directory. Filesystem work only — no HTTP, no database."""

    def __init__(
        self,
        root: Path | str,
        max_bytes: int = DEFAULT_PHOTO_MAX_BYTES,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.root = Path(root)
        self.max_bytes = max_bytes
        self._now = now or (lambda: datetime.now(BANGKOK_TZ))

    # ── writing ──────────────────────────────────────────────────────────────────────────────

    def new_key(self, extension: str) -> str:
        """`YYYY/MM/DD/<uuid4 hex>.<ext>` for the current Bangkok date."""
        moment = self._now()
        return f"{moment:%Y/%m/%d}/{uuid.uuid4().hex}.{extension}"

    def save(self, data: bytes, content_type: str | None = None) -> StoredPhoto:
        """Validate and store one photo. Never raises: problems come back as `ok=False` + a reason."""
        # `content_type` is accepted for interface parity and deliberately ignored — the bytes decide.
        if not data:
            logger.warning("photo save refused: %s", REASON_EMPTY)
            return StoredPhoto(False, reason=REASON_EMPTY)
        if len(data) > self.max_bytes:
            logger.warning("photo save refused: %s (limit %d bytes)", REASON_TOO_LARGE, self.max_bytes)
            return StoredPhoto(False, reason=REASON_TOO_LARGE)

        detected = detect_type(data)
        if detected is None:
            logger.warning("photo save refused: %s (unsupported magic bytes)", REASON_BAD_TYPE)
            return StoredPhoto(False, reason=REASON_BAD_TYPE)
        media_type, extension = detected

        key = self.new_key(extension)
        target = self.root.joinpath(*key.split("/"))
        temp_path: Path | None = None
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            temp_path = self._write_temp(target.parent, data)
            os.replace(temp_path, target)  # atomic on the same filesystem: a reader never sees half a file
            temp_path = None
        except OSError as exc:
            logger.warning("photo save failed (%s): %s", REASON_STORAGE_UNAVAILABLE, _safe_error(exc))
            if temp_path is not None:
                try:
                    temp_path.unlink(missing_ok=True)
                except OSError:
                    pass
            return StoredPhoto(False, reason=REASON_STORAGE_UNAVAILABLE)

        return StoredPhoto(True, key=key, content_type=media_type, size=len(data))

    def _write_temp(self, folder: Path, data: bytes) -> Path:
        """Write the bytes to a fresh temp file next to the target and return its path.

        Separate from `save()` so a test can make the write itself fail halfway.
        """
        handle_fd, temp_name = tempfile.mkstemp(dir=str(folder), prefix=".tmp-", suffix=".part")
        temp_path = Path(temp_name)
        try:
            with os.fdopen(handle_fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            try:
                os.chmod(temp_path, 0o600)  # owner-only where the OS supports it; ignored on Windows
            except OSError:
                pass
        except OSError:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise
        return temp_path

    # ── reading ──────────────────────────────────────────────────────────────────────────────

    def path_for(self, key: str) -> Path:
        """Resolve one key to the file inside the root, or raise `PhotoKeyError`/`PhotoMissingError`."""
        if not self._key_is_valid(key):
            raise PhotoKeyError(key)
        candidate = self.root.joinpath(*key.split("/"))
        try:
            resolved_root = self.root.resolve()
            resolved = candidate.resolve()  # follows symlinks, so an escape is caught here too
        except OSError as exc:
            raise PhotoKeyError(key) from exc
        if not _is_within(resolved, resolved_root):
            logger.warning("photo key refused: resolves outside the storage root")
            raise PhotoKeyError(key)
        if not resolved.is_file():
            raise PhotoMissingError(key)
        return resolved

    def read(self, key: str) -> tuple[bytes, str]:
        """(bytes, detected content type). Raises a typed error for a bad key or a missing file."""
        path = self.path_for(key)
        try:
            data = path.read_bytes()
        except OSError as exc:
            logger.warning("photo read failed: %s", _safe_error(exc))
            raise PhotoMissingError(key) from exc
        detected = detect_type(data)
        content_type = detected[0] if detected else MEDIA_TYPE_BY_SUFFIX.get(path.suffix.lower(), "application/octet-stream")
        return data, content_type

    def content_type_for(self, path: Path) -> str:
        """Detected type of an already-resolved file (used when streaming it out)."""
        try:
            with path.open("rb") as handle:
                head = handle.read(16)
        except OSError:
            head = b""
        detected = detect_type(head)
        if detected:
            return detected[0]
        return MEDIA_TYPE_BY_SUFFIX.get(path.suffix.lower(), "application/octet-stream")

    def exists(self, key: str) -> bool:
        try:
            self.path_for(key)
        except PhotoKeyError:
            return False
        return True

    @staticmethod
    def _key_is_valid(key: str) -> bool:
        if not isinstance(key, str) or not key or len(key) > MAX_KEY_LENGTH:
            return False
        return KEY_PATTERN.match(key) is not None

    # ── health ───────────────────────────────────────────────────────────────────────────────

    def check(self) -> StorageStatus:
        """Can the root be created and written to? Returns a value; never raises.

        Deliberately logs nothing: the one line about storage belongs to whoever asks (startup calls
        `log_storage_status()`, which logs exactly once), so an unusable folder is reported once and
        not twice.
        """
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            probe = self.root / f".probe-{uuid.uuid4().hex}"
            probe.write_bytes(b"ok")
            probe.unlink()
            free = shutil.disk_usage(self.root).free
        except OSError:
            return StorageStatus(False, reason=REASON_STORAGE_UNAVAILABLE, root=str(self.root))
        return StorageStatus(True, free_bytes=free, root=str(self.root))


# ─── the configured storage ──────────────────────────────────────────────────────────────────

def build_storage(
    root: Path | str | None = None,
    max_bytes: int | None = None,
    now: Callable[[], datetime] | None = None,
) -> LocalDirectoryStorage:
    """Storage for the current settings. Cheap (no filesystem work), so it may be built per request."""
    if not (settings.PHOTO_STORAGE_DIR or "").strip() and not getattr(build_storage, "_warned_dir", False):
        build_storage._warned_dir = True  # type: ignore[attr-defined]
        logger.warning(
            "PHOTO_STORAGE_DIR is empty — using the default %r under the backend folder",
            DEFAULT_PHOTO_STORAGE_DIR,
        )
    return LocalDirectoryStorage(
        root=root if root is not None else settings.photo_storage_dir,
        max_bytes=max_bytes if max_bytes is not None else resolve_max_bytes(settings.PHOTO_MAX_BYTES),
        now=now,
    )


def check_configured_storage() -> StorageStatus:
    """`check()` for the configured folder, guaranteed not to raise (startup calls this)."""
    try:
        return build_storage().check()
    except Exception as exc:  # noqa: BLE001 - startup must never fail because of storage
        logger.warning("photo storage check failed: %s", _safe_error(exc))
        return StorageStatus(False, reason=REASON_STORAGE_UNAVAILABLE)


def log_storage_status() -> StorageStatus:
    """Log exactly one line about the configured photo storage (INFO when usable, WARNING when not)."""
    status = check_configured_storage()
    if status.ok:
        free_mb = (status.free_bytes or 0) / (1024 * 1024)
        logger.info("photo storage ready at %s (%.1f MB free)", status.root, free_mb)
    else:
        logger.warning(
            "photo storage is NOT usable at %s (%s) — the app continues to start; check-ins will be "
            "recorded without a photo until this is fixed",
            settings.photo_storage_dir,
            status.reason,
        )
    return status
