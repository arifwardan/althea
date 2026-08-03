from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Protocol

from pydantic import BaseModel, Field

from app.logging import get_logger


class EventType(StrEnum):
    AGENT_STARTED = "agent_started"
    PLANNING_STARTED = "planning_started"
    MODEL_INVOKED = "model_invoked"
    TOOL_EXECUTED = "tool_executed"
    TOOL_FAILED = "tool_failed"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class AgentEvent(BaseModel):
    type: EventType
    execution_id: str
    agent_id: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    payload: dict[str, Any] = Field(default_factory=dict)


class EventPublisher(Protocol):
    async def publish(self, event: AgentEvent) -> None: ...


EventHandler = Callable[[AgentEvent], Awaitable[None]]


class InMemoryEventPublisher:
    """Collects events and fans them out to subscribed handlers."""

    def __init__(self) -> None:
        self._events: list[AgentEvent] = []
        self._handlers: list[EventHandler] = []

    @property
    def events(self) -> tuple[AgentEvent, ...]:
        return tuple(self._events)

    def subscribe(self, handler: EventHandler) -> None:
        self._handlers.append(handler)

    async def publish(self, event: AgentEvent) -> None:
        self._events.append(event)
        for handler in self._handlers:
            await handler(event)


class LoggingEventPublisher:
    """Emits every event as a structured log line."""

    def __init__(self) -> None:
        self._logger = get_logger("agent.events")

    async def publish(self, event: AgentEvent) -> None:
        self._logger.info(
            event.type.value,
            execution_id=event.execution_id,
            agent_id=event.agent_id,
            **event.payload,
        )
