import os
from typing import List
from pydantic_settings import BaseSettings, SettingsConfigDict

# Get the directory of this file
current_dir = os.path.dirname(os.path.abspath(__file__))
# Base project directory (where .env and seed.py are)
project_root = os.path.dirname(current_dir)
env_file_path = os.path.join(project_root, ".env")

class Settings(BaseSettings):
    APP_NAME: str = "FutureSign Multi-App"
    DATABASE_URL: str
    REDIS_URL: str
    CORE_API_URL: str
    CORE_API_KEY: str
    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    LINE_CHANNEL_ACCESS_TOKEN: str | None = None
    LINE_CHANNEL_SECRET: str | None = None
    LINE_LIFF_ID: str | None = None

    # CORS — รับเป็น string คั่นด้วย comma แล้วแปลงเป็น list
    CORS_ORIGINS: str = "http://localhost:3012,http://127.0.0.1:3012"

    # Cookie Security
    COOKIE_SECURE: bool = False       # False = dev (HTTP), True = prod (HTTPS)
    COOKIE_SAMESITE: str = "lax"

    # Environment name. "development" keeps local-tunnel conveniences enabled (currently the
    # ngrok-skip-browser-warning response header); any other value turns them off.
    APP_ENV: str = "development"

    # Token TTL (วินาที)
    ACCESS_TOKEN_EXPIRE_SECONDS: int = 900       # 15 นาที
    REFRESH_TOKEN_EXPIRE_SECONDS: int = 604800   # 7 วัน

    @property
    def cors_origins_list(self) -> List[str]:
        """แปลง CORS_ORIGINS string เป็น list"""
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]

    model_config = SettingsConfigDict(env_file=env_file_path, env_file_encoding='utf-8')

settings = Settings()
