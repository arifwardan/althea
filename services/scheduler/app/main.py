import asyncio
import logging
import signal
import sys
import time

import structlog
from redis.asyncio import Redis

from app.config import Settings, get_settings

logging.basicConfig(format="%(message)s", stream=sys.stdout, level=logging.INFO)
logger = structlog.get_logger(__name__)


async def run(settings: Settings) -> None:
    redis = Redis.from_url(settings.redis_url, decode_responses=True)
    stop = asyncio.Event()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    logger.info("scheduler started", interval=settings.heartbeat_interval_seconds)
    try:
        while not stop.is_set():
            await redis.set(settings.heartbeat_key, str(time.time()))
            try:
                await asyncio.wait_for(
                    stop.wait(), timeout=settings.heartbeat_interval_seconds
                )
            except TimeoutError:
                pass
    finally:
        await redis.aclose()
        logger.info("scheduler stopped")


def main() -> None:
    asyncio.run(run(get_settings()))


if __name__ == "__main__":
    main()
