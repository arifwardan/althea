from typing import Any

import httpx
import pytest

from app.runtime.errors import ProviderError
from app.runtime.providers.base import ModelMessage, ModelRequest, ToolSpec
from app.runtime.providers.ollama import OllamaProvider
from app.runtime.providers.stubs import AnthropicProvider, GeminiProvider, OpenAIProvider


def _request(**overrides: Any) -> ModelRequest:
    defaults: dict[str, Any] = {
        "model": "llama3.1",
        "messages": [
            ModelMessage(role="developer", content="be terse"),
            ModelMessage(role="user", content="hi"),
        ],
    }
    defaults.update(overrides)
    return ModelRequest(**defaults)


def test_payload_maps_roles_and_tools() -> None:
    provider = OllamaProvider()
    request = _request(
        tools=[ToolSpec(name="read_file", description="Read", parameters={"type": "object"})]
    )

    payload = provider._build_payload(request)

    assert payload["messages"][0]["role"] == "system"
    assert payload["tools"][0]["function"]["name"] == "read_file"
    assert payload["options"]["temperature"] == request.temperature


def test_parse_response_extracts_tool_calls_and_usage() -> None:
    data = {
        "message": {
            "content": "",
            "tool_calls": [
                {"function": {"name": "read_file", "arguments": {"path": "a.txt"}}}
            ],
        },
        "prompt_eval_count": 12,
        "eval_count": 3,
    }

    response = OllamaProvider._parse_response(data)

    assert response.tool_calls[0].name == "read_file"
    assert response.tool_calls[0].arguments == {"path": "a.txt"}
    assert response.usage.total_tokens == 15


async def test_generate_wraps_http_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    async def boom(self: httpx.AsyncClient, url: str, **kwargs: Any) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx.AsyncClient, "post", boom)

    with pytest.raises(ProviderError):
        await OllamaProvider(base_url="http://localhost:1").generate(_request())


async def test_stub_providers_raise() -> None:
    for provider in (OpenAIProvider(), AnthropicProvider(), GeminiProvider()):
        with pytest.raises(ProviderError):
            await provider.generate(_request())
