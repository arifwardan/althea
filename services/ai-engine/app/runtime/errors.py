class AgentRuntimeError(Exception):
    """Base error for all agent runtime failures."""


class InvalidStateTransitionError(AgentRuntimeError):
    def __init__(self, current: str, target: str) -> None:
        super().__init__(f"invalid lifecycle transition: {current} -> {target}")
        self.current = current
        self.target = target


class AgentNotFoundError(AgentRuntimeError):
    def __init__(self, agent_id: str) -> None:
        super().__init__(f"agent not found: {agent_id}")
        self.agent_id = agent_id


class ToolNotFoundError(AgentRuntimeError):
    def __init__(self, tool_name: str) -> None:
        super().__init__(f"tool not found: {tool_name}")
        self.tool_name = tool_name


class PermissionDeniedError(AgentRuntimeError):
    def __init__(self, agent_id: str, permission: str) -> None:
        super().__init__(f"agent {agent_id} lacks permission: {permission}")
        self.agent_id = agent_id
        self.permission = permission


class ProviderError(AgentRuntimeError):
    """Raised when a model provider call fails."""


class ProviderNotFoundError(AgentRuntimeError):
    def __init__(self, provider_name: str) -> None:
        super().__init__(f"model provider not found: {provider_name}")
        self.provider_name = provider_name
