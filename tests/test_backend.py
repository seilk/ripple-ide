from __future__ import annotations

import json
import os
import stat
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from ide import complete, ripple_api, runner
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

    assert len(req.prefix) == complete.MAX_PREFIX_CHARS
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
            assert sent["stream"] is False and sent["max_tokens"] == complete.MAX_TOKENS
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
