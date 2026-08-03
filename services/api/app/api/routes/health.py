from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import text

from app.api.deps import DbSessionDep, RedisDep, SettingsDep
from app.core.logging import get_logger

router = APIRouter(tags=["health"])
logger = get_logger(__name__)


class HealthResponse(BaseModel):
    status: Literal["ok"]
    environment: str
    version: str


class ReadinessResponse(BaseModel):
    status: Literal["ready", "degraded"]
    database: bool
    redis: bool


@router.get("/health", response_model=HealthResponse)
async def health(settings: SettingsDep) -> HealthResponse:
    return HealthResponse(status="ok", environment=settings.environment, version="0.1.0")


@router.get("/ready", response_model=ReadinessResponse)
async def ready(db: DbSessionDep, redis: RedisDep) -> ReadinessResponse:
    database_ok = False
    redis_ok = False

    try:
        await db.execute(text("SELECT 1"))
        database_ok = True
    except Exception:
        logger.exception("database readiness check failed")

    try:
        await redis.ping()
        redis_ok = True
    except Exception:
        logger.exception("redis readiness check failed")

    status: Literal["ready", "degraded"] = "ready" if database_ok and redis_ok else "degraded"
    return ReadinessResponse(status=status, database=database_ok, redis=redis_ok)
