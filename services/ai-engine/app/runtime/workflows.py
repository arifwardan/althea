from typing import Any, Protocol

from pydantic import BaseModel, Field


class WorkflowResult(BaseModel):
    ok: bool
    output: str = ""
    error: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


class WorkflowExecutor(Protocol):
    """Abstraction over workflow execution. Concrete workflows are a later milestone."""

    async def execute(
        self, workflow_name: str, inputs: dict[str, Any]
    ) -> WorkflowResult: ...


class NullWorkflowExecutor:
    """Executor used until real workflows exist; rejects every workflow explicitly."""

    async def execute(self, workflow_name: str, inputs: dict[str, Any]) -> WorkflowResult:
        return WorkflowResult(ok=False, error=f"workflow '{workflow_name}' is not available yet")
