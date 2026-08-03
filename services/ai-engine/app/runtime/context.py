from typing import Protocol

from pydantic import BaseModel, Field

from app.runtime.agent import AgentConfig
from app.runtime.memory import Memory, MemoryRecord


class ExecutionContext(BaseModel):
    """Everything an agent execution can see, assembled before the first model call."""

    task: str
    project: str = ""
    workspace: str = ""
    issue: str = ""
    artifacts: list[str] = Field(default_factory=list)
    recent_history: list[str] = Field(default_factory=list)
    relevant_memory: list[MemoryRecord] = Field(default_factory=list)


class ContextBuilder(Protocol):
    async def build(self, agent: AgentConfig, task: str) -> ExecutionContext: ...


class DefaultContextBuilder:
    """Assembles context from statically provided sources plus agent memory.

    Project/issue/artifact lookups will be wired to services/api in a later
    milestone; the shape of ExecutionContext is the stable contract.
    """

    def __init__(
        self,
        memory: Memory,
        *,
        project: str = "",
        workspace: str = "",
        issue: str = "",
        artifacts: list[str] | None = None,
        recent_history: list[str] | None = None,
    ) -> None:
        self._memory = memory
        self._project = project
        self._workspace = workspace
        self._issue = issue
        self._artifacts = list(artifacts or [])
        self._recent_history = list(recent_history or [])

    async def build(self, agent: AgentConfig, task: str) -> ExecutionContext:
        relevant_memory: list[MemoryRecord] = []
        if agent.memory_scope:
            relevant_memory = await self._memory.search(agent.memory_scope, task)

        return ExecutionContext(
            task=task,
            project=self._project,
            workspace=self._workspace,
            issue=self._issue,
            artifacts=self._artifacts,
            recent_history=self._recent_history,
            relevant_memory=relevant_memory,
        )
