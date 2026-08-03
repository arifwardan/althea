from app.runtime.agent import AgentConfig
from app.runtime.context import ExecutionContext
from app.runtime.providers.base import ModelMessage, ToolSpec


class PromptManager:
    """Composes the message list sent to the model from modular sections."""

    def __init__(self, developer_prompt: str = "", output_format: str = "") -> None:
        self._developer_prompt = developer_prompt
        self._output_format = output_format

    def compose(
        self,
        agent: AgentConfig,
        context: ExecutionContext,
        tools: list[ToolSpec],
    ) -> list[ModelMessage]:
        messages = [ModelMessage(role="system", content=self._system_section(agent))]

        if self._developer_prompt:
            messages.append(
                ModelMessage(role="developer", content=self._developer_prompt)
            )

        context_section = self._context_section(context)
        if context_section:
            messages.append(ModelMessage(role="system", content=context_section))

        memory_section = self._memory_section(context)
        if memory_section:
            messages.append(ModelMessage(role="system", content=memory_section))

        if tools:
            messages.append(
                ModelMessage(role="system", content=self._tools_section(tools))
            )

        if self._output_format:
            messages.append(
                ModelMessage(
                    role="system", content=f"Output format:\n{self._output_format}"
                )
            )

        messages.append(ModelMessage(role="user", content=self._task_section(context)))
        return messages

    @staticmethod
    def _system_section(agent: AgentConfig) -> str:
        lines = [agent.system_prompt] if agent.system_prompt else []
        identity = [
            f"You are {agent.name}." if agent.name else "",
            f"Role: {agent.role}" if agent.role else "",
            f"Department: {agent.department}" if agent.department else "",
            f"Objective: {agent.objective}" if agent.objective else "",
        ]
        lines.extend(part for part in identity if part)
        return "\n".join(lines)

    @staticmethod
    def _context_section(context: ExecutionContext) -> str:
        parts = []
        if context.project:
            parts.append(f"Project: {context.project}")
        if context.workspace:
            parts.append(f"Workspace: {context.workspace}")
        if context.issue:
            parts.append(f"Issue: {context.issue}")
        if context.artifacts:
            parts.append("Artifacts:\n" + "\n".join(f"- {a}" for a in context.artifacts))
        if context.recent_history:
            parts.append(
                "Recent history:\n" + "\n".join(f"- {h}" for h in context.recent_history)
            )
        return "\n".join(parts)

    @staticmethod
    def _memory_section(context: ExecutionContext) -> str:
        if not context.relevant_memory:
            return ""
        entries = "\n".join(f"- {m.content}" for m in context.relevant_memory)
        return f"Relevant memory:\n{entries}"

    @staticmethod
    def _tools_section(tools: list[ToolSpec]) -> str:
        entries = "\n".join(f"- {t.name}: {t.description}" for t in tools)
        return f"Available tools:\n{entries}"

    @staticmethod
    def _task_section(context: ExecutionContext) -> str:
        return context.task
