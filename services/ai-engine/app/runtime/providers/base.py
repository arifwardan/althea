from typing import Any, Literal, Protocol, runtime_checkable

from pydantic import BaseModel, Field

from app.runtime.errors import ProviderNotFoundError

Role = Literal["system", "developer", "user", "assistant", "tool"]


class ModelMessage(BaseModel):
    role: Role
    content: str
    tool_call_id: str | None = None


class ToolSpec(BaseModel):
    """Provider-agnostic tool description passed to the model."""

    name: str
    description: str
    parameters: dict[str, Any] = Field(default_factory=dict)


class ToolCall(BaseModel):
    id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class TokenUsage(BaseModel):
    prompt_tokens: int | None = None
    completion_tokens: int | None = None

    @property
    def total_tokens(self) -> int | None:
        if self.prompt_tokens is None and self.completion_tokens is None:
            return None
        return (self.prompt_tokens or 0) + (self.completion_tokens or 0)


class ModelRequest(BaseModel):
    model: str
    messages: list[ModelMessage]
    tools: list[ToolSpec] = Field(default_factory=list)
    temperature: float = 0.2
    max_tokens: int = 4096


class ModelResponse(BaseModel):
    content: str
    tool_calls: list[ToolCall] = Field(default_factory=list)
    usage: TokenUsage = Field(default_factory=TokenUsage)


@runtime_checkable
class ModelProvider(Protocol):
    """Abstraction over LLM backends. Implementations must be stateless per call."""

    name: str

    async def generate(self, request: ModelRequest) -> ModelResponse: ...


class ProviderRegistry:
    """Maps provider names to instances so agents select providers by config."""

    def __init__(self, providers: dict[str, ModelProvider] | None = None) -> None:
        self._providers: dict[str, ModelProvider] = dict(providers or {})

    def register(self, provider: ModelProvider) -> None:
        self._providers[provider.name] = provider

    def get(self, name: str) -> ModelProvider:
        try:
            return self._providers[name]
        except KeyError:
            raise ProviderNotFoundError(name) from None

    def names(self) -> tuple[str, ...]:
        return tuple(self._providers)
