from pathlib import Path

from app.runtime.agent import AgentConfig, LifecycleState
from app.runtime.context import DefaultContextBuilder
from app.runtime.events import EventType, InMemoryEventPublisher
from app.runtime.memory import NullMemory
from app.runtime.permissions import PermissionManager
from app.runtime.prompts import PromptManager
from app.runtime.providers.base import (
    ModelProvider,
    ModelRequest,
    ModelResponse,
    ProviderRegistry,
    TokenUsage,
    ToolCall,
)
from app.runtime.runtime import AgentRuntime
from app.runtime.tools.base import ToolRegistry
from app.runtime.tools.filesystem import ReadFileTool, WriteFileTool


class FakeProvider(ModelProvider):
    name = "fake"

    def __init__(self, responses: list[ModelResponse]) -> None:
        self._responses = list(responses)
        self.requests: list[ModelRequest] = []

    async def generate(self, request: ModelRequest) -> ModelResponse:
        self.requests.append(request)
        return self._responses.pop(0)


def _runtime(
    provider: FakeProvider, tmp_path: Path, events: InMemoryEventPublisher
) -> AgentRuntime:
    memory = NullMemory()
    return AgentRuntime(
        providers=ProviderRegistry({provider.name: provider}),
        tools=ToolRegistry([ReadFileTool(tmp_path), WriteFileTool(tmp_path)]),
        prompt_manager=PromptManager(),
        context_builder=DefaultContextBuilder(memory, project="ALTHEA"),
        memory=memory,
        events=events,
        permissions=PermissionManager(),
    )


async def test_run_without_tools_completes(agent: AgentConfig, tmp_path: Path) -> None:
    provider = FakeProvider(
        [ModelResponse(content="done", usage=TokenUsage(prompt_tokens=10, completion_tokens=5))]
    )
    events = InMemoryEventPublisher()
    runtime = _runtime(provider, tmp_path, events)

    result = await runtime.run(agent, "Say done")

    assert result.succeeded
    assert result.state == LifecycleState.COMPLETED
    assert result.output == "done"
    assert result.usage.total_tokens == 15
    assert result.duration_seconds is not None
    event_types = [e.type for e in events.events]
    assert event_types[0] == EventType.AGENT_STARTED
    assert EventType.PLANNING_STARTED in event_types
    assert EventType.MODEL_INVOKED in event_types
    assert event_types[-1] == EventType.COMPLETED


async def test_run_executes_tool_calls(agent: AgentConfig, tmp_path: Path) -> None:
    provider = FakeProvider(
        [
            ModelResponse(
                content="",
                tool_calls=[
                    ToolCall(
                        id="1",
                        name="write_file",
                        arguments={"path": "out.txt", "content": "hello"},
                    )
                ],
            ),
            ModelResponse(content="file written"),
        ]
    )
    events = InMemoryEventPublisher()
    runtime = _runtime(provider, tmp_path, events)

    result = await runtime.run(agent, "Write hello to out.txt")

    assert result.succeeded
    assert (tmp_path / "out.txt").read_text(encoding="utf-8") == "hello"
    assert len(result.tool_invocations) == 1
    assert result.tool_invocations[0].ok
    assert EventType.TOOL_EXECUTED in [e.type for e in events.events]
    assert len(provider.requests) == 2


async def test_tool_without_permission_fails_tool(agent: AgentConfig, tmp_path: Path) -> None:
    restricted = agent.model_copy(
        update={"permissions": frozenset({"fs:read"})}
    )
    provider = FakeProvider(
        [
            ModelResponse(
                content="",
                tool_calls=[
                    ToolCall(id="1", name="write_file", arguments={"path": "x", "content": "y"})
                ],
            ),
            ModelResponse(content="could not write"),
        ]
    )
    events = InMemoryEventPublisher()
    runtime = _runtime(provider, tmp_path, events)

    result = await runtime.run(restricted, "Write a file")

    assert result.succeeded
    assert not result.tool_invocations[0].ok
    assert "fs:write" in result.tool_invocations[0].error
    assert EventType.TOOL_FAILED in [e.type for e in events.events]
    assert not (tmp_path / "x").exists()


async def test_disabled_agent_fails(agent: AgentConfig, tmp_path: Path) -> None:
    disabled = agent.model_copy(update={"enabled": False})
    events = InMemoryEventPublisher()
    runtime = _runtime(FakeProvider([]), tmp_path, events)

    result = await runtime.run(disabled, "anything")

    assert result.state == LifecycleState.FAILED
    assert "disabled" in result.error
    assert [e.type for e in events.events] == [EventType.FAILED]


async def test_unknown_provider_fails(agent: AgentConfig, tmp_path: Path) -> None:
    other = agent.model_copy(update={"provider": "openai"})
    events = InMemoryEventPublisher()
    runtime = _runtime(FakeProvider([]), tmp_path, events)

    result = await runtime.run(other, "anything")

    assert result.state == LifecycleState.FAILED
    assert "openai" in result.error
    assert EventType.FAILED in [e.type for e in events.events]
