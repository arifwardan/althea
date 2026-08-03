from app.runtime.agent import AgentConfig
from app.runtime.context import ExecutionContext
from app.runtime.memory import MemoryRecord
from app.runtime.prompts import PromptManager
from app.runtime.providers.base import ToolSpec


def test_compose_includes_all_sections(agent: AgentConfig) -> None:
    manager = PromptManager(developer_prompt="Follow team style.", output_format="markdown")
    context = ExecutionContext(
        task="Implement the health endpoint",
        project="ALTHEA",
        issue="ALT-42",
        recent_history=["created service"],
        relevant_memory=[MemoryRecord(key="k", content="we use FastAPI")],
    )
    tools = [ToolSpec(name="read_file", description="Read a file")]

    messages = manager.compose(agent, context, tools)

    assert messages[0].role == "system"
    assert "Backend Engineer" in messages[0].content
    assert any(m.role == "developer" for m in messages)
    joined = "\n".join(m.content for m in messages)
    assert "ALT-42" in joined
    assert "we use FastAPI" in joined
    assert "read_file" in joined
    assert "markdown" in joined
    assert messages[-1].role == "user"
    assert messages[-1].content == "Implement the health endpoint"


def test_compose_minimal_sections(agent: AgentConfig) -> None:
    manager = PromptManager()
    context = ExecutionContext(task="Say hello")

    messages = manager.compose(agent, context, [])

    roles = [m.role for m in messages]
    assert roles == ["system", "user"]
