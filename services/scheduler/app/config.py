from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="ALTHEA_SCHEDULER_",
        extra="ignore",
    )

    redis_url: str = "redis://localhost:6379/0"
    heartbeat_interval_seconds: float = 30.0
    heartbeat_key: str = "althea:scheduler:heartbeat"


@lru_cache
def get_settings() -> Settings:
    return Settings()
