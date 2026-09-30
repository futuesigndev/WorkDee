import os
from pathlib import Path
from typing import List
from pydantic_settings import BaseSettings, SettingsConfigDict

# Get the directory of this file
current_dir = os.path.dirname(os.path.abspath(__file__))
# Base project directory (where .env and seed.py are)
project_root = os.path.dirname(current_dir)
env_file_path = os.path.join(project_root, ".env")

# The backend folder itself — a relative PHOTO_STORAGE_DIR is resolved against this, never against the
# process working directory (the service may be started from anywhere).
BACKEND_DIR = Path(project_root)
DEFAULT_PHOTO_STORAGE_DIR = "storage/checkin_photos"
DEFAULT_PHOTO_MAX_BYTES = 5 * 1024 * 1024

# Values that count as "on" for the boolean-ish flags below. Anything else is off.
TRUTHY_FLAG_VALUES = {"1", "true", "yes", "on", "t", "y"}

# One sign-in may not last longer than this many minutes (task 028). Kept as a module constant so a
# junk value in `.env` degrades to the documented default instead of stopping the app from starting.
DEFAULT_SESSION_MAX_AGE_MINUTES = 60


def flag_is_on(value: str | None) -> bool:
    """True only for an explicit yes (case-insensitive); anything else is off."""
    return isinstance(value, str) and value.strip().lower() in TRUTHY_FLAG_VALUES


class Settings(BaseSettings):
    APP_NAME: str = "WorkDee"
    DATABASE_URL: str
    REDIS_URL: str
    CORE_API_URL: str
    CORE_API_KEY: str
    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    LINE_CHANNEL_ACCESS_TOKEN: str | None = None
    LINE_CHANNEL_SECRET: str | None = None
    LINE_LIFF_ID: str | None = None

    # ── LINE Messaging API hosts (task 025) ───────────────────────────────────
    # The rich menu code talks to two LINE hosts: the normal API host and the data host used when a
    # large body (the menu picture) is uploaded. They are declared here — instead of being hard-coded —
    # for the same reason CORE_API_URL is: a test or a stub can point them at a local server without
    # touching the code. Production leaves them at LINE's real hosts.
    LINE_API_BASE: str = "https://api.line.me"
    LINE_DATA_API_BASE: str = "https://api-data.line.me"

    # CORS — รับเป็น string คั่นด้วย comma แล้วแปลงเป็น list
    CORS_ORIGINS: str = "http://localhost:3019,http://127.0.0.1:3019"

    # Cookie Security
    COOKIE_SECURE: bool = False       # False = dev (HTTP), True = prod (HTTPS)
    COOKIE_SAMESITE: str = "lax"

    # Environment name — "development" locally, "production" when deployed.
    # Informational only: since the 2026-09-29 local-tunnel cleanup no code path branches on it.
    APP_ENV: str = "development"

    # Token TTL (วินาที)
    ACCESS_TOKEN_EXPIRE_SECONDS: int = 900       # 15 นาที
    REFRESH_TOKEN_EXPIRE_SECONDS: int = 604800   # 7 วัน

    # ── Session lifetime rules (task 028) ─────────────────────────────────────
    # The User's rule (2026-09-30): one sign-in is renewed silently at most `SESSION_MAX_RENEWALS`
    # times and never survives longer than `SESSION_MAX_AGE_MINUTES` — after either of those the
    # session really ends and the person signs in again (his arithmetic: 15 min × (1 + 3) = 60 min).
    # These two numbers are the only knobs; changing one here is the whole change.
    # NOTE (028): Core-API's real access-token life was measured at 1800 s, not the 900 s this app
    # assumes (see 028-report.md §1). The cap is therefore stated in minutes, so it cannot silently
    # stretch when that constant is corrected later.
    SESSION_MAX_RENEWALS: int = 3
    SESSION_MAX_AGE_MINUTES: int = DEFAULT_SESSION_MAX_AGE_MINUTES

    # ── Security / operations flags (task 019) ────────────────────────────────
    # Kept as strings (not bool) on purpose: pydantic rejects anything it cannot parse as a bool,
    # which would make a typo in .env stop the app from starting. Instead only the values below
    # count as "on" and every other string (typo, empty, "no", junk) is treated as OFF — the safe
    # default for both flags. See `.env.example`.
    ENABLE_API_DOCS: str = "false"   # /docs, /redoc, /openapi.json — off unless explicitly enabled
    SQL_ECHO: str = "false"          # echo every SQL statement to the log — off outside debugging

    # ── Photo storage (task 020) ───────────────────────────────────────────────
    # Both are infrastructure settings for the server, NOT editable from the admin UI.
    # PHOTO_STORAGE_DIR is a folder path; on Ubuntu this may be a mounted NAS path. A relative value
    # is resolved against the backend folder (see BACKEND_DIR), so the default lives inside the app.
    # PHOTO_MAX_BYTES is declared as a string on purpose: a bad value must degrade to the default with
    # one warning instead of stopping the app from starting (see photo_storage.resolve_max_bytes).
    PHOTO_STORAGE_DIR: str = DEFAULT_PHOTO_STORAGE_DIR
    PHOTO_MAX_BYTES: str = str(DEFAULT_PHOTO_MAX_BYTES)

    @property
    def session_max_renewals(self) -> int:
        """How many silent renewals one sign-in gets (task 028). A negative value means zero."""
        return max(0, self.SESSION_MAX_RENEWALS)

    @property
    def session_max_age_seconds(self) -> int:
        """Hard cap on one sign-in, in seconds (task 028). A junk/zero value means the default."""
        minutes = (
            self.SESSION_MAX_AGE_MINUTES
            if self.SESSION_MAX_AGE_MINUTES > 0
            else DEFAULT_SESSION_MAX_AGE_MINUTES
        )
        return minutes * 60

    @property
    def access_cookie_max_age_seconds(self) -> int:
        """How long the access *cookie* lives — the token inside still expires on its own (task 028).

        This is the task-023 finding: `max_age` used to equal the token's own life, so an idle browser
        dropped the cookie before `/auth/refresh` could read it and the 7-day refresh token was
        unreachable. The cookie now lives for the whole session cap, and never longer than the refresh
        token itself.
        """
        return min(self.session_max_age_seconds, self.REFRESH_TOKEN_EXPIRE_SECONDS)

    @property
    def photo_storage_dir(self) -> Path:
        """Absolute storage folder. An empty setting falls back to the default (with a warning log)."""
        raw = (self.PHOTO_STORAGE_DIR or "").strip()
        path = Path(raw).expanduser() if raw else Path(DEFAULT_PHOTO_STORAGE_DIR)
        return path if path.is_absolute() else BACKEND_DIR / path

    @property
    def api_docs_enabled(self) -> bool:
        """Whether FastAPI serves /docs, /redoc and /openapi.json."""
        return flag_is_on(self.ENABLE_API_DOCS)

    @property
    def sql_echo_enabled(self) -> bool:
        """Whether the SQLAlchemy engine logs every statement it runs."""
        return flag_is_on(self.SQL_ECHO)

    @property
    def cors_origins_list(self) -> List[str]:
        """แปลง CORS_ORIGINS string เป็น list"""
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]

    # extra="ignore": keys that live in .env but are not declared above (e.g. the ORACLE_* block,
    # which belongs to a separate integration) must not stop the app from starting — pydantic-settings
    # treats undeclared dotenv keys as fields and raises "Extra inputs are not permitted" otherwise.
    model_config = SettingsConfigDict(env_file=env_file_path, env_file_encoding='utf-8', extra="ignore")

settings = Settings()
