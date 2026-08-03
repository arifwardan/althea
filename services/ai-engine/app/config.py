from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="ALTHEA_AI_",
        extra="ignore",
    )

    app_name: str = "ALTHEA AI Engine"
    ollama_base_url: str = "http://localhost:11434"
    default_model: str = "llama3.1"


@lru_cache
def get_settings() -> Settings:
    return Settings()
