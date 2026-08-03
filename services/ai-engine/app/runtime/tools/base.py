import importlib
import inspect
import pkgutil
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel, Field

from app.runtime.errors import ToolNotFoundError
from app.runtime.providers.base import ToolSpec


class ToolResult(BaseModel):
    ok: bool
    output: str = ""
    error: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


@runtime_checkable
class Tool(Protocol):
    """Pluggable tool contract. Implementations must be side-effect scoped."""

    name: str
    description: str
    parameters: dict[str, Any]
    required_permission: str

    async def run(self, arguments: dict[str, Any]) -> ToolResult: ...


class ToolRegistry:
    def __init__(self, tools: list[Tool] | None = None) -> None:
        self._tools: dict[str, Tool] = {}
        for tool in tools or []:
            self.register(tool)

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool:
        try:
            return self._tools[name]
        except KeyError:
            raise ToolNotFoundError(name) from None

    def names(self) -> tuple[str, ...]:
        return tuple(self._tools)

    def specs(self, names: tuple[str, ...] | None = None) -> list[ToolSpec]:
        selected = self._tools.values() if names is None else [self.get(n) for n in names]
        return [
            ToolSpec(name=t.name, description=t.description, parameters=t.parameters)
            for t in selected
        ]

    @classmethod
    def discover(cls, package: str = "app.runtime.tools") -> "ToolRegistry":
        """Auto-discover Tool implementations in every module of a package.

        Any concrete class satisfying the Tool protocol with a zero-argument
        constructor is instantiated and registered.
        """
        registry = cls()
        module = importlib.import_module(package)
        for info in pkgutil.iter_modules(module.__path__):
            submodule = importlib.import_module(f"{package}.{info.name}")
            for _, obj in inspect.getmembers(submodule, inspect.isclass):
                if (
                    obj.__module__ == submodule.__name__
                    and not inspect.isabstract(obj)
                    and _implements_tool(obj)
                ):
                    registry.register(obj())
        return registry


def _implements_tool(cls: type) -> bool:
    name = inspect.getattr_static(cls, "name", None)
    run = inspect.getattr_static(cls, "run", None)
    has_metadata = all(
        isinstance(inspect.getattr_static(cls, attr, None), str)
        for attr in ("description", "required_permission")
    )
    return isinstance(name, str) and bool(name) and run is not None and has_metadata
