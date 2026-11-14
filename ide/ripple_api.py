"""Ripple-65B endpoints and an offline mock.

API keys are read from the server environment and never reach the browser.
The mock streams Ripple-shaped SSE (reasoning, tool calls, usage) so the IDE
runs without a model.
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import os
import re
import time
import urllib.error
import urllib.request
from collections import Counter
from collections.abc import Iterator
from http.client import HTTPResponse
from urllib.parse import urlparse

UPSTREAM_TIMEOUT_S = 900
COMPLETE_TIMEOUT_S = 30
STATUS_TIMEOUT_S = 4
RIPPLE_CONTEXT = 1_048_576
RESERVED_BODY_KEYS = frozenset({"model", "messages", "stream", "stream_options", "tools", "tool_choice"})
MODEL_NAME_RE = re.compile(r"^[\w./:@+-]{1,200}$")
_CGNAT = ipaddress.ip_network("100.64.0.0/10")  # Tailscale addresses

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
        "prefill": True,
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
            "base_url": p["base_url"],
            "ready": pid != "openrouter" or preset_key(p) is not None,
            "note": p["note"],
        }
        for pid, p in PRESETS.items()
    ]


def endpoint_host_allowed(host: str, extra_hosts: frozenset[str] = frozenset()) -> bool:
    """Custom endpoints are for a local Ripple: localhost or a private address."""
    if host == "localhost" or host in extra_hosts:
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address.is_private or (address.version == 4 and address in _CGNAT)


def resolve_target(body: dict, custom_enabled: bool = True, extra_hosts: frozenset[str] = frozenset()) -> dict:
    """The endpoint a request goes to: a preset by id, or a custom local endpoint."""
    endpoint = body.get("endpoint")
    if endpoint is None:
        preset = PRESETS.get(str(body.get("preset", "")))
        if preset is None:
            raise UpstreamError(400, f"unknown preset; use one of {sorted(PRESETS)}")
        return preset
    if not custom_enabled:
        raise UpstreamError(403, "custom endpoints are off on this server; start it with --allow-custom-endpoints")
    if not isinstance(endpoint, dict):
        raise UpstreamError(400, "endpoint must be an object")
    url = urlparse(str(endpoint.get("base_url", "")).strip())
    model = str(endpoint.get("model", "")).strip()
    if url.scheme not in ("http", "https") or not url.hostname:
        raise UpstreamError(400, "endpoint.base_url must be an http(s) URL such as http://127.0.0.1:8000/v1")
    if not endpoint_host_allowed(url.hostname.lower(), extra_hosts):
        raise UpstreamError(400, "a custom endpoint must be on localhost or a private address "
                                 "(or a host named with --allow-endpoint-host)")
    if not MODEL_NAME_RE.match(model):
        raise UpstreamError(400, "endpoint.model is missing or has characters that are not allowed")
    return {"label": "Custom endpoint", "base_url": url.geturl().rstrip("/"), "model": model,
            "key_env": ["RIPPLE_RUNTIME_KEY"], "extra": {}, "prefill": True}


def parse_options(body: dict) -> dict:
    """Request-body overrides from the lab: sampling numbers plus free extra fields."""
    raw = body.get("options") or {}
    if not isinstance(raw, dict):
        raise UpstreamError(400, "options must be an object")
    extra = raw.get("extra_body") or {}
    if not isinstance(extra, dict):
        raise UpstreamError(400, "options.extra_body must be an object")
    out = {key: value for key, value in extra.items() if key not in RESERVED_BODY_KEYS}
    try:
        for name, low, high in (("temperature", 0.0, 2.0), ("top_p", 0.0, 1.0)):
            if raw.get(name) is not None:
                value = float(raw[name])
                if not low <= value <= high:
                    raise UpstreamError(400, f"options.{name} must be between {low} and {high}")
                out[name] = value
        if raw.get("max_tokens") is not None:
            tokens = int(raw["max_tokens"])
            if not 1 <= tokens <= 8192:
                raise UpstreamError(400, "options.max_tokens must be between 1 and 8192")
            out["max_tokens"] = tokens
    except (TypeError, ValueError) as exc:
        raise UpstreamError(400, f"options has a value that is not a number: {exc}") from exc
    return out


def open_upstream(preset: dict, body: dict, overrides: dict | None = None) -> HTTPResponse:
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
    payload.update(overrides or {})

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
    except (OSError, http.client.HTTPException) as exc:
        # Refused, timed out, or accepted and then closed with no answer. The last one is
        # what a port forward does while the server behind it is still starting.
        reason = getattr(exc, "reason", None) or exc or type(exc).__name__
        raise UpstreamError(502, f"The Ripple server at {preset['base_url']} does not answer ({reason}). "
                                 "Is it running, and is the port forward open?") from exc


def stream_once(preset: dict, messages: list[dict], max_tokens: int, overrides: dict | None = None,
                prefill: str | None = None, stop: list[str] | None = None) -> HTTPResponse:
    """One streamed answer with no tools, for inline edit. Returns the upstream SSE response."""
    payload = {"max_tokens": max_tokens, "temperature": 0.0, **(overrides or {}),
               "model": preset["model"], "messages": messages, "stream": True,
               "stream_options": {"include_usage": True}}
    if prefill is not None and can_prefill(preset):
        payload["messages"] = [*messages, {"role": "assistant", "content": prefill}]
        payload.update(add_generation_prompt=False, continue_final_message=True)
        if stop:
            payload["stop"] = stop
    return _post(preset, payload, "text/event-stream", UPSTREAM_TIMEOUT_S)


def content_events(text: str, pieces: int = 12) -> Iterator[bytes]:
    """A fixed text as chat-completion stream events (for the mock)."""
    step = max(1, len(text) // pieces)
    for start in range(0, len(text), step):
        yield _chunk({"content": text[start:start + step]})
    yield _chunk(usage={"prompt_tokens": 0, "completion_tokens": max(1, len(text) // 4), "total_tokens": 0})
    yield _sse("[DONE]")


_METRIC_LINE = re.compile(r"^(vllm:[\w:]+)(?:\{[^}]*\})?\s+([-+0-9.eE]+)$")
_METRICS_WANTED = {
    "vllm:num_requests_running": "running",
    "vllm:num_requests_waiting": "waiting",
    "vllm:kv_cache_usage_perc": "kv_cache_usage",
    "vllm:gpu_cache_usage_perc": "kv_cache_usage",
    "vllm:generation_tokens_total": "generation_tokens",
    "vllm:prompt_tokens_total": "prompt_tokens",
    "vllm:prompt_tokens_cached_total": "prompt_tokens_cached",
    "vllm:prefix_cache_queries_total": "prefix_cache_queries",
    "vllm:prefix_cache_hits_total": "prefix_cache_hits",
    "vllm:request_success_total": "requests_done",
    "vllm:spec_decode_num_drafts_total": "spec_drafts",
    "vllm:spec_decode_num_draft_tokens_total": "spec_draft_tokens",
    "vllm:spec_decode_num_accepted_tokens_total": "spec_accepted_tokens",
}


def parse_metrics(text: str) -> dict:
    """The few numbers of a vLLM /metrics page that say how the server is doing, summed over labels."""
    out: dict[str, float] = {}
    for line in text.splitlines():
        match = _METRIC_LINE.match(line)
        if match and match.group(1) in _METRICS_WANTED:
            key = _METRICS_WANTED[match.group(1)]
            out[key] = out.get(key, 0.0) + float(match.group(2))
    return out


def _get(url: str, headers: dict) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=STATUS_TIMEOUT_S) as response:  # noqa: S310
        return response.read(2_000_000)


def check(preset: dict) -> dict:
    """Does the endpoint answer right now, and how busy is it? For the status dot and the status panel."""
    if preset["base_url"] == "mock://":
        return {"ok": True, "detail": "offline mock, no model", "model": "mock", "metrics": {}}
    headers = {"Authorization": f"Bearer {preset_key(preset)}"} if preset_key(preset) else {}
    base = preset["base_url"].rstrip("/")
    try:
        models = json.loads(_get(base + "/models", headers))
        served = next((m for m in models.get("data", []) if m.get("id") == preset["model"]), None) or {}
        status = {"ok": True, "detail": f"{preset['model']} at {preset['base_url']}", "model": preset["model"],
                  "served_as": served.get("root") or served.get("id"), "max_model_len": served.get("max_model_len"),
                  "metrics": {}}
        try:  # vLLM and SGLang serve Prometheus text next to /v1
            status["metrics"] = parse_metrics(_get(base.removesuffix("/v1") + "/metrics", headers).decode(errors="replace"))
            status["at"] = time.time()
        except (OSError, http.client.HTTPException, ValueError):
            pass
        return status
    except json.JSONDecodeError:
        return {"ok": True, "detail": f"{preset['model']} at {preset['base_url']}", "model": preset["model"], "metrics": {}}
    except urllib.error.HTTPError as exc:
        return {"ok": False, "detail": f"{preset['base_url']} answered {exc.code}"}
    except (OSError, http.client.HTTPException) as exc:
        reason = getattr(exc, "reason", None) or exc or type(exc).__name__
        return {"ok": False, "detail": f"{preset['base_url']} does not answer ({reason})"}


def can_prefill(preset: dict) -> bool:
    """True for servers that can continue a final assistant message (vLLM, SGLang)."""
    return bool(preset.get("prefill"))


def complete_once(preset: dict, messages: list[dict], max_tokens: int, temperature: float,
                  overrides: dict | None = None, prefill: str | None = None, stop: list[str] | None = None,
                  pattern: str | None = None) -> str:
    """One short non-streamed answer, for inline completion.

    With `prefill`, the assistant turn is started for the model and it continues from there.
    """
    payload = {"max_tokens": max_tokens, "temperature": temperature, **(overrides or {}),
               "model": preset["model"], "messages": messages, "stream": False}
    if prefill is not None:
        payload["messages"] = [*messages, {"role": "assistant", "content": prefill}]
        payload.update(add_generation_prompt=False, continue_final_message=True)
        if stop:
            payload["stop"] = stop
        if pattern:
            payload["structured_outputs"] = {"regex": pattern}
    try:
        with _post(preset, payload, "application/json", COMPLETE_TIMEOUT_S) as response:
            data = json.load(response)
        return str(data["choices"][0]["message"].get("content") or "")
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise UpstreamError(502, f"unexpected completion answer: {exc}") from exc
    except (OSError, http.client.HTTPException) as exc:
        raise UpstreamError(502, f"the Ripple server closed the connection: {exc}") from exc


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
