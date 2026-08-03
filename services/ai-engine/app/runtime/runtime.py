import json
import time
from datetime import UTC, datetime
from uuid import uuid4

from app.logging import get_logger
from app.runtime.agent import AgentConfig, Lifecycle, LifecycleState
from app.runtime.context import ContextBuilder
from app.runtime.errors import AgentRuntimeError
from app.runtime.events import AgentEvent, EventPublisher, EventType
from app.runtime.memory import Memory, MemoryRecord
from app.runtime.permissions import PermissionManager
from app.runtime.prompts import PromptManager
from app.runtime.providers.base import (
    ModelMessage,
    ModelProvider,
    ModelRequest,
    ModelResponse,
    ProviderRegistry,
    TokenUsage,
    ToolCall,
)
from app.runtime.results import ExecutionResult, ToolInvocation
from app.runtime.tools.base import ToolRegistry, ToolResult


class AgentRuntime:
    """Generic execution engine for any agent configuration.

    Contains orchestration mechanics only — never business logic. All
    collaborators are injected so each can be substituted independently.
    """

    def __init__(
        self,
        providers: ProviderRegistry,
        tools: ToolRegistry,
        prompt_manager: PromptManager,
        context_builder: ContextBuilder,
        memory: Memory,
        events: EventPublisher,
        permissions: PermissionManager,
        *,
        max_iterations: int = 8,
    ) -> None:
        self._providers = providers
        self._tools = tools
        self._prompts = prompt_manager
        self._context_builder = context_builder
        self._memory = memory
        self._events = events
        self._permissions = permissions
        self._max_iterations = max_iterations
        self._logger = get_logger("agent.runtime")

    async def run(self, agent: AgentConfig, task: str) -> ExecutionResult:
        execution_id = uuid4().hex
        lifecycle = Lifecycle()
        result = ExecutionResult(
            execution_id=execution_id,
            agent_id=agent.id,
            state=lifecycle.state,
            model=agent.model,
        )
        logger = self._logger.bind(execution_id=execution_id, agent_id=agent.id)
        started = time.monotonic()

        if not agent.enabled:
            return await self._fail(result, lifecycle, "agent is disabled", started)

        lifecycle.transition(LifecycleState.IDLE)
        await self._publish(EventType.AGENT_STARTED, result, {"task": task})

        try:
            lifecycle.transition(LifecycleState.PLANNING)
            result.state = lifecycle.state
            await self._publish(EventType.PLANNING_STARTED, result, {})

            context = await self._context_builder.build(agent, task)
            tool_specs = self._tools.specs(agent.available_tools)
            messages = self._prompts.compose(agent, context, tool_specs)
            provider = self._providers.get(agent.provider)

            lifecycle.transition(LifecycleState.EXECUTING)
            result.state = lifecycle.state

            response = await self._invoke_model(agent, provider, messages, result)

            iterations = 0
            while response.tool_calls and iterations < self._max_iterations:
                iterations += 1
                messages.append(
                    ModelMessage(role="assistant", content=response.content or "")
                )
                for call in response.tool_calls:
                    tool_result = await self._execute_tool(agent, call, result)
                    messages.append(
                        ModelMessage(
                            role="tool",
                            content=json.dumps(tool_result.model_dump(exclude={"metadata"})),
                            tool_call_id=call.id,
                        )
                    )
                lifecycle.transition(LifecycleState.WAITING)
                lifecycle.transition(LifecycleState.EXECUTING)
                response = await self._invoke_model(agent, provider, messages, result)

            lifecycle.transition(LifecycleState.REVIEWING)
            result.state = lifecycle.state

            result.output = response.content
            if agent.memory_scope:
                await self._memory.remember(
                    agent.memory_scope,
                    MemoryRecord(
                        key=execution_id,
                        content=f"task: {task}\noutcome: {response.content}",
                    ),
                )
            lifecycle.transition(LifecycleState.COMPLETED)
            result.state = lifecycle.state
            self._finish(result)
            await self._publish(
                EventType.COMPLETED,
                result,
                {"duration_seconds": result.duration_seconds},
            )
            logger.info(
                "execution completed",
                duration_seconds=time.monotonic() - started,
                model=agent.model,
                prompt_tokens=result.usage.prompt_tokens,
                completion_tokens=result.usage.completion_tokens,
                tool_invocations=len(result.tool_invocations),
            )
            return result
        except AgentRuntimeError as exc:
            return await self._fail(result, lifecycle, str(exc), started)

    async def _invoke_model(
        self,
        agent: AgentConfig,
        provider: ModelProvider,
        messages: list[ModelMessage],
        result: ExecutionResult,
    ) -> ModelResponse:
        request = ModelRequest(
            model=agent.model,
            messages=list(messages),
            tools=self._tools.specs(agent.available_tools),
            temperature=agent.temperature,
            max_tokens=agent.max_tokens,
        )
        response = await provider.generate(request)
        result.usage = _accumulate_usage(result.usage, response.usage)
        await self._publish(
            EventType.MODEL_INVOKED,
            result,
            {
                "model": agent.model,
                "prompt_tokens": response.usage.prompt_tokens,
                "completion_tokens": response.usage.completion_tokens,
                "tool_calls": len(response.tool_calls),
            },
        )
        return response

    async def _execute_tool(
        self, agent: AgentConfig, call: ToolCall, result: ExecutionResult
    ) -> ToolResult:
        try:
            tool = self._tools.get(call.name)
            self._permissions.check_tool(agent, tool)
            tool_result = await tool.run(call.arguments)
        except AgentRuntimeError as exc:
            tool_result = ToolResult(ok=False, error=str(exc))

        result.tool_invocations.append(
            ToolInvocation(
                tool=call.name,
                arguments=call.arguments,
                ok=tool_result.ok,
                output=tool_result.output,
                error=tool_result.error,
            )
        )
        event = EventType.TOOL_EXECUTED if tool_result.ok else EventType.TOOL_FAILED
        await self._publish(
            event, result, {"tool": call.name, "error": tool_result.error}
        )
        return tool_result

    async def _fail(
        self,
        result: ExecutionResult,
        lifecycle: Lifecycle,
        error: str,
        started: float,
    ) -> ExecutionResult:
        if not lifecycle.is_terminal:
            lifecycle.transition(LifecycleState.FAILED)
        result.state = LifecycleState.FAILED
        result.error = error
        self._finish(result)
        await self._publish(EventType.FAILED, result, {"error": error})
        self._logger.error(
            "execution failed",
            execution_id=result.execution_id,
            agent_id=result.agent_id,
            error=error,
            duration_seconds=time.monotonic() - started,
        )
        return result

    @staticmethod
    def _finish(result: ExecutionResult) -> None:
        result.finished_at = datetime.now(UTC)

    async def _publish(
        self, event_type: EventType, result: ExecutionResult, payload: dict[str, object]
    ) -> None:
        await self._events.publish(
            AgentEvent(
                type=event_type,
                execution_id=result.execution_id,
                agent_id=result.agent_id,
                payload={k: v for k, v in payload.items() if v is not None},
            )
        )


def _accumulate_usage(current: TokenUsage, new: TokenUsage) -> TokenUsage:
    return TokenUsage(
        prompt_tokens=_add(current.prompt_tokens, new.prompt_tokens),
        completion_tokens=_add(current.completion_tokens, new.completion_tokens),
    )


def _add(a: int | None, b: int | None) -> int | None:
    if a is None and b is None:
        return None
    return (a or 0) + (b or 0)
