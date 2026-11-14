from __future__ import annotations

import json
import os
import stat
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from ide import ripple_api
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
    source = (ROOT / "workspace" / "rowsum.cu").read_text()

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
