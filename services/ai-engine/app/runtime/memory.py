from typing import Protocol

from pydantic import BaseModel, Field


class MemoryRecord(BaseModel):
    key: str
    content: str
    metadata: dict[str, str] = Field(default_factory=dict)


class Memory(Protocol):
    """Abstraction over agent memory. Long-term memory is a later milestone."""

    async def load_context(self, scope: str, limit: int = 20) -> list[MemoryRecord]: ...

    async def search(self, scope: str, query: str, limit: int = 10) -> list[MemoryRecord]: ...

    async def remember(self, scope: str, record: MemoryRecord) -> None: ...

    async def forget(self, scope: str, key: str) -> None: ...

    async def summarize(self, scope: str) -> str: ...


class NullMemory:
    """Memory implementation that stores nothing; used until real memory lands."""

    async def load_context(self, scope: str, limit: int = 20) -> list[MemoryRecord]:
        return []

    async def search(self, scope: str, query: str, limit: int = 10) -> list[MemoryRecord]:
        return []

    async def remember(self, scope: str, record: MemoryRecord) -> None:
        return None

    async def forget(self, scope: str, key: str) -> None:
        return None

    async def summarize(self, scope: str) -> str:
        return ""
