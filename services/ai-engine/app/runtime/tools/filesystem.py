from pathlib import Path
from typing import Any

from app.runtime.tools.base import ToolResult


class _WorkspaceTool:
    """Base for tools whose file access is confined to a workspace root."""

    def __init__(self, workspace_root: str | Path = ".") -> None:
        self._root = Path(workspace_root).resolve()

    def _resolve(self, relative_path: str) -> Path:
        candidate = (self._root / relative_path).resolve()
        if not candidate.is_relative_to(self._root):
            raise PermissionError(f"path escapes workspace: {relative_path}")
        return candidate


class ReadFileTool(_WorkspaceTool):
    name = "read_file"
    description = "Read a UTF-8 text file from the workspace. Argument: path (relative)."
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {"path": {"type": "string", "description": "Relative file path"}},
        "required": ["path"],
    }
    required_permission = "fs:read"

    async def run(self, arguments: dict[str, Any]) -> ToolResult:
        try:
            content = self._resolve(str(arguments["path"])).read_text(encoding="utf-8")
        except (OSError, KeyError, PermissionError) as exc:
            return ToolResult(ok=False, error=str(exc))
        return ToolResult(ok=True, output=content)


class WriteFileTool(_WorkspaceTool):
    name = "write_file"
    description = (
        "Write UTF-8 text to a file in the workspace, creating parent directories. "
        "Arguments: path (relative), content."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Relative file path"},
            "content": {"type": "string", "description": "File content"},
        },
        "required": ["path", "content"],
    }
    required_permission = "fs:write"

    async def run(self, arguments: dict[str, Any]) -> ToolResult:
        try:
            target = self._resolve(str(arguments["path"]))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(str(arguments["content"]), encoding="utf-8")
        except (OSError, KeyError, PermissionError) as exc:
            return ToolResult(ok=False, error=str(exc))
        return ToolResult(ok=True, output=f"wrote {arguments['path']}")


class SearchFilesTool(_WorkspaceTool):
    name = "search_files"
    description = (
        "List workspace files matching a glob pattern. Argument: pattern (e.g. '**/*.py')."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {"pattern": {"type": "string", "description": "Glob pattern"}},
        "required": ["pattern"],
    }
    required_permission = "fs:read"

    async def run(self, arguments: dict[str, Any]) -> ToolResult:
        try:
            matches = sorted(
                str(p.relative_to(self._root))
                for p in self._root.glob(str(arguments["pattern"]))
                if p.is_file()
            )
        except (OSError, KeyError, ValueError) as exc:
            return ToolResult(ok=False, error=str(exc))
        return ToolResult(ok=True, output="\n".join(matches), metadata={"count": len(matches)})
