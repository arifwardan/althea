from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="ALTHEA_",
        extra="ignore",
    )

    app_name: str = "ALTHEA API"
    environment: Literal["development", "staging", "production"] = "development"
    debug: bool = False
    api_v1_prefix: str = "/api/v1"

    database_url: str = "postgresql+asyncpg://althea:althea@localhost:5432/althea"
    database_echo: bool = False

    redis_url: str = "redis://localhost:6379/0"

    log_level: str = "INFO"
    log_json: bool = True

    cors_origins: list[str] = ["http://localhost:3000", "tauri://localhost"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
