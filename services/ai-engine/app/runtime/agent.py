from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from app.runtime.errors import InvalidStateTransitionError


class AgentStatus(StrEnum):
    ACTIVE = "active"
    DISABLED = "disabled"
    ARCHIVED = "archived"


class LifecycleState(StrEnum):
    CREATED = "created"
    IDLE = "idle"
    PLANNING = "planning"
    EXECUTING = "executing"
    WAITING = "waiting"
    REVIEWING = "reviewing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


_TERMINAL_STATES = frozenset(
    {LifecycleState.COMPLETED, LifecycleState.FAILED, LifecycleState.CANCELLED}
)

_ALLOWED_TRANSITIONS: dict[LifecycleState, frozenset[LifecycleState]] = {
    LifecycleState.CREATED: frozenset(
        {LifecycleState.IDLE, LifecycleState.FAILED, LifecycleState.CANCELLED}
    ),
    LifecycleState.IDLE: frozenset(
        {LifecycleState.PLANNING, LifecycleState.CANCELLED}
    ),
    LifecycleState.PLANNING: frozenset(
        {LifecycleState.EXECUTING, LifecycleState.FAILED, LifecycleState.CANCELLED}
    ),
    LifecycleState.EXECUTING: frozenset(
        {
            LifecycleState.WAITING,
            LifecycleState.REVIEWING,
            LifecycleState.FAILED,
            LifecycleState.CANCELLED,
        }
    ),
    LifecycleState.WAITING: frozenset(
        {LifecycleState.EXECUTING, LifecycleState.FAILED, LifecycleState.CANCELLED}
    ),
    LifecycleState.REVIEWING: frozenset(
        {
            LifecycleState.EXECUTING,
            LifecycleState.COMPLETED,
            LifecycleState.FAILED,
            LifecycleState.CANCELLED,
        }
    ),
    LifecycleState.COMPLETED: frozenset(),
    LifecycleState.FAILED: frozenset(),
    LifecycleState.CANCELLED: frozenset(),
}


class Lifecycle:
    """Explicit state machine for a single agent execution."""

    def __init__(self, initial: LifecycleState = LifecycleState.CREATED) -> None:
        self._state = initial
        self._history: list[LifecycleState] = [initial]

    @property
    def state(self) -> LifecycleState:
        return self._state

    @property
    def history(self) -> tuple[LifecycleState, ...]:
        return tuple(self._history)

    @property
    def is_terminal(self) -> bool:
        return self._state in _TERMINAL_STATES

    def can_transition(self, target: LifecycleState) -> bool:
        return target in _ALLOWED_TRANSITIONS[self._state]

    def transition(self, target: LifecycleState) -> LifecycleState:
        if not self.can_transition(target):
            raise InvalidStateTransitionError(self._state.value, target.value)
        self._state = target
        self._history.append(target)
        return target


class AgentConfig(BaseModel):
    """Serializable agent definition. Configuration only — no behavior."""

    model_config = ConfigDict(frozen=True)

    id: str
    name: str
    description: str = ""
    department: str = ""
    role: str = ""
    objective: str = ""
    system_prompt: str = ""
    available_tools: tuple[str, ...] = ()
    available_workflows: tuple[str, ...] = ()
    memory_scope: str = ""
    permissions: frozenset[str] = Field(default_factory=frozenset)
    model: str = "llama3.1"
    provider: str = "ollama"
    temperature: float = 0.2
    max_tokens: int = 4096
    enabled: bool = True
    status: AgentStatus = AgentStatus.ACTIVE

    def has_permission(self, permission: str) -> bool:
        return permission in self.permissions
