from app.runtime.agent import AgentConfig
from app.runtime.errors import PermissionDeniedError
from app.runtime.tools.base import Tool


class PermissionManager:
    """Enforces agent permissions before any tool executes."""

    def check_tool(self, agent: AgentConfig, tool: Tool) -> None:
        if tool.name not in agent.available_tools:
            raise PermissionDeniedError(agent.id, f"tool:{tool.name}")
        if tool.required_permission and not agent.has_permission(tool.required_permission):
            raise PermissionDeniedError(agent.id, tool.required_permission)
