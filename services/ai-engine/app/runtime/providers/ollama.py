import json
from typing import Any
from uuid import uuid4

import httpx

from app.runtime.errors import ProviderError
from app.runtime.providers.base import (
    ModelProvider,
    ModelRequest,
    ModelResponse,
    TokenUsage,
    ToolCall,
)


class OllamaProvider(ModelProvider):
    """Model provider backed by a local Ollama server (/api/chat)."""

    name = "ollama"

    def __init__(self, base_url: str = "http://localhost:11434", timeout: float = 120.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout

    async def generate(self, request: ModelRequest) -> ModelResponse:
        payload = self._build_payload(request)
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(f"{self._base_url}/api/chat", json=payload)
                response.raise_for_status()
                data = response.json()
        except httpx.HTTPError as exc:
            raise ProviderError(f"ollama request failed: {exc}") from exc

        return self._parse_response(data)

    def _build_payload(self, request: ModelRequest) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": request.model,
            "messages": [
                {"role": self._map_role(m.role), "content": m.content}
                for m in request.messages
            ],
            "stream": False,
            "options": {
                "temperature": request.temperature,
                "num_predict": request.max_tokens,
            },
        }
        if request.tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    },
                }
                for tool in request.tools
            ]
        return payload

    @staticmethod
    def _map_role(role: str) -> str:
        # Ollama has no separate developer role; fold it into system.
        return "system" if role == "developer" else role

    @staticmethod
    def _parse_response(data: dict[str, Any]) -> ModelResponse:
        message = data.get("message", {})
        tool_calls: list[ToolCall] = []
        for raw_call in message.get("tool_calls") or []:
            function = raw_call.get("function", {})
            arguments = function.get("arguments") or {}
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError as exc:
                    raise ProviderError(
                        f"ollama returned unparseable tool arguments: {arguments!r}"
                    ) from exc
            tool_calls.append(
                ToolCall(
                    id=raw_call.get("id") or uuid4().hex,
                    name=function.get("name", ""),
                    arguments=arguments,
                )
            )
        return ModelResponse(
            content=message.get("content", ""),
            tool_calls=tool_calls,
            usage=TokenUsage(
                prompt_tokens=data.get("prompt_eval_count"),
                completion_tokens=data.get("eval_count"),
            ),
        )
