import json
from pathlib import Path

from app.runtime.agent import AgentConfig
from app.runtime.errors import AgentNotFoundError


class AgentRegistry:
    """Stores agent configurations. Configuration is data, not code."""

    def __init__(self, agents: list[AgentConfig] | None = None) -> None:
        self._agents: dict[str, AgentConfig] = {a.id: a for a in agents or []}

    def register(self, agent: AgentConfig) -> None:
        self._agents[agent.id] = agent

    def get(self, agent_id: str) -> AgentConfig:
        try:
            return self._agents[agent_id]
        except KeyError:
            raise AgentNotFoundError(agent_id) from None

    def list(self, *, enabled_only: bool = False) -> list[AgentConfig]:
        agents = list(self._agents.values())
        if enabled_only:
            agents = [a for a in agents if a.enabled]
        return agents

    @classmethod
    def from_directory(cls, config_dir: str | Path) -> "AgentRegistry":
        """Load every *.json agent definition from a directory."""
        registry = cls()
        for path in sorted(Path(config_dir).glob("*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            registry.register(AgentConfig.model_validate(data))
        return registry

    def dump(self, agent_id: str) -> str:
        return self.get(agent_id).model_dump_json(indent=2)
