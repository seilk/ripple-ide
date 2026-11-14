from __future__ import annotations

import json
import os
import stat
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from ide import complete, edit, ripple_api, runner
from ide.toolchain import (CompileRequest, Toolchain, ToolchainError, parse_diagnostics, parse_ptxas_log,
                           ptx_feature_for, validate_flags, validate_request)
from ide.workspace import Workspace, WorkspaceError
from server import build_server

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"

PTXAS_LOG = """\
ptxas info    : 0 bytes gmem
ptxas info    : Compiling entry function '_Z5saxpyfPKfPfi' for 'sm_100'
ptxas info    : Function properties for _Z5saxpyfPKfPfi
    0 bytes stack frame, 0 bytes spill stores, 0 bytes spill loads
ptxas info    : Used 8 registers, used 0 barriers, 344 bytes cmem[0]
ptxas info    : Compiling entry function '_Z6rowsumPKfPfi' for 'sm_100'
ptxas info    : Function properties for _Z6rowsumPKfPfi
    32 bytes stack frame, 8 bytes spill stores, 16 bytes spill loads
ptxas info    : Used 22 registers, used 1 barriers, 344 bytes cmem[0]
"""


# ---------------------------------------------------------------- toolchain


def test_ptxas_log_gives_registers_and_spills_per_function():
    functions = parse_ptxas_log(PTXAS_LOG)

    assert [f["function"] for f in functions] == ["_Z5saxpyfPKfPfi", "_Z6rowsumPKfPfi"]
    assert functions[0]["registers"] == 8 and functions[0]["spill_stores"] == 0
    assert functions[1] == {"function": "_Z6rowsumPKfPfi", "stack_frame": 32, "spill_stores": 8,
                            "spill_loads": 16, "registers": 22, "barriers": 1}


def test_diagnostics_parse_nvcc_clang_and_ptxas_styles():
    log = "\n".join([
        "saxpy.cu(12): error: identifier \"foo\" is undefined",
        "/tmp/x/saxpy.cu:7:14: warning: implicit conversion",
        "ptxas out.ptx, line 31; error   : Unknown symbol 'bar'",
        "1 error detected in the compilation of saxpy.cu.",
    ])

    found = parse_diagnostics(log)

    assert [(d["file"], d["line"], d["severity"]) for d in found] == [
        ("saxpy.cu", 12, "error"), ("saxpy.cu", 7, "warning"), ("out.ptx", 31, "error")]
    assert found[1]["col"] == 14


@pytest.mark.parametrize("flags", ["-O2 -DN=4 -Iinclude/cuda -std=c++17", ["--use_fast_math"], None, ""])
def test_safe_flags_pass(flags):
    assert isinstance(validate_flags(flags), tuple)


@pytest.mark.parametrize("flags", ["-o /etc/passwd", "; rm -rf ~", "-Xcompiler,-wrapper,sh", "$(id)", "-I../../x;id"])
def test_unsafe_flags_are_rejected(flags):
    with pytest.raises(ToolchainError):
        validate_flags(flags)


def test_request_validation_rejects_bad_names_and_archs():
    assert validate_request(CompileRequest("a.cu", "")) == "cuda"
    assert validate_request(CompileRequest("a.ptx", "")) == "ptx"
    assert validate_request(CompileRequest("a.py", "")) == "triton"
    for bad in (CompileRequest("a b.cu", ""), CompileRequest("a.cu", "", arch="sm_100; id"),
                CompileRequest("a.txt", ""), CompileRequest(".hidden.cu", "")):
        with pytest.raises(ToolchainError):
            validate_request(bad)


def test_ptx_feature_follows_arch():
    assert (ptx_feature_for("sm_80"), ptx_feature_for("sm_100"), ptx_feature_for("sm_120")) == (
        "ptx78", "ptx86", "ptx87")


def test_triton_needs_the_run_flag():
    with pytest.raises(ToolchainError, match="Run button"):
        Toolchain().compile(CompileRequest("k.py", "print(1)"))


def _fake_tool(directory: Path, name: str, body: str) -> None:
    path = directory / name
    path.write_text("#!/bin/bash\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def test_nvcc_and_ptxas_path_with_stand_in_tools(tmp_path, monkeypatch):
    """Stand-in nvcc/ptxas check the plumbing: flags, PTX hand-off, log parsing."""
    fixture = FIXTURES / "kernels_sm100.ptx"
    _fake_tool(tmp_path, "nvcc", f'echo "$@" > "{tmp_path}/nvcc.args"\n'
               'while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\n'
               f'if test "${{out:-}}"; then cp "{fixture}" "$out"; fi\n')
    _fake_tool(tmp_path, "ptxas", f"cat <<'EOF'\n{PTXAS_LOG}EOF\n")
    monkeypatch.setenv("PATH", f"{tmp_path}:{os.environ['PATH']}")

    result = Toolchain().compile(CompileRequest("saxpy.cu", "// src", arch="sm_100", flags=("-DN=4",)))

    assert result["ok"] and result["backend"] == "nvcc"
    assert ".entry _Z5saxpyfPKfPfi" in result["ptx"]
    assert result["ptxas"]["functions"][1]["registers"] == 22
    args = (tmp_path / "nvcc.args").read_text()
    assert "-ptx -lineinfo -O3 -arch=sm_100 -DN=4 saxpy.cu" in args


def test_clang_preview_compiles_a_real_kernel():
    chain = Toolchain()
    if chain.info(refresh=True).cuda_frontend != "clang-nvptx":
        pytest.skip("needs a clang with the NVPTX target and no nvcc")
    source = (ROOT / "workspace" / "kernels" / "rowsum.cu").read_text()

    result = chain.compile(CompileRequest("rowsum.cu", source, arch="sm_100"))

    assert result["ok"], result["frontend"]["log"]
    assert ".target sm_100" in result["ptx"] and "bar.sync" in result["ptx"]
    assert any("not from nvcc" in note for note in result["notes"])


def test_clang_preview_reports_source_errors_with_lines():
    chain = Toolchain()
    if chain.info(refresh=True).cuda_frontend != "clang-nvptx":
        pytest.skip("needs a clang with the NVPTX target and no nvcc")

    result = chain.compile(CompileRequest("bad.cu", "__global__ void f() {\n  int x = ;\n}\n"))

    assert not result["ok"]
    assert result["diagnostics"][0]["file"] == "bad.cu" and result["diagnostics"][0]["line"] == 2


# ---------------------------------------------------------------- workspace


def test_workspace_round_trip_and_listing(tmp_path):
    ws = Workspace(tmp_path)
    ws.write("sub/k.cu", "int x;")
    (tmp_path / ".secret").write_text("no")

    assert ws.read("sub/k.cu") == "int x;"
    assert [e["path"] for e in ws.list()] == ["sub/k.cu"]


@pytest.mark.parametrize("path", ["../x", "/etc/passwd", ".env", "a/../../x", "", "sub/.git/config"])
def test_workspace_rejects_paths_outside_or_hidden(tmp_path, path):
    with pytest.raises(WorkspaceError):
        Workspace(tmp_path).resolve(path)


def test_workspace_rejects_symlink_escape(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "root"
    root.mkdir()
    (root / "link").symlink_to(outside)

    with pytest.raises(WorkspaceError):
        Workspace(root).resolve("link/file.cu")


# ---------------------------------------------------------------- mock Ripple


def _decode(events) -> list[dict]:
    out = []
    for payload, _ in events:
        text = payload.decode().removeprefix("data: ").strip()
        if text != "[DONE]":
            out.append(json.loads(text))
    return out


def test_mock_reads_then_compiles_then_summarizes():
    system = {"role": "system", "content": "x\nActive file: saxpy.cu\ny"}
    user = {"role": "user", "content": "why is this slow?"}

    first = ripple_api.mock_plan([system, user])
    call = {"role": "assistant", "tool_calls": [{"function": {"name": "read_file", "arguments": "{}"}}]}
    second = ripple_api.mock_plan([system, user, call, {"role": "tool", "content": "src"}])
    call2 = {"role": "assistant", "tool_calls": [{"function": {"name": "compile_kernel", "arguments": "{}"}}]}
    report = json.dumps({"ok": True, "backend": "nvcc", "arch": "sm_100",
                         "functions": [{"name": "saxpy", "instructions": 20, "loops": 0, "registers": 8}],
                         "lints": [{"code": "fp64"}, {"code": "fp64"}]})
    third = ripple_api.mock_plan([system, user, call, {"role": "tool", "content": "src"},
                                  call2, {"role": "tool", "content": report}])

    assert first[2] == ("read_file", {"path": "saxpy.cu"})
    assert second[2] == ("compile_kernel", {"path": "saxpy.cu"})
    assert third[2] is None and "fp64 ×2" in third[1] and "8 registers" in third[1]


def test_mock_stream_splits_tool_arguments_and_ends_with_usage():
    system = {"role": "system", "content": "Active file: k.cu"}
    events = _decode(ripple_api.mock_events([system, {"role": "user", "content": "hi"}], 0))

    fragments = [c["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"]
                 for c in events if c["choices"] and c["choices"][0]["delta"].get("tool_calls")]
    assert json.loads("".join(fragments)) == {"path": "k.cu"} and len(fragments) >= 4
    assert events[-1]["usage"]["total_tokens"] > 0


# ---------------------------------------------------------------- HTTP


@pytest.fixture()
def ide(tmp_path):
    (tmp_path / "k.ptx").write_text((FIXTURES / "kernels_sm100.ptx").read_text())
    server = build_server(0, tmp_path, None, mock_delay_s=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def _call(url: str, method: str = "GET", body: dict | None = None, headers: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read().decode(), response.headers
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode(), exc.headers


def test_http_file_round_trip_and_traversal_block(ide):
    status, _, _ = _call(f"{ide}/api/file", "PUT", {"path": "new/a.cu", "content": "int a;"})
    assert status == 200
    status, body, _ = _call(f"{ide}/api/file?path=new/a.cu")
    assert json.loads(body)["content"] == "int a;"
    status, body, _ = _call(f"{ide}/api/file?path=../../etc/passwd")
    assert status == 400 and "not allowed" in body


def test_http_rejects_foreign_origin_and_host(ide):
    assert _call(f"{ide}/api/files", headers={"Origin": "https://evil.example"})[0] == 403
    assert _call(f"{ide}/api/files", headers={"Host": "evil.example"})[0] == 403


def test_http_compile_ptx_file_returns_its_text(ide):
    status, body, _ = _call(f"{ide}/api/compile", "POST", {"path": "k.ptx", "arch": "sm_100"})
    result = json.loads(body)

    assert status == 200 and result["backend"] == "ptx" and ".entry" in result["ptx"]


def test_http_compile_rejects_unsafe_flags(ide):
    status, body, _ = _call(f"{ide}/api/compile", "POST", {"path": "k.ptx", "flags": "-o /tmp/x"})
    assert status == 400 and "flag not allowed" in body


def test_http_chat_mock_streams_and_pages_carry_csp(ide):
    status, body, _ = _call(f"{ide}/api/chat", "POST", {
        "preset": "mock", "messages": [{"role": "system", "content": "Active file: k.ptx"},
                                       {"role": "user", "content": "check"}]})
    assert status == 200 and '"read_file"' in body and body.rstrip().endswith("data: [DONE]")
    status, _, headers = _call(f"{ide}/")
    assert status == 200 and "default-src 'self'" in headers["Content-Security-Policy"]


def test_http_shared_host_must_be_allowed_by_name(tmp_path):
    server = build_server(0, tmp_path, None, mock_delay_s=0, allow_hosts=("box.tailnet.ts.net.",))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/api/files"
    try:
        assert _call(url, headers={"Host": "box.tailnet.ts.net:8787"})[0] == 200
        assert _call(url, headers={"Host": "box.tailnet.ts.net:8787", "Origin": "https://box.tailnet.ts.net:8787"})[0] == 200
        assert _call(url, headers={"Host": "other.tailnet.ts.net:8787"})[0] == 403
        assert _call(url, headers={"Host": "box.tailnet.ts.net:8787", "Origin": "https://evil.example"})[0] == 403
    finally:
        server.shutdown()


# ---------------------------------------------------------------- inline completion


def _req(prefix: str, suffix: str = "", language: str = "cuda") -> complete.CompletionRequest:
    return complete.parse_request({"path": "k.cu", "language": language, "prefix": prefix, "suffix": suffix})


@pytest.mark.parametrize(("language", "prefix", "expected"), [
    ("cuda", "  int i = ", "blockIdx.x * blockDim.x + threadIdx.x;"),
    ("cuda", "  y[i] = a * x[i] + 0.5", "f"),
    ("cuda", "  __sync", "threads();"),
    ("triton", "    offsets = ", "tl.arange(0, BLOCK)"),
    ("ptx", "\tld.", "global.f32 \t%f1, [%rd1];"),
])
def test_idioms_complete_kernel_patterns(language, prefix, expected):
    assert complete.mock_complete(_req("x\n" + prefix, language=language)) == expected


def test_idioms_stay_quiet_mid_line_and_on_other_text():
    assert complete.mock_complete(_req("  int i = ", suffix="foo(); // rest")) == ""
    assert complete.mock_complete(_req("  int i = ", suffix=");\nnext")) != ""
    assert complete.mock_complete(_req("  float x = y")) == ""
    assert complete.mock_complete(_req("  y = 0.5f")) == ""
    assert complete.mock_complete(_req("  v1.5")) == ""  # not a float literal


def test_model_answer_is_cleaned_for_ghost_text():
    req = _req("void f() {\n  int i = ", suffix="\n  if (i < n) return;\n}")

    fenced = complete.clean_completion("```cpp\nblockIdx.x * blockDim.x + threadIdx.x;\n```", req)
    echoed = complete.clean_completion("  int i = threadIdx.x;", req)
    overrun = complete.clean_completion("threadIdx.x;\n  if (i < n) return;\n}", req)
    long = complete.clean_completion("\n".join(f"line{n};" for n in range(40)), req)

    assert fenced == "blockIdx.x * blockDim.x + threadIdx.x;"
    assert echoed == "threadIdx.x;"
    assert overrun == "threadIdx.x;"
    assert len(long.split("\n")) == complete.MAX_LINES
    assert complete.clean_completion("   \n", req) == ""


def test_completion_prompt_carries_findings_and_both_sides():
    req = complete.parse_request({"path": "k.cu", "language": "cuda", "prefix": "A" * 9000, "suffix": "tail",
                                  "findings": ["fp64 at source line 7"]})
    system, user = complete.build_messages(req)

    assert 4000 <= len(req.prefix) <= complete.MAX_PREFIX_CHARS
    assert "f suffix" in system["content"]
    assert "fp64 at source line 7" in user["content"] and "<after_cursor>\ntail" in user["content"]


@pytest.mark.parametrize("body", [{"language": "ja va; rm", "prefix": ""}, {"language": "cuda"},
                                  {"language": "cuda", "prefix": "x", "findings": "nope"}])
def test_completion_request_validation(body):
    with pytest.raises(ValueError):
        complete.parse_request(body)


def test_http_complete_mock_and_bad_request(ide):
    status, body, _ = _call(f"{ide}/api/complete", "POST", {
        "preset": "mock", "language": "cuda", "path": "k.cu", "prefix": "  float s = 0.25", "suffix": ""})
    assert status == 200 and json.loads(body)["completion"] == "f" and json.loads(body)["source"] == "idioms"
    assert _call(f"{ide}/api/complete", "POST", {"preset": "mock", "language": "c o b o l", "prefix": ""})[0] == 400


def test_http_complete_uses_the_model_answer(ide, monkeypatch):
    import http.server

    class Upstream(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            sent = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert sent["stream"] is False and sent["max_tokens"] == complete.SINGLE_LINE_MAX_TOKENS
            answer = json.dumps({"choices": [{"message": {"content": "```\n  int i = threadIdx.x;\n```"}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(answer)))
            self.end_headers()
            self.wfile.write(answer)

        def log_message(self, *args):
            pass

    upstream = http.server.HTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    monkeypatch.setitem(ripple_api.PRESETS["runtime"], "base_url", f"http://127.0.0.1:{upstream.server_address[1]}/v1")
    try:
        status, body, _ = _call(f"{ide}/api/complete", "POST", {
            "preset": "runtime", "language": "cuda", "prefix": "void f() {\n  int i = ", "suffix": "\n}"})
    finally:
        upstream.shutdown()

    assert status == 200 and json.loads(body) | {"ms": 0} == {"completion": "threadIdx.x;", "source": "ripple", "ms": 0}


def test_completion_is_general_and_kernel_rules_apply_to_kernel_files_only():
    python = complete.parse_request({"language": "python", "prefix": "if __name__ == ", "path": "a.py"})
    cuda = complete.parse_request({"language": "cuda", "prefix": "x", "path": "k.cu"})

    assert complete.mock_complete(python).startswith('"__main__":')
    assert "GPU kernel" not in complete.build_messages(python)[0]["content"]
    assert "GPU kernel" in complete.build_messages(cuda)[0]["content"]


# ---------------------------------------------------------------- run, search, delete


def test_run_file_streams_output_and_exit_code(tmp_path):
    script = tmp_path / "hi.py"
    script.write_text("import sys\nprint('hello')\nprint('oops', file=sys.stderr)\nsys.exit(3)\n")

    events = [e for e in runner.run_file(script, tmp_path) if e["type"] != "ping"]

    assert "hello\n" in [e.get("text") for e in events] and "oops\n" in [e.get("text") for e in events]
    assert events[-1]["type"] == "exit" and events[-1]["code"] == 3 and events[-1]["command"] == "python3 -u hi.py"


def test_run_file_stops_at_the_time_limit(tmp_path):
    script = tmp_path / "loop.py"
    script.write_text("import time\nprint('start', flush=True)\ntime.sleep(30)\n")

    events = list(runner.run_file(script, tmp_path, timeout_s=1.5))

    assert events[-1]["note"] == "stopped after 1 s" and events[-1]["code"] != 0
    assert events[-1]["seconds"] < 6


def test_run_rejects_files_without_an_interpreter(tmp_path):
    with pytest.raises(runner.RunError, match="no interpreter"):
        next(runner.run_file(tmp_path / "a.cu", tmp_path))


def test_workspace_search_and_delete(tmp_path):
    ws = Workspace(tmp_path)
    ws.write("a/one.py", "alpha\nBeta gamma\n")
    ws.write("two.txt", "beta\n")

    hits = ws.search("BETA")
    ws.delete("two.txt")

    assert [(h["path"], h["line"]) for h in hits] == [("a/one.py", 2), ("two.txt", 1)]
    assert [e["path"] for e in ws.list()] == ["a/one.py"]
    with pytest.raises(WorkspaceError):
        ws.delete("../outside")
    with pytest.raises(WorkspaceError):
        ws.search("x")


def test_http_run_search_delete(ide):
    _call(f"{ide}/api/file", "PUT", {"path": "say.py", "content": "print('ran ok')\n"})

    status, body, _ = _call(f"{ide}/api/run", "POST", {"path": "say.py"})
    assert status == 200 and "ran ok" in body and '"type": "exit"' in body and '"code": 0' in body
    status, body, _ = _call(f"{ide}/api/search?q=ran%20ok")
    assert json.loads(body)["hits"][0]["path"] == "say.py"
    assert _call(f"{ide}/api/run", "POST", {"path": "k.ptx"})[0] == 400
    assert _call(f"{ide}/api/file?path=say.py", "DELETE")[0] == 200
    assert _call(f"{ide}/api/file?path=say.py")[0] == 400
    assert json.loads(_call(f"{ide}/api/files")[1])["run"]["enabled"] is True


def test_http_run_is_off_on_a_shared_host_unless_allowed(tmp_path):
    (tmp_path / "say.py").write_text("print(1)\n")
    off = build_server(0, tmp_path, None, allow_hosts=("box.ts.net",))
    off.RequestHandlerClass.run_enabled = False  # what build_server sets for a non-local --host
    threading.Thread(target=off.serve_forever, daemon=True).start()
    try:
        status, body, _ = _call(f"http://127.0.0.1:{off.server_address[1]}/api/run", "POST", {"path": "say.py"})
    finally:
        off.shutdown()
        off.RequestHandlerClass.run_enabled = True

    assert status == 403 and "--allow-run" in body


# ---------------------------------------------------------------- lab: endpoints and overrides


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.9", "100.99.1.2", "::1"])
def test_local_and_private_endpoint_hosts_are_allowed(host):
    assert ripple_api.endpoint_host_allowed(host)


@pytest.mark.parametrize("host", ["example.com", "8.8.8.8", "metadata.internal", "100.128.0.1"])
def test_public_or_named_endpoint_hosts_are_refused(host):
    assert not ripple_api.endpoint_host_allowed(host)
    assert ripple_api.endpoint_host_allowed(host, frozenset({host}))


def test_resolve_target_accepts_a_custom_local_endpoint_and_refuses_others():
    target = ripple_api.resolve_target({"endpoint": {"base_url": "http://127.0.0.1:8001/v1/", "model": "ripple-opt"}})
    assert target["base_url"] == "http://127.0.0.1:8001/v1" and target["model"] == "ripple-opt"
    assert ripple_api.resolve_target({"preset": "mock"}) is ripple_api.PRESETS["mock"]
    for body in ({"endpoint": {"base_url": "http://example.com/v1", "model": "m"}},
                 {"endpoint": {"base_url": "file:///etc/passwd", "model": "m"}},
                 {"endpoint": {"base_url": "http://127.0.0.1:8001/v1", "model": "bad model"}},
                 {"preset": "nope"}):
        with pytest.raises(ripple_api.UpstreamError):
            ripple_api.resolve_target(body)
    with pytest.raises(ripple_api.UpstreamError, match="--allow-custom-endpoints"):
        ripple_api.resolve_target({"endpoint": {"base_url": "http://127.0.0.1:1/v1", "model": "m"}}, custom_enabled=False)


def test_options_become_request_overrides_without_reserved_keys():
    overrides = ripple_api.parse_options({"options": {
        "temperature": 0.1, "top_p": 0.9, "max_tokens": 64,
        "extra_body": {"top_k": 20, "model": "evil", "messages": [], "stream": True}}})

    assert overrides == {"top_k": 20, "temperature": 0.1, "top_p": 0.9, "max_tokens": 64}
    for bad in ({"temperature": 9}, {"max_tokens": 0}, {"top_p": "x"}, {"extra_body": [1]}):
        with pytest.raises(ripple_api.UpstreamError):
            ripple_api.parse_options({"options": bad})


def test_completion_options_change_context_size_line_limit_and_prompt():
    req = complete.parse_request({"language": "python", "prefix": "a" * 5000, "suffix": "b" * 900, "options": {
        "prefix_chars": 300, "suffix_chars": 0, "max_lines": 2, "system_extra": "Prefer one line."}})

    assert (len(req.prefix), len(req.suffix), req.max_lines) == (300, 0, 2)
    assert complete.build_messages(req)[0]["content"].endswith("Prefer one line.")
    assert complete.clean_completion("one\ntwo\nthree", req) == "one\ntwo"
    with pytest.raises(ValueError, match="prefix_chars"):
        complete.parse_request({"language": "python", "prefix": "", "options": {"prefix_chars": 5}})


def test_http_custom_endpoint_gets_the_overrides(ide):
    import http.server
    seen = {}

    class Upstream(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            seen.update(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            answer = json.dumps({"choices": [{"message": {"content": "threadIdx.x;"}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(answer)))
            self.end_headers()
            self.wfile.write(answer)

        def log_message(self, *args):
            pass

    upstream = http.server.HTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    try:
        status, body, _ = _call(f"{ide}/api/complete", "POST", {
            "endpoint": {"base_url": f"http://127.0.0.1:{upstream.server_address[1]}/v1", "model": "ripple-opt"},
            "language": "cuda", "prefix": "int i = ", "suffix": "",
            "options": {"temperature": 0.0, "max_tokens": 32, "extra_body": {"top_k": 5}}})
    finally:
        upstream.shutdown()

    assert status == 200 and json.loads(body)["completion"] == "threadIdx.x;"
    assert (seen["model"], seen["temperature"], seen["max_tokens"], seen["top_k"], seen["stream"]) == (
        "ripple-opt", 0.0, 32, 5, False)
    assert _call(f"{ide}/api/complete", "POST", {"endpoint": {"base_url": "http://example.com/v1", "model": "m"},
                                                   "language": "cuda", "prefix": "x"})[0] == 400
    assert json.loads(_call(f"{ide}/api/presets")[1])["custom_endpoints"] is True


def test_prefill_plan_starts_the_reply_with_the_current_line():
    plan = complete.plan_prefill(_req("void f() {\n  int i = ", suffix="\n}"))

    assert plan.prefill == complete.EMPTY_THINK + "```cpp\n  int i ="
    assert plan.stop[:2] == ["\n", "```"] and plan.strip_space and plan.typed_word == ""
    assert "<before_cursor>\nvoid f() {\n</before_cursor>" in plan.messages[1]["content"]  # without the current line
    assert "GPU kernel" in plan.messages[0]["content"]


def test_prefill_plan_backs_up_over_a_half_typed_word():
    """Seen with the real model: a prefill that ends inside a word gets an empty answer."""
    req = _req("import math\nimport num", suffix="\n", language="python")
    plan = complete.plan_prefill(req)

    assert plan.prefill.endswith("```python\nimport") and plan.typed_word == "num"
    assert complete.finish_prefilled(" numpy as np", req, plan) == "py as np"
    assert complete.finish_prefilled(" os", req, plan) == ""  # not the word being typed


def test_prefill_plan_at_a_line_start_allows_several_lines():
    req = _req("def f(n):\n    ", suffix="\n\nprint(f(3))\n", language="python")
    plan = complete.plan_prefill(req)

    assert plan.prefill == complete.EMPTY_THINK + "```python\n" and "\n" not in plan.stop
    assert complete.finish_prefilled("    if n < 2:\n        return n\n", req, plan) == "if n < 2:\n        return n"
    assert plan.mid_line is False and plan.max_tokens == complete.MAX_TOKENS


def test_finish_drops_text_that_already_follows_the_cursor():
    req = _req("const names = users.map((user) => ", suffix=");\n", language="javascript")
    plan = complete.plan_prefill(req)

    assert complete.finish_prefilled(" user.name);", req, plan) == "user.name"


def test_http_suggestion_request_is_prefilled_unless_reasoning_is_on(ide):
    import http.server
    seen = []

    class Upstream(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            seen.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            answer = json.dumps({"choices": [{"message": {"content": " threadIdx.x;"}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(answer)))
            self.end_headers()
            self.wfile.write(answer)

        def log_message(self, *args):
            pass

    upstream = http.server.HTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    body = {"endpoint": {"base_url": f"http://127.0.0.1:{upstream.server_address[1]}/v1", "model": "ripple"},
            "language": "cuda", "prefix": "int i = ", "suffix": ""}
    try:
        status, fast_body, _ = _call(f"{ide}/api/complete", "POST", body)
        _call(f"{ide}/api/complete", "POST", {**body, "options": {"reason": True}})
    finally:
        upstream.shutdown()

    fast, slow = seen
    assert json.loads(fast_body)["completion"] == "threadIdx.x;"
    assert fast["messages"][-1] == {"role": "assistant", "content": complete.EMPTY_THINK + "```cpp\nint i ="}
    assert fast["continue_final_message"] is True and fast["add_generation_prompt"] is False and fast["stop"][:2] == ["\n", "```"]
    assert fast["structured_outputs"] == {"regex": "[^\\n]+\\n"} and fast["max_tokens"] == complete.SINGLE_LINE_MAX_TOKENS
    assert fast["temperature"] == 0.0
    assert slow["messages"][-1]["role"] == "user" and "continue_final_message" not in slow and "stop" not in slow


def test_context_window_start_holds_still_while_typing():
    lines = "".join(f"line {n:05d} of the file\n" for n in range(1000))  # 24 chars a line
    starts = {complete.stable_window(lines + "x" * typed, 6000)[:24] for typed in range(0, 1500, 7)}

    assert len(starts) <= 2  # at most one move in 1500 typed characters
    window = complete.stable_window(lines, 6000)
    assert window.startswith("line ") and 4000 <= len(window) <= 6000
    assert complete.stable_window("short", 6000) == "short"


@pytest.mark.parametrize(("prefix", "pattern"), [
    ("import num", " ?num[^\\n]*\\n"),          # half-typed word: the answer starts with it
    ("  console.", "[^\\n]+\\n"),               # open line: some text is required
    ("  x = ", "[^\\n]+\\n"),
    ("  return 0;", None),                           # complete line: free to stay empty
    ("if ready:", None),
])
def test_line_pattern_follows_how_the_line_ends(prefix, pattern):
    assert complete.plan_prefill(_req("x\n" + prefix)).pattern == pattern


def test_single_line_requests_get_a_small_token_budget():
    assert complete.plan_prefill(_req("  x = ")).max_tokens == complete.SINGLE_LINE_MAX_TOKENS
    assert complete.plan_prefill(_req("def f():\n    ")).max_tokens == complete.MAX_TOKENS
    assert complete.plan_prefill(_req("def f():\n    ")).pattern is None


# ---------------------------------------------------------------- inline edit


def test_edit_request_validation_and_token_budget():
    req = edit.parse_request({"language": "python", "selection": "x = 1\n" * 400, "instruction": " rename x to total ",
                              "before": "a" * 9000, "after": "b" * 9000, "path": "a.py"})

    assert (len(req.before), len(req.after), req.instruction) == (edit.CONTEXT_CHARS, edit.CONTEXT_CHARS, "rename x to total")
    assert req.max_tokens == len(req.selection) // 2 + edit.MAX_TOKENS_FLOOR
    assert edit.prefill(req) == complete.EMPTY_THINK + "```python\n"
    assert "<selected>\nx = 1" in edit.build_messages(req)[1]["content"]
    for bad in ({"language": "python", "selection": "  ", "instruction": "x"},
                {"language": "python", "selection": "x", "instruction": ""},
                {"language": "python", "selection": "x" * 30000, "instruction": "y"}):
        with pytest.raises(ValueError):
            edit.parse_request(bad)


def test_http_edit_mock_streams_the_new_text(ide):
    status, body, _ = _call(f"{ide}/api/edit", "POST", {
        "preset": "mock", "language": "python", "path": "a.py", "selection": "    return 1", "instruction": "use two"})
    text = "".join(json.loads(line[6:])["choices"][0]["delta"].get("content", "")
                   for line in body.splitlines() if line.startswith("data: {") and json.loads(line[6:])["choices"])

    assert status == 200 and text == "    # mock edit: use two\n    return 1" and body.rstrip().endswith("[DONE]")
    assert _call(f"{ide}/api/edit", "POST", {"preset": "mock", "language": "python", "selection": "", "instruction": "x"})[0] == 400


def test_http_edit_sends_a_prefilled_stream_request(ide):
    import http.server
    seen = {}

    class Upstream(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            seen.update(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for word in ("total", " = 2\n"):
                self.wfile.write(f"data: {json.dumps({'choices': [{'delta': {'content': word}}]})}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")

        def log_message(self, *args):
            pass

    upstream = http.server.HTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    try:
        status, body, _ = _call(f"{ide}/api/edit", "POST", {
            "endpoint": {"base_url": f"http://127.0.0.1:{upstream.server_address[1]}/v1", "model": "ripple"},
            "language": "python", "selection": "x = 1", "instruction": "call it total and use 2"})
    finally:
        upstream.shutdown()

    assert status == 200 and '"content": "total"' in body
    assert seen["stream"] is True and seen["stop"] == edit.STOP and seen["continue_final_message"] is True
    assert seen["messages"][-1] == {"role": "assistant", "content": complete.EMPTY_THINK + "```python\n"}


def test_http_says_so_when_the_ripple_server_accepts_and_hangs_up(ide):
    """A port forward does this while the server behind it is still starting. The browser used to get no answer at all."""
    import socket
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(8)
    stop = threading.Event()

    def hang_up():
        listener.settimeout(0.2)
        while not stop.is_set():
            try:
                connection, _ = listener.accept()
                connection.close()
            except TimeoutError:
                pass

    threading.Thread(target=hang_up, daemon=True).start()
    endpoint = {"endpoint": {"base_url": f"http://127.0.0.1:{listener.getsockname()[1]}/v1", "model": "ripple"}}
    try:
        results = [
            _call(f"{ide}/api/complete", "POST", {**endpoint, "language": "python", "prefix": "x = ", "suffix": ""}),
            _call(f"{ide}/api/chat", "POST", {**endpoint, "messages": [{"role": "user", "content": "hey"}]}),
            _call(f"{ide}/api/edit", "POST", {**endpoint, "language": "python", "selection": "x = 1", "instruction": "y"}),
        ]
    finally:
        stop.set()
        listener.close()

    for status, body, _ in results:
        assert status == 502 and "does not answer" in body or "closed the connection" in body


def test_http_ripple_status_for_mock_and_for_a_dead_endpoint(ide):
    ok = json.loads(_call(f"{ide}/api/ripple-status", "POST", {"preset": "mock"})[1])
    dead = json.loads(_call(f"{ide}/api/ripple-status", "POST", {"endpoint": {"base_url": "http://127.0.0.1:9/v1", "model": "m"}})[1])

    assert ok["ok"] is True
    assert dead["ok"] is False and "does not answer" in dead["detail"]


# ---------------------------------------------------------------- status details and preview


def test_metrics_page_is_reduced_to_a_few_numbers():
    page = """# HELP vllm:num_requests_running Number of requests
vllm:num_requests_running{engine="0",model_name="m"} 2.0
vllm:num_requests_waiting{engine="0",model_name="m"} 1.0
vllm:kv_cache_usage_perc{engine="0",model_name="m"} 0.125
vllm:generation_tokens_total{engine="0",model_name="m"} 5000.0
vllm:request_success_total{engine="0",finished_reason="stop",model_name="m"} 40.0
vllm:request_success_total{engine="0",finished_reason="length",model_name="m"} 2.0
vllm:spec_decode_num_drafts_total{engine="0",model_name="m"} 100.0
vllm:spec_decode_num_accepted_tokens_total{engine="0",model_name="m"} 230.0
vllm:time_to_first_token_seconds_bucket{le="0.1"} 7.0
"""
    assert ripple_api.parse_metrics(page) == {
        "running": 2.0, "waiting": 1.0, "kv_cache_usage": 0.125, "generation_tokens": 5000.0,
        "requests_done": 42.0, "spec_drafts": 100.0, "spec_accepted_tokens": 230.0}


def test_http_preview_serves_the_draft_in_a_sandbox(ide):
    _call(f"{ide}/api/file", "PUT", {"path": "site/index.html", "content": "<h1>saved</h1>"})
    _call(f"{ide}/api/file", "PUT", {"path": "site/style.css", "content": "h1 { color: red; }"})

    status, body, headers = _call(f"{ide}/preview/site/index.html")
    assert status == 200 and body == "<h1>saved</h1>" and headers["Content-Type"].startswith("text/html")
    assert headers["Content-Security-Policy"].startswith("sandbox allow-scripts") and "allow-same-origin" not in headers["Content-Security-Policy"]
    assert headers.get("X-Frame-Options") is None
    assert _call(f"{ide}/preview/site/style.css")[2]["Content-Type"].startswith("text/css")

    _call(f"{ide}/api/preview-draft", "POST", {"path": "site/index.html", "content": "<h1>typing</h1>"})
    assert _call(f"{ide}/preview/site/index.html")[1] == "<h1>typing</h1>"
    _call(f"{ide}/api/preview-draft", "POST", {"path": "site/index.html", "content": None})
    assert _call(f"{ide}/preview/site/index.html")[1] == "<h1>saved</h1>"

    assert _call(f"{ide}/preview/../server.py")[0] == 404
    assert _call(f"{ide}/api/preview-draft", "POST", {"path": "../x", "content": "y"})[0] == 400
    assert _call(f"{ide}/api/files", headers={"Origin": "null"})[0] == 403  # a sandboxed page cannot call the API
    assert _call(f"{ide}/")[2]["X-Frame-Options"] == "DENY"                  # the IDE itself still cannot be framed


# ---------------------------------------------------------------- blocks: indentation and completeness


def _block(prefix: str, raw: str, truncated: bool = False, suffix: str = "\n", max_lines: int | None = None) -> str:
    body = {"language": "python", "path": "a.py", "prefix": prefix, "suffix": suffix}
    if max_lines:
        body["options"] = {"max_lines": max_lines}
    req = complete.parse_request(body)
    return complete.finish_prefilled(raw, req, complete.plan_prefill(req), truncated)


METHOD = "class S:\n    def f(self, xs):\n"
BODY = "        total = 0\n        for x in xs:\n            total += x\n        return total\n"


@pytest.mark.parametrize("cursor_indent", ["", "    ", "        "])
def test_block_lands_at_the_right_indentation_wherever_the_cursor_is(cursor_indent):
    text = _block(METHOD + cursor_indent, BODY)

    compile(METHOD + cursor_indent + text + "\n", "a.py", "exec")  # no IndentationError
    assert (cursor_indent + text).splitlines()[0] == "        total = 0"


def test_block_that_belongs_further_left_starts_on_the_next_line():
    """The cursor sits inside the loop, but the next code is the return after it."""
    before = METHOD + "        for x in xs:\n            pass\n            "
    text = _block(before, "        return 0\n")

    assert text == "\n        return 0"
    compile(before + text + "\n", "a.py", "exec")


def test_block_stops_where_its_own_block_ends_and_drops_a_cut_last_line():
    ran_on = BODY + "\n    def g(self):\n        return 1\n"
    assert _block(METHOD + "        ", ran_on).splitlines()[-1] == "        return total"  # no second method

    cut = "        total = 0\n        for x in xs:\n            total += x\n        retu"
    assert _block(METHOD + "        ", cut, truncated=True).splitlines()[-1] == "            total += x"
    assert _block(METHOD + "        ", cut, truncated=False).splitlines()[-1] == "        retu"  # a full answer is kept as it is


def test_block_keeps_thirty_lines_by_default_and_follows_the_line_limit():
    long_body = "".join(f"        v{n} = {n}\n" for n in range(50))

    assert len(_block(METHOD + "        ", long_body).splitlines()) == complete.MAX_LINES == 30
    assert len(_block(METHOD + "        ", long_body, max_lines=5).splitlines()) == 5
    assert _block(METHOD + "        ", BODY, suffix="\n        return total\n").splitlines()[-1] == "            total += x"


# ---------------------------------------------------------------- folder deletion


def test_workspace_deletes_a_folder_with_everything_in_it(tmp_path):
    ws = Workspace(tmp_path)
    ws.write("notes/a.py", "a")
    ws.write("notes/deep/b.py", "b")
    ws.write("keep.py", "k")

    gone = ws.delete_folder("notes")

    assert sorted(gone) == ["notes/a.py", "notes/deep/b.py"]
    assert [e["path"] for e in ws.list()] == ["keep.py"] and not (tmp_path / "notes").exists()


def test_workspace_refuses_to_delete_the_root_a_file_or_a_folder_outside(tmp_path):
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (outside / "x.py").write_text("x")
    (root / "link").symlink_to(outside)
    ws = Workspace(root)
    ws.write("a.py", "a")

    for path in ("a.py", "missing", "../outside", "link", ".", ""):
        with pytest.raises(WorkspaceError):
            ws.delete_folder(path)
    assert (outside / "x.py").exists() and (root / "a.py").exists()


def test_http_folder_delete(ide):
    _call(f"{ide}/api/file", "PUT", {"path": "scratch/one.py", "content": "1"})
    _call(f"{ide}/api/file", "PUT", {"path": "scratch/two/three.py", "content": "3"})

    status, body, _ = _call(f"{ide}/api/folder?path=scratch", "DELETE")

    assert status == 200 and sorted(json.loads(body)["files"]) == ["scratch/one.py", "scratch/two/three.py"]
    assert not any(f["path"].startswith("scratch/") for f in json.loads(_call(f"{ide}/api/files")[1])["files"])
    assert _call(f"{ide}/api/folder?path=scratch", "DELETE")[0] == 400
    assert _call(f"{ide}/api/folder?path=..", "DELETE")[0] == 400
    assert _call(f"{ide}/api/folder?path=k.ptx", "DELETE")[0] == 400  # a file is not a folder
