"""Workspace: the folder of kernel files the IDE may read and write."""

from __future__ import annotations

from pathlib import Path

MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_FILES = 2000
SKIP_DIRS = frozenset({"__pycache__", "node_modules", "build", "dist"})


class WorkspaceError(ValueError):
    """The path is outside the workspace or the file is not usable."""


class Workspace:
    def __init__(self, root: Path):
        self.root = root.resolve()
        if not self.root.is_dir():
            raise WorkspaceError(f"workspace is not a directory: {self.root}")

    def resolve(self, rel: str) -> Path:
        if not isinstance(rel, str) or not rel or "\x00" in rel:
            raise WorkspaceError("path is empty")
        candidate = Path(rel)
        if candidate.is_absolute() or any(part.startswith(".") for part in candidate.parts):
            raise WorkspaceError(f"path not allowed: {rel}")
        full = (self.root / candidate).resolve()
        if not full.is_relative_to(self.root):
            raise WorkspaceError(f"path leaves the workspace: {rel}")
        return full

    def list(self) -> list[dict]:
        entries: list[dict] = []
        for path in sorted(self.root.rglob("*")):
            rel = path.relative_to(self.root)
            if any(part.startswith(".") or part in SKIP_DIRS for part in rel.parts):
                continue
            if not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
                continue
            entries.append({"path": rel.as_posix(), "size": path.stat().st_size})
            if len(entries) >= MAX_FILES:
                break
        return entries

    def read(self, rel: str) -> str:
        full = self.resolve(rel)
        if not full.is_file():
            raise WorkspaceError(f"no such file: {rel}")
        if full.stat().st_size > MAX_FILE_BYTES:
            raise WorkspaceError(f"file is larger than 2 MB: {rel}")
        try:
            return full.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            raise WorkspaceError(f"not a UTF-8 text file: {rel}") from None

    def write(self, rel: str, content: str) -> int:
        if not isinstance(content, str):
            raise WorkspaceError("content must be text")
        data = content.encode("utf-8")
        if len(data) > MAX_FILE_BYTES:
            raise WorkspaceError("content is larger than 2 MB")
        full = self.resolve(rel)
        if full.is_dir():
            raise WorkspaceError(f"path is a directory: {rel}")
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_bytes(data)
        return len(data)
