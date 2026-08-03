from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field

from app.runtime.agent import LifecycleState
from app.runtime.providers.base import TokenUsage


class ToolInvocation(BaseModel):
    tool: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    ok: bool
    output: str = ""
    error: str = ""


class ExecutionResult(BaseModel):
    """Structured outcome of a single agent execution."""

    execution_id: str
    agent_id: str
    state: LifecycleState
    output: str = ""
    error: str = ""
    model: str = ""
    usage: TokenUsage = Field(default_factory=TokenUsage)
    tool_invocations: list[ToolInvocation] = Field(default_factory=list)
    started_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    finished_at: datetime | None = None

    @property
    def duration_seconds(self) -> float | None:
        if self.finished_at is None:
            return None
        return (self.finished_at - self.started_at).total_seconds()

    @property
    def succeeded(self) -> bool:
        return self.state == LifecycleState.COMPLETED
