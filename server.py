#!/usr/bin/env python3
"""Ripple IDE server.

    python3 server.py                          # http://127.0.0.1:8787
    python3 server.py --workspace ~/kernels    # edit your own kernel folder
    python3 server.py --ssh gpubox             # compile on a GPU machine over ssh
    python3 server.py --host 100.x.y.z --allow-host mybox.tailnet.ts.net   # share on a private network

The server edits files and runs compilers, so it listens on localhost unless
--host says otherwise. Only use --host with an address on a network you trust.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from ide import complete, edit, ripple_api, runner
from ide.toolchain import CompileRequest, Toolchain, ToolchainError, validate_flags
from ide.workspace import Workspace, WorkspaceError

HERE = Path(__file__).resolve().parent
WEB_ROOT = HERE / "web"
MAX_BODY_BYTES = 32 * 1024 * 1024
LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost"})
CSP = (
    "default-src 'self'; script-src 'self' blob:; worker-src 'self' blob:; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data:; "
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
)

log = logging.getLogger("ripple.server")


class IdeHandler(SimpleHTTPRequestHandler):
    server_version = "RippleIDE/0.2"
    workspace: Workspace
    toolchain: Toolchain
    mock_delay_s = 0.03
    allowed_hosts: frozenset[str] = LOCAL_HOSTS
    run_enabled = True
    custom_endpoints = True
    endpoint_hosts: frozenset[str] = frozenset()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        if "/api/" in (self.path or ""):
            log.info("%s %s", self.address_string(), fmt % args)

    def end_headers(self) -> None:
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        if "/vendor/" not in self.path:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ---------------------------------------------------------- helpers
    def _json(self, status: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _is_local(self) -> bool:
        host = self.headers.get("Host", "")
        if host.rsplit(":", 1)[0].lower() not in self.allowed_hosts:
            return False  # blocks DNS rebinding and unknown names
        origin = self.headers.get("Origin")
        return origin is None or origin in (f"http://{host}", f"https://{host}")

    def _read_json(self) -> dict | None:
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            self._json(415, {"error": "expected application/json"})
            return None
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            self._json(413, {"error": f"body must be 1..{MAX_BODY_BYTES} bytes"})
            return None
        try:
            body = json.loads(self.rfile.read(length))
        except json.JSONDecodeError as exc:
            self._json(400, {"error": f"invalid JSON: {exc}"})
            return None
        if not isinstance(body, dict):
            self._json(400, {"error": "body must be a JSON object"})
            return None
        return body

    # ---------------------------------------------------------- routing
    def do_GET(self) -> None:
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            return super().do_GET()
        if not self._is_local():
            return self._json(403, {"error": "local requests only"})
        query = parse_qs(url.query)
        try:
            if url.path == "/api/presets":
                return self._json(200, {"presets": ripple_api.public_presets(),
                                             "default": ripple_api.default_preset(),
                                             "custom_endpoints": self.custom_endpoints})
            if url.path == "/api/toolchain":
                return self._json(200, self.toolchain.info(refresh="refresh" in query).to_json())
            if url.path == "/api/files":
                return self._json(200, {
                    "root": str(self.workspace.root), "files": self.workspace.list(),
                    "run": {"enabled": self.run_enabled, "extensions": sorted(runner.INTERPRETERS)},
                })
            if url.path == "/api/search":
                return self._json(200, {"hits": self.workspace.search((query.get("q") or [""])[0])})
            if url.path == "/api/file":
                path = (query.get("path") or [""])[0]
                return self._json(200, {"path": path, "content": self.workspace.read(path)})
        except WorkspaceError as exc:
            return self._json(400, {"error": str(exc)})
        return self._json(404, {"error": "not found"})

    def do_PUT(self) -> None:
        if urlparse(self.path).path != "/api/file":
            return self._json(404, {"error": "not found"})
        if not self._is_local():
            return self._json(403, {"error": "local requests only"})
        body = self._read_json()
        if body is None:
            return None
        try:
            size = self.workspace.write(body.get("path", ""), body.get("content"))
        except WorkspaceError as exc:
            return self._json(400, {"error": str(exc)})
        return self._json(200, {"path": body["path"], "size": size})

    def do_DELETE(self) -> None:
        url = urlparse(self.path)
        if url.path != "/api/file":
            return self._json(404, {"error": "not found"})
        if not self._is_local():
            return self._json(403, {"error": "local requests only"})
        path = (parse_qs(url.query).get("path") or [""])[0]
        try:
            self.workspace.delete(path)
        except WorkspaceError as exc:
            return self._json(400, {"error": str(exc)})
        return self._json(200, {"deleted": path})

    def do_POST(self) -> None:
        route = urlparse(self.path).path
        if route not in ("/api/compile", "/api/chat", "/api/complete", "/api/edit", "/api/run"):
            return self._json(404, {"error": "not found"})
        if not self._is_local():
            return self._json(403, {"error": "local requests only"})
        body = self._read_json()
        if body is None:
            return None
        if route == "/api/compile":
            return self._compile(body)
        if route == "/api/complete":
            return self._complete(body)
        if route == "/api/run":
            return self._run(body)
        if route == "/api/edit":
            try:
                return self._edit(body)
            except (BrokenPipeError, ConnectionResetError):
                return None
        try:
            return self._chat(body)
        except (BrokenPipeError, ConnectionResetError):
            return None  # the browser stopped the stream

    # ---------------------------------------------------------- actions
    def _compile(self, body: dict) -> None:
        try:
            path = str(body.get("path", ""))
            self.workspace.resolve(path)  # the name must be a workspace path
            source = body.get("content")
            if source is None:
                source = self.workspace.read(path)
            request = CompileRequest(
                filename=Path(path).name,
                source=str(source),
                arch=str(body.get("arch") or self.toolchain.info().to_json()["default_arch"]),
                flags=validate_flags(body.get("flags")),
                allow_run=body.get("allow_run") is True,
            )
            return self._json(200, self.toolchain.compile(request))
        except (ToolchainError, WorkspaceError, ValueError) as exc:
            return self._json(400, {"error": str(exc)})

    def _run(self, body: dict) -> None:
        if not self.run_enabled:
            return self._json(403, {"error": "running files is off on this server; start it with --allow-run"})
        try:
            path = self.workspace.resolve(str(body.get("path", "")))
            if not path.is_file():
                raise WorkspaceError(f"no such file: {body.get('path')}")
            events = runner.run_file(path, self.workspace.root)
            first = next(events)  # raises RunError before any header is sent
        except (WorkspaceError, runner.RunError) as exc:
            return self._json(400, {"error": str(exc)})
        self._start_sse()
        try:
            for event in self._chain(first, events):
                self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            events.close()  # kills the process if it is still running
        return None

    @staticmethod
    def _chain(first: dict, rest):
        yield first
        yield from rest

    def _target(self, body: dict) -> tuple[dict, dict]:
        """(endpoint, request overrides) for a chat or completion request."""
        preset = ripple_api.resolve_target(body, self.custom_endpoints, self.endpoint_hosts)
        return preset, ripple_api.parse_options(body)

    def _complete(self, body: dict) -> None:
        try:
            preset, overrides = self._target(body)
            request = complete.parse_request(body)
        except ripple_api.UpstreamError as exc:
            return self._json(exc.status, exc.payload)
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        started = time.time()
        if preset["base_url"] == "mock://":
            text, source = complete.mock_complete(request), "idioms"
        else:
            plan = complete.plan_prefill(request) if ripple_api.can_prefill(preset) and not request.reason else None
            try:
                if plan:
                    raw = ripple_api.complete_once(preset, plan.messages, plan.max_tokens, complete.TEMPERATURE,
                                                   overrides, plan.prefill, plan.stop, plan.pattern)
                else:
                    raw = ripple_api.complete_once(preset, complete.build_messages(request),
                                                   complete.MAX_TOKENS, complete.TEMPERATURE, overrides)
            except ripple_api.UpstreamError as exc:
                return self._json(exc.status, exc.payload)
            text = complete.finish_prefilled(raw, request, plan) if plan else complete.clean_completion(raw, request)
            source = "ripple"
        return self._json(200, {"completion": text, "source": source, "ms": round((time.time() - started) * 1000)})

    def _edit(self, body: dict) -> None:
        try:
            preset, overrides = self._target(body)
            request = edit.parse_request(body)
        except ripple_api.UpstreamError as exc:
            return self._json(exc.status, exc.payload)
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        if preset["base_url"] == "mock://":
            self._start_sse()
            for payload in ripple_api.content_events(edit.mock_edit(request)):
                self.wfile.write(payload)
                self.wfile.flush()
                time.sleep(self.mock_delay_s)
            return None
        try:
            upstream = ripple_api.stream_once(preset, edit.build_messages(request), request.max_tokens, overrides,
                                              edit.prefill(request), edit.STOP)
        except ripple_api.UpstreamError as exc:
            return self._json(exc.status, exc.payload)
        self._start_sse()
        with upstream:
            for line in upstream:
                self.wfile.write(line)
                self.wfile.flush()
        return None

    def _chat(self, body: dict) -> None:
        messages = body.get("messages")
        try:
            preset, overrides = self._target(body)
        except ripple_api.UpstreamError as exc:
            return self._json(exc.status, exc.payload)
        if not isinstance(messages, list) or not messages:
            return self._json(400, {"error": "messages must be a non-empty list"})

        if preset["base_url"] == "mock://":
            self._start_sse()
            for payload, delay in ripple_api.mock_events(messages, self.mock_delay_s):
                self.wfile.write(payload)
                self.wfile.flush()
                if delay:
                    time.sleep(delay)
            return None

        try:
            upstream = ripple_api.open_upstream(preset, body, overrides)
        except ripple_api.UpstreamError as exc:
            return self._json(exc.status, exc.payload)
        self._start_sse()
        with upstream:
            for line in upstream:
                self.wfile.write(line)
                self.wfile.flush()
        return None

    def _start_sse(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()


def build_server(port: int, workspace: Path, ssh_host: str | None, mock_delay_s: float = 0.03,
                 host: str = "127.0.0.1", allow_hosts: tuple[str, ...] = (),
                 allow_run: bool = False, allow_custom_endpoints: bool = False,
                 endpoint_hosts: tuple[str, ...] = ()) -> ThreadingHTTPServer:
    IdeHandler.workspace = Workspace(workspace)
    IdeHandler.allowed_hosts = LOCAL_HOSTS | {host.lower()} | {name.lower().rstrip(".") for name in allow_hosts}
    IdeHandler.toolchain = Toolchain(
        ssh_host=ssh_host,
        clang_hint=os.environ.get("KERNEL_IDE_CLANG"),
        python_bin=os.environ.get("KERNEL_IDE_PYTHON", "python3"),
    )
    IdeHandler.mock_delay_s = mock_delay_s
    IdeHandler.run_enabled = allow_run or host in LOCAL_HOSTS  # code execution stays local unless asked for
    IdeHandler.custom_endpoints = allow_custom_endpoints or host in LOCAL_HOSTS  # so do calls to other local servers
    IdeHandler.endpoint_hosts = frozenset(name.lower() for name in endpoint_hosts)
    server = ThreadingHTTPServer((host, port), IdeHandler)
    server.daemon_threads = True
    return server


def main() -> None:
    parser = argparse.ArgumentParser(description="Ripple IDE server")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--workspace", type=Path, default=HERE / "workspace", help="project folder to open")
    parser.add_argument("--ssh", default=os.environ.get("KERNEL_IDE_SSH"), help="compile on this ssh host")
    parser.add_argument("--mock-delay", type=float, default=0.03, help="seconds between mock chunks")
    parser.add_argument("--host", default="127.0.0.1", help="address to listen on (default: localhost only)")
    parser.add_argument("--allow-host", action="append", default=[], help="extra host name that may reach the API")
    parser.add_argument("--allow-run", action="store_true",
                        help="let the Run button execute files when --host is not localhost")
    parser.add_argument("--allow-custom-endpoints", action="store_true",
                        help="let the lab call custom Ripple endpoints when --host is not localhost")
    parser.add_argument("--allow-endpoint-host", action="append", default=[],
                        help="extra host name a custom Ripple endpoint may use (default: localhost and private addresses)")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    server = build_server(args.port, args.workspace, args.ssh, args.mock_delay, args.host, tuple(args.allow_host),
                          args.allow_run, args.allow_custom_endpoints, tuple(args.allow_endpoint_host))
    info = IdeHandler.toolchain.info()
    log.info("Ripple IDE  ->  http://%s:%d", args.host, args.port)
    if args.host not in LOCAL_HOSTS:
        log.warning("listening on %s: every machine that reaches this address can edit the workspace%s",
                    args.host, " and run files in it" if args.allow_run else "")
    log.info("workspace: %s", IdeHandler.workspace.root)
    log.info("runner: %s | CUDA frontend: %s | ptxas: %s | triton: %s",
             info.runner, info.cuda_frontend or "none", "yes" if info.ptxas else "no", info.triton or "no")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("bye")


if __name__ == "__main__":
    main()
