#!/usr/bin/env python3
"""What a changing first message costs the agent, measured on the Ripple server itself.

A conversation is sent twice, as the IDE does it in two turns in a row. Between the
turns the agent has made a file and the IDE has opened it, so the "active file" is
another one. Two shapes of the same content:

    first    the active file is a line of the first (system) message
    last     the first message never changes; the active file is a short message at the end

Reported: time to the first token of the second turn, and how many of its prompt
tokens the server took from its prefix cache.

    python3 tools/bench-agent-cache.py [http://127.0.0.1:8000] [model] [trials]
"""
from __future__ import annotations

import json
import re
import statistics
import sys
import time
import urllib.request
from pathlib import Path

SERVER = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
MODEL = sys.argv[2] if len(sys.argv) > 2 else "ripple"
TRIALS = int(sys.argv[3]) if len(sys.argv) > 3 else 5
ROOT = Path(__file__).resolve().parent.parent
RULES = ("You are Ripple, the coding model inside Ripple IDE. You work on the files of the open project with tools. "
         "Read before you edit. Check your work and report what the tools showed.")
TOOLS = [{"type": "function", "function": {"name": name, "description": text, "parameters": {
    "type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path"]}}}
    for name, text in (("read_file", "Read one workspace file."), ("write_file", "Create a file."))]


def metric(name: str) -> float:
    text = urllib.request.urlopen(SERVER + "/metrics", timeout=10).read().decode()
    return sum(float(m.group(1)) for m in re.finditer(rf"^{re.escape(name)}(?:\{{[^}}]*\}})?\s+([-+0-9.eE]+)$", text, re.M))


def first_token_ms(messages: list[dict]) -> float:
    body = {"model": MODEL, "messages": messages, "tools": TOOLS, "stream": True, "max_tokens": 8, "temperature": 0}
    request = urllib.request.Request(SERVER + "/v1/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=120) as response:
        for line in response:
            if line.startswith(b"data: {") and b'"delta"' in line:
                took = (time.perf_counter() - started) * 1000
                response.read()
                return took
    return float("nan")


def conversation(salt: str) -> list[dict]:
    """About 9,000 tokens of history: two files read, then one file written."""
    big = (ROOT / "web/src/main.js").read_text()[:24000]
    call = lambda cid, name, args: {"role": "assistant", "content": None, "tool_calls": [
        {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}
    return [
        {"role": "user", "content": f"({salt}) Read the main script and the page, then make site/about.html."},
        call("c1", "read_file", {"path": "web/src/main.js"}), {"role": "tool", "tool_call_id": "c1", "content": big},
        call("c2", "read_file", {"path": "site/index.html"}),
        {"role": "tool", "tool_call_id": "c2", "content": (ROOT / "workspace/site/index.html").read_text()},
    ]


def trial(shape: str, salt: str) -> tuple[float, float, float]:
    history = conversation(salt)
    wrote = [{"role": "assistant", "content": None, "tool_calls": [{"id": "c3", "type": "function", "function": {
        "name": "write_file", "arguments": json.dumps({"path": "site/about.html", "content": "<h1>About</h1>"})}}]},
        {"role": "tool", "tool_call_id": "c3", "content": '{"created": "site/about.html"}'}]

    def build(active: str, extra: list[dict]) -> list[dict]:
        if shape == "first":
            return [{"role": "system", "content": f"{RULES}\nActive file: {active}"}, *history, *extra]
        return [{"role": "system", "content": RULES}, *history, *extra,
                {"role": "system", "content": f"Editor state. Active file: {active}"}]

    first_token_ms(build("site/index.html", []))  # the turn before: this fills the cache
    prompt_before, cached_before = metric("vllm:prompt_tokens_total"), metric("vllm:prompt_tokens_cached_total")
    took = first_token_ms(build("site/about.html", wrote))  # the next turn: the agent made a file, the IDE opened it
    prompt = metric("vllm:prompt_tokens_total") - prompt_before
    cached = metric("vllm:prompt_tokens_cached_total") - cached_before
    return took, prompt, cached


def main() -> None:
    stamp = int(time.time())
    for shape in ("first", "last"):
        rows = [trial(shape, f"{shape}-{stamp}-{n}") for n in range(TRIALS)]
        took, prompt, cached = (statistics.median(column) for column in zip(*rows))
        print(f"active file in the {shape:<5} message: first token after {took:6.0f} ms (median of {TRIALS}); "
              f"{cached:.0f} of {prompt:.0f} prompt tokens from cache ({100 * cached / prompt:.0f} %)")


if __name__ == "__main__":
    main()
