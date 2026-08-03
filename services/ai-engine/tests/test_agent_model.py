import pytest

from app.runtime.agent import AgentConfig, Lifecycle, LifecycleState
from app.runtime.errors import InvalidStateTransitionError


def test_agent_config_roundtrip(agent: AgentConfig) -> None:
    payload = agent.model_dump_json()
    restored = AgentConfig.model_validate_json(payload)
    assert restored == agent


def test_agent_permissions(agent: AgentConfig) -> None:
    assert agent.has_permission("fs:read")
    assert not agent.has_permission("terminal:execute")


def test_lifecycle_happy_path() -> None:
    lifecycle = Lifecycle()
    for state in (
        LifecycleState.IDLE,
        LifecycleState.PLANNING,
        LifecycleState.EXECUTING,
        LifecycleState.WAITING,
        LifecycleState.EXECUTING,
        LifecycleState.REVIEWING,
        LifecycleState.COMPLETED,
    ):
        lifecycle.transition(state)
    assert lifecycle.is_terminal
    assert lifecycle.history[0] == LifecycleState.CREATED


def test_lifecycle_rejects_invalid_transition() -> None:
    lifecycle = Lifecycle()
    with pytest.raises(InvalidStateTransitionError):
        lifecycle.transition(LifecycleState.EXECUTING)


def test_lifecycle_terminal_states_have_no_exits() -> None:
    lifecycle = Lifecycle(LifecycleState.COMPLETED)
    with pytest.raises(InvalidStateTransitionError):
        lifecycle.transition(LifecycleState.IDLE)
