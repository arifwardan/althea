from pathlib import Path

import pytest

from app.runtime.errors import ToolNotFoundError
from app.runtime.tools.base import ToolRegistry
from app.runtime.tools.filesystem import ReadFileTool, SearchFilesTool, WriteFileTool


async def test_write_then_read(tmp_path: Path) -> None:
    write_tool = WriteFileTool(tmp_path)
    read_tool = ReadFileTool(tmp_path)

    result = await write_tool.run({"path": "notes/hello.txt", "content": "hi"})
    assert result.ok

    result = await read_tool.run({"path": "notes/hello.txt"})
    assert result.ok
    assert result.output == "hi"


async def test_path_escape_is_rejected(tmp_path: Path) -> None:
    read_tool = ReadFileTool(tmp_path)
    result = await read_tool.run({"path": "../../etc/passwd"})
    assert not result.ok
    assert "escapes workspace" in result.error


async def test_search_files(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text("x", encoding="utf-8")
    (tmp_path / "b.txt").write_text("y", encoding="utf-8")

    result = await SearchFilesTool(tmp_path).run({"pattern": "*.py"})
    assert result.ok
    assert result.output == "a.py"
    assert result.metadata["count"] == 1


def test_registry_specs_and_missing_tool(tmp_path: Path) -> None:
    registry = ToolRegistry([ReadFileTool(tmp_path), WriteFileTool(tmp_path)])
    specs = registry.specs(("read_file",))
    assert [s.name for s in specs] == ["read_file"]
    with pytest.raises(ToolNotFoundError):
        registry.get("terminal")


def test_discovery_finds_filesystem_tools() -> None:
    registry = ToolRegistry.discover()
    assert {"read_file", "write_file", "search_files"} <= set(registry.names())
