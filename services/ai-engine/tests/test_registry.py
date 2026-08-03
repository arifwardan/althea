import json
from pathlib import Path

import pytest

from app.runtime.agent import AgentConfig
from app.runtime.errors import AgentNotFoundError
from app.runtime.registry import AgentRegistry


def test_register_and_get(agent: AgentConfig) -> None:
    registry = AgentRegistry()
    registry.register(agent)
    assert registry.get(agent.id) == agent


def test_get_missing_agent_raises() -> None:
    with pytest.raises(AgentNotFoundError):
        AgentRegistry().get("nope")


def test_list_enabled_only(agent: AgentConfig) -> None:
    disabled = agent.model_copy(update={"id": "disabled-agent", "enabled": False})
    registry = AgentRegistry([agent, disabled])
    assert {a.id for a in registry.list()} == {agent.id, disabled.id}
    assert [a.id for a in registry.list(enabled_only=True)] == [agent.id]


def test_from_directory(tmp_path: Path, agent: AgentConfig) -> None:
    (tmp_path / "backend.json").write_text(agent.model_dump_json(), encoding="utf-8")
    registry = AgentRegistry.from_directory(tmp_path)
    assert registry.get(agent.id).name == agent.name
    assert json.loads(registry.dump(agent.id))["id"] == agent.id
