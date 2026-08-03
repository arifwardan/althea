import pytest

from app.runtime.agent import AgentConfig


@pytest.fixture
def agent() -> AgentConfig:
    return AgentConfig(
        id="backend-engineer",
        name="Backend Engineer",
        department="engineering",
        role="Backend Engineer",
        objective="Implement backend features",
        system_prompt="You are a precise backend engineer.",
        available_tools=("read_file", "write_file"),
        permissions=frozenset({"fs:read", "fs:write"}),
        memory_scope="engineering",
        model="test-model",
        provider="fake",
    )
