"""PLACEHOLDER: interface-only providers, explicitly not implemented in this milestone.

Each satisfies the ModelProvider protocol so it can already be registered and
selected by agent configuration; `generate` raises until the integration lands.
"""

from app.runtime.errors import ProviderError
from app.runtime.providers.base import ModelProvider, ModelRequest, ModelResponse


class _UnimplementedProvider(ModelProvider):
    name = ""

    async def generate(self, request: ModelRequest) -> ModelResponse:
        raise ProviderError(f"provider '{self.name}' is not implemented yet")


class OpenAIProvider(_UnimplementedProvider):
    name = "openai"


class AnthropicProvider(_UnimplementedProvider):
    name = "anthropic"


class GeminiProvider(_UnimplementedProvider):
    name = "gemini"
