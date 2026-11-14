"""Ripple-65B endpoints and an offline mock.

API keys are read from the server environment and never reach the browser.
The mock streams Ripple-shaped SSE (reasoning, tool calls, usage) so the IDE
runs without a model.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from collections import Counter
from collections.abc import Iterator
from http.client import HTTPResponse

UPSTREAM_TIMEOUT_S = 900
COMPLETE_TIMEOUT_S = 30
RIPPLE_CONTEXT = 1_048_576

PRESETS: dict[str, dict] = {
    "mock": {
        "label": "Mock Ripple (offline)",
        "base_url": "mock://",
        "model": "ripple-mock",
        "key_env": [],
        "extra": {},
        "note": "Streams Ripple-shaped reasoning, tool calls and usage. No network.",
    },
    "openrouter": {
        "label": "OpenRouter",
        "base_url": "https://openrouter.ai/api/v1",
        "model": "ricursiveai/ripple-65b-preview",
        "key_env": ["OPENROUTER_API_KEY"],
        "extra": {"include_reasoning": True},
        "note": "Hosted. Set OPENROUTER_API_KEY before starting the server.",
    },
    # The team's own Ripple server. The inference kernels behind it are tuned
    # separately; the IDE only needs an OpenAI-compatible /chat/completions URL.
    "runtime": {
        "label": "Team Ripple runtime",
        "base_url": os.environ.get("RIPPLE_RUNTIME_URL", "http://127.0.0.1:8000/v1"),
        "model": os.environ.get("RIPPLE_RUNTIME_MODEL", "ricursiveAI/Ripple-65B-Preview"),
        "key_env": ["RIPPLE_RUNTIME_KEY"],
        "extra": {},
        "note": "Set RIPPLE_RUNTIME_URL (and RIPPLE_RUNTIME_MODEL) to the team's server. See docs/RUNTIME.md.",
    },
    "ollama": {
        "label": "Ollama",
        "base_url": "http://127.0.0.1:11434/v1",
        "model": "ripple-preview:65b",
        "key_env": [],
        "extra": {},
        "note": "ollama pull ripple-preview:65b",
    },
}


class UpstreamError(Exception):
    def __init__(self, status: int, message: str, detail: str = ""):
        super().__init__(message)
        self.status = status
        self.payload = {"error": message, "detail": detail}


def preset_key(preset: dict) -> str | None:
    for name in preset["key_env"]:
        if os.environ.get(name):
            return os.environ[name]
    return None


def default_preset() -> str:
    """The team runtime when its URL is configured, else the offline mock."""
    return "runtime" if os.environ.get("RIPPLE_RUNTIME_URL") else "mock"


def public_presets() -> list[dict]:
    return [
        {
            "id": pid,
            "label": p["label"],
            "model": p["model"],
            "context": RIPPLE_CONTEXT,
            "ready": pid != "openrouter" or preset_key(p) is not None,
            "note": p["note"],
        }
        for pid, p in PRESETS.items()
    ]


def open_upstream(preset: dict, body: dict) -> HTTPResponse:
    payload = {
        "model": preset["model"],
        "messages": body["messages"],
        "stream": True,
        "stream_options": {"include_usage": True},
        **preset["extra"],
    }
    if body.get("tools"):
        payload["tools"] = body["tools"]
        payload["tool_choice"] = "auto"
    for name in ("temperature", "top_p", "max_tokens"):
        if name in body:
            payload[name] = body[name]

    return _post(preset, payload, "text/event-stream", UPSTREAM_TIMEOUT_S)


def _post(preset: dict, payload: dict, accept: str, timeout_s: float) -> HTTPResponse:
    headers = {"Content-Type": "application/json", "Accept": accept}
    key = preset_key(preset)
    if key:
        headers["Authorization"] = f"Bearer {key}"
    elif preset is PRESETS["openrouter"]:
        raise UpstreamError(401, "OPENROUTER_API_KEY is not set in the server environment")

    request = urllib.request.Request(
        preset["base_url"].rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    try:
        return urllib.request.urlopen(request, timeout=timeout_s)  # noqa: S310 - fixed preset URLs
    except urllib.error.HTTPError as exc:
        raise UpstreamError(exc.code, f"upstream {exc.code}", exc.read().decode(errors="replace")[:4000]) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        reason = getattr(exc, "reason", exc)
        raise UpstreamError(502, f"cannot reach {preset['base_url']}: {reason}") from exc


def complete_once(preset: dict, messages: list[dict], max_tokens: int, temperature: float) -> str:
    """One short non-streamed answer, for inline completion."""
    payload = {"model": preset["model"], "messages": messages, "stream": False,
               "max_tokens": max_tokens, "temperature": temperature}
    try:
        with _post(preset, payload, "application/json", COMPLETE_TIMEOUT_S) as response:
            data = json.load(response)
        return str(data["choices"][0]["message"].get("content") or "")
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise UpstreamError(502, f"unexpected completion answer: {exc}") from exc


# ------------------------------------------------------------------ mock


def _sse(obj: dict | str) -> bytes:
    data = obj if isinstance(obj, str) else json.dumps(obj)
    return f"data: {data}\n\n".encode()


def _chunk(delta: dict | None = None, finish: str | None = None, usage: dict | None = None) -> bytes:
    event: dict = {
        "id": "mock-ripple",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "ripple-mock",
        "choices": [] if usage else [{"index": 0, "delta": delta or {}, "finish_reason": finish}],
    }
    if usage:
        event["usage"] = usage
    return _sse(event)


def _last_tool_name(messages: list[dict]) -> str | None:
    for msg in reversed(messages):
        if msg.get("role") == "assistant" and msg.get("tool_calls"):
            return msg["tool_calls"][-1]["function"]["name"]
    return None


def _comment_prefix(path: str) -> str:
    return "# " if path.endswith(".py") else "// "


def _summarize_report(raw: str) -> str:
    try:
        report = json.loads(raw)
    except json.JSONDecodeError:
        return f"The compile tool answered: {raw[:300]}"
    if report.get("error"):
        return f"The compile did not run: {report['error']}"
    if not report.get("ok"):
        first = (report.get("diagnostics") or [{}])[0]
        return f"The compile failed. First diagnostic: line {first.get('line', '?')}: {first.get('message', 'n/a')}"
    lines = [f"Compiled with {report.get('backend')} for {report.get('arch')}."]
    for fn in report.get("functions", []):
        regs = f", {fn['registers']} registers" if fn.get("registers") is not None else ""
        lines.append(f"- {fn['name']}: {fn['instructions']} instructions, {fn['loops']} loops{regs}")
    counts = Counter(lint["code"] for lint in report.get("lints", []))
    if counts:
        lines.append("Findings: " + ", ".join(f"{code} ×{n}" for code, n in counts.most_common()))
    else:
        lines.append("No findings.")
    return "\n".join(lines)


def mock_plan(messages: list[dict]) -> tuple[str, str, tuple[str, dict] | None]:
    """Return (reasoning, content, tool_call) for the next mock turn."""
    system = messages[0].get("content", "") if messages and messages[0].get("role") == "system" else ""
    match = re.search(r"^Active file: (.+)$", system, re.MULTILINE)
    active = match.group(1).strip() if match else None
    last = messages[-1] if messages else {}
    asked = next((str(m.get("content", "")) for m in reversed(messages) if m.get("role") == "user"), "").lower()

    if active is None or active == "(none)":
        return ("No file is open.", "Open a kernel file first, then ask again.", None)
    if last.get("role") == "user":
        return (f"The request is about {active}. Read it before anything else.",
                "Reading the kernel.\n", ("read_file", {"path": active}))
    if last.get("role") == "tool":
        previous = _last_tool_name(messages)
        if previous == "read_file" and ("header" in asked or "edit" in asked):
            header = f"{_comment_prefix(active)}Reviewed by Ripple (mock run).\n"
            return ("A one-line header comment is a safe, visible edit.",
                    "I will add a header comment. Check the diff.\n",
                    ("write_file", {"path": active, "content": header + str(last.get("content", ""))}))
        if previous == "read_file" and active.endswith((".cu", ".cuh", ".ptx")):
            return ("The PTX and the lint findings say more than the source alone.",
                    "Compiling to PTX.\n", ("compile_kernel", {"path": active}))
        if previous == "read_file" and "run" in asked and active.endswith((".py", ".js", ".mjs", ".sh")):
            return ("Running it shows what it does.", "Running the file.\n", ("run_file", {"path": active}))
        if previous == "read_file":
            lines = str(last.get("content", "")).count("\n") + 1
            return ("", f"{active} has {lines} lines. This is the offline mock, so there is no real review. "
                        "Pick a Ripple endpoint for one.", None)
        if previous == "run_file":
            return ("", f"The run finished. Output:\n{str(last.get('content', ''))[:400]}", None)
        if previous == "compile_kernel":
            return ("", _summarize_report(str(last.get("content", ""))), None)
        if previous == "write_file":
            rejected = '"rejected"' in str(last.get("content", ""))
            return ("", f"You rejected the change, so {active} is unchanged." if rejected
                    else f"The change is in {active}. The report on the left is from the new compile.", None)
    return ("", f"Done. {str(last.get('content', ''))[:200]}", None)


def mock_events(messages: list[dict], delay_s: float) -> Iterator[tuple[bytes, float]]:
    reasoning, content, tool_call = mock_plan(messages)
    emitted = 0
    for i, word in enumerate(reasoning.split(" ") if reasoning else []):
        field = "reasoning" if i % 2 == 0 else "reasoning_content"  # both wire names occur
        emitted += 1
        yield _chunk({"role": "assistant", field: word + " "}), delay_s
    for piece in re.findall(r"\S+\s*", content):
        emitted += 1
        yield _chunk({"content": piece}), delay_s
    if tool_call is None:
        yield _chunk(finish="stop"), 0
    else:
        name, args = tool_call
        call_id = f"call_{int(time.time() * 1000)}"
        yield _chunk({"tool_calls": [{"index": 0, "id": call_id, "type": "function",
                                      "function": {"name": name, "arguments": ""}}]}), delay_s
        raw = json.dumps(args)
        step = max(1, len(raw) // 4)
        for start in range(0, len(raw), step):
            emitted += 1
            fragment = {"index": 0, "function": {"arguments": raw[start:start + step]}}
            yield _chunk({"tool_calls": [fragment]}), delay_s
        yield _chunk(finish="tool_calls"), 0
    prompt_tokens = sum(len(json.dumps(m)) for m in messages) // 4
    yield _chunk(usage={"prompt_tokens": prompt_tokens, "completion_tokens": emitted,
                        "total_tokens": prompt_tokens + emitted}), 0
    yield _sse("[DONE]"), 0
