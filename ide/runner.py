"""Run one workspace file with its interpreter and stream the output.

This executes code on the machine that runs the server. The server enables it
on localhost only, unless it was started with --allow-run.
"""

from __future__ import annotations

import os
import queue
import shutil
import signal
import subprocess
import threading
import time
from collections.abc import Iterator
from pathlib import Path

RUN_TIMEOUT_S = 120
MAX_OUTPUT_BYTES = 1_000_000
KEEPALIVE_S = 1.0

# extension -> command prefix; the file path is appended
INTERPRETERS: dict[str, tuple[str, ...]] = {
    ".py": ("python3", "-u"),
    ".js": ("node",),
    ".mjs": ("node",),
    ".sh": ("bash",),
}


class RunError(ValueError):
    """The file cannot be run."""


def command_for(path: Path) -> list[str]:
    prefix = INTERPRETERS.get(path.suffix.lower())
    if prefix is None:
        raise RunError(f"no interpreter for {path.suffix or 'this file'}; runnable: {', '.join(sorted(INTERPRETERS))}")
    if shutil.which(prefix[0]) is None:
        raise RunError(f"{prefix[0]} is not installed")
    return [*prefix, str(path)]


def _kill(process: subprocess.Popen) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def run_file(path: Path, cwd: Path, timeout_s: float = RUN_TIMEOUT_S) -> Iterator[dict]:
    """Yield {'type': 'out'|'ping'|'exit', ...}. Closing the iterator kills the process."""
    argv = command_for(path)
    started = time.time()
    process = subprocess.Popen(  # noqa: S603 - argv is built from a fixed interpreter table
        argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    lines: queue.Queue[bytes | None] = queue.Queue()

    def pump() -> None:
        assert process.stdout is not None
        for line in iter(process.stdout.readline, b""):
            lines.put(line)
        lines.put(None)

    threading.Thread(target=pump, daemon=True).start()
    sent = 0
    note = ""
    try:
        while True:
            if time.time() - started > timeout_s:
                note = f"stopped after {int(timeout_s)} s"
                break
            try:
                line = lines.get(timeout=KEEPALIVE_S)
            except queue.Empty:
                yield {"type": "ping"}  # lets the server notice a closed browser tab
                continue
            if line is None:
                break
            sent += len(line)
            if sent > MAX_OUTPUT_BYTES:
                note = "output limit reached"
                break
            yield {"type": "out", "text": line.decode(errors="replace")}
    finally:
        if process.poll() is None:
            _kill(process)
        code = process.wait()
    yield {"type": "exit", "code": code, "seconds": round(time.time() - started, 2), "note": note,
           "command": " ".join([*argv[:-1], path.name])}
