#!/usr/bin/env python3
"""What the IDE feels while the agent writes one long file: status checks and suggestions.

    python3 tools/bench-busy.py http://127.0.0.1:8787 [max_tokens]

It starts one chat answer with tools through the IDE server (a long `write_file` call), and
until that answer ends it asks for the Ripple status and for one suggestion again and again.
"""
from __future__ import annotations

import json
import sys
import threading
import time
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
MAX_TOKENS = int(sys.argv[2]) if len(sys.argv) > 2 else 8000
TOOLS = [{"type": "function", "function": {"name": "write_file", "description": "Write a file", "parameters": {
    "type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}}]
CHAT = {"preset": "runtime", "max_tokens": MAX_TOKENS, "tools": TOOLS, "messages": [{"role": "user", "content":
        "Make a complete single-file HTML page that reviews a code editor: long, with CSS and JavaScript, "
        "at least 600 lines. Use write_file."}]}
SUGGEST = {"preset": "runtime", "language": "python", "path": "stats.py", "prefix": "def mean(values):\n    return ", "suffix": "\n"}


def post(path: str, body: dict, timeout: float = 120.0):
    request = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(request, timeout=timeout)


def answer(done: threading.Event, info: dict) -> None:
    started = time.perf_counter()
    arguments = 0
    with post("/api/chat", CHAT, timeout=900) as response:
        for line in response:
            if line.startswith(b"data: {"):
                delta = (json.loads(line[6:]).get("choices") or [{}])[0].get("delta", {})
                for call in delta.get("tool_calls") or []:
                    arguments += len((call.get("function") or {}).get("arguments") or "")
    info.update(seconds=round(time.perf_counter() - started, 1), argument_chars=arguments)
    done.set()


def main() -> None:
    done, info = threading.Event(), {}
    threading.Thread(target=answer, args=(done, info), daemon=True).start()
    status, suggest, down = [], [], 0
    salt = 0
    while not done.is_set():
        started = time.perf_counter()
        with post("/api/ripple-status", {"preset": "runtime"}) as response:
            state = json.load(response)
        status.append(time.perf_counter() - started)
        down += not state["ok"]
        salt += 1
        started = time.perf_counter()
        with post("/api/complete", {**SUGGEST, "prefix": f"# busy {salt} {time.time()}\n" + SUGGEST["prefix"]}) as response:
            json.load(response)
        suggest.append(time.perf_counter() - started)
        time.sleep(0.2)
    print(f"answer: {info['seconds']} s, {info['argument_chars']} characters of tool-call arguments")
    for label, rows in (("status check", status), ("suggestion", suggest)):
        rows = sorted(rows)
        print(f"{label:13s} n={len(rows):3d}  median {rows[len(rows) // 2] * 1000:6.0f} ms  max {rows[-1]:5.2f} s  over 4 s: {sum(r > 4 for r in rows)}")
    print(f'status said "does not answer": {down} times')


if __name__ == "__main__":
    main()
