"""Kernel toolchain: source -> PTX (-> ptxas statistics).

One bash script does the whole job. It runs with ``bash -s`` on this machine or
through ``ssh <host> bash -s`` on a GPU box, so both paths share the same code.

Frontends, in order of preference:
  nvcc         the real CUDA compiler (``nvcc -ptx -lineinfo``)
  clang-nvptx  LLVM's NVPTX backend with a small shim header; a preview for
               machines without the CUDA toolkit. Its PTX differs from nvcc's.
  triton       runs the Python file and collects the PTX from the Triton cache
  ptx          a ``.ptx`` file needs no frontend
"""

from __future__ import annotations

import base64
import logging
import re
import shlex
import subprocess
import time
from dataclasses import asdict, dataclass

log = logging.getLogger("ripple.toolchain")

CUDA_EXTS = frozenset({".cu", ".cuh", ".cpp", ".cc", ".c"})
PTX_EXTS = frozenset({".ptx"})
TRITON_EXTS = frozenset({".py"})
MAX_SOURCE_BYTES = 2 * 1024 * 1024
COMPILE_TIMEOUT_S = 180
PROBE_TIMEOUT_S = 30
PROBE_TTL_S = 120
DEFAULT_ARCH = "sm_100"

ARCH_RE = re.compile(r"^sm_(\d{2,3})[a-z]?$")
NAME_RE = re.compile(r"^[\w.+-]+$")
SSH_HOST_RE = re.compile(r"^[\w.@-]+$")
FLAG_RES = tuple(
    re.compile(p)
    for p in (
        r"^-O[0-3s]$",
        r"^-D\w+(=[\w.+-]*)?$",
        r"^-U\w+$",
        r"^-I[\w./+-]+$",
        r"^-std=c\+\+\d\d$",
        r"^--use_fast_math$",
        r"^-ffast-math$",
        r"^-f(no-)?[a-z][a-z-]*$",
        r"^-W[\w=-]*$",
    )
)

CLANG_SHIM = r"""
#include <stdint.h>
#include <stddef.h>
#define __global__ __attribute__((global))
#define __device__ __attribute__((device))
#define __host__ __attribute__((host))
#define __shared__ __attribute__((shared))
#define __constant__ __attribute__((constant))
#define __forceinline__ __attribute__((always_inline)) inline
#define __noinline__ __attribute__((noinline))
#define __restrict__ __restrict
#include <__clang_cuda_builtin_vars.h>
__device__ inline float sqrtf(float x) { return __builtin_sqrtf(x); }
__device__ inline float fabsf(float x) { return __builtin_fabsf(x); }
__device__ inline float fminf(float a, float b) { return __builtin_fminf(a, b); }
__device__ inline float fmaxf(float a, float b) { return __builtin_fmaxf(a, b); }
__device__ inline float floorf(float x) { return __builtin_floorf(x); }
__device__ inline float ceilf(float x) { return __builtin_ceilf(x); }
__device__ inline float fmaf(float a, float b, float c) { return __builtin_fmaf(a, b, c); }
__device__ inline double sqrt(double x) { return __builtin_sqrt(x); }
__device__ inline double fabs(double x) { return __builtin_fabs(x); }
extern "C" {
__device__ float expf(float); __device__ float logf(float); __device__ float powf(float, float);
__device__ float sinf(float); __device__ float cosf(float); __device__ float tanhf(float);
__device__ double exp(double); __device__ double log(double); __device__ double pow(double, double);
}
template <class T> __device__ inline T min(T a, T b) { return b < a ? b : a; }
template <class T> __device__ inline T max(T a, T b) { return a < b ? b : a; }
"""


class ToolchainError(ValueError):
    """The request cannot be compiled as given."""


@dataclass(frozen=True)
class ToolchainInfo:
    runner: str
    nvcc: str | None = None
    nvcc_version: str | None = None
    ptxas: str | None = None
    clang: str | None = None
    triton: str | None = None
    gpu: str | None = None
    error: str | None = None
    probed_at: float = 0.0

    @property
    def cuda_frontend(self) -> str | None:
        if self.nvcc:
            return "nvcc"
        if self.clang:
            return "clang-nvptx"
        return None

    def to_json(self) -> dict:
        return {**asdict(self), "cuda_frontend": self.cuda_frontend, "default_arch": DEFAULT_ARCH}


@dataclass(frozen=True)
class CompileRequest:
    filename: str
    source: str
    arch: str = DEFAULT_ARCH
    flags: tuple[str, ...] = ()
    allow_run: bool = False


# ------------------------------------------------------------------ validation


def validate_flags(raw: str | list[str] | None) -> tuple[str, ...]:
    tokens = shlex.split(raw) if isinstance(raw, str) else list(raw or [])
    for token in tokens:
        if not any(rx.match(token) for rx in FLAG_RES):
            raise ToolchainError(f"flag not allowed: {token!r}")
    return tuple(tokens)


def validate_request(req: CompileRequest) -> str:
    """Return the file kind: 'cuda', 'ptx' or 'triton'."""
    if not NAME_RE.match(req.filename) or req.filename.startswith("."):
        raise ToolchainError(f"bad file name: {req.filename!r}")
    if not ARCH_RE.match(req.arch):
        raise ToolchainError(f"bad arch: {req.arch!r} (expected sm_NN)")
    if len(req.source.encode()) > MAX_SOURCE_BYTES:
        raise ToolchainError("source is larger than 2 MB")
    ext = "." + req.filename.rsplit(".", 1)[-1].lower() if "." in req.filename else ""
    if ext in CUDA_EXTS:
        return "cuda"
    if ext in PTX_EXTS:
        return "ptx"
    if ext in TRITON_EXTS:
        return "triton"
    raise ToolchainError(f"cannot compile {ext or 'this'} files; use .cu, .ptx or a Triton .py")


def ptx_feature_for(arch: str) -> str:
    """LLVM needs an explicit PTX version when no CUDA SDK is installed."""
    number = int(ARCH_RE.match(arch).group(1))  # type: ignore[union-attr]
    if number >= 120:
        return "ptx87"
    if number >= 100:
        return "ptx86"
    return "ptx78"


# ------------------------------------------------------------------ log parsing

_PTXAS_ENTRY = re.compile(r"(?:Compiling entry function|Function properties for) '?([\w$.]+)'?")
_PTXAS_FRAME = re.compile(r"(\d+) bytes stack frame, (\d+) bytes spill stores, (\d+) bytes spill loads")
_PTXAS_USED = re.compile(r"Used (\d+) registers(?:, used (\d+) barriers)?")
_DIAG_PAREN = re.compile(r"^(?P<file>[^\s(]+)\((?P<line>\d+)\):\s*(?P<sev>error|warning)\b[^:]*:\s*(?P<msg>.*)$")
_DIAG_COLON = re.compile(
    r"^(?P<file>[^\s:]+):(?P<line>\d+):(?:(?P<col>\d+):)?\s*(?P<sev>fatal error|error|warning):\s*(?P<msg>.*)$"
)
_DIAG_PTXAS = re.compile(r"^ptxas (?P<file>\S+), line (?P<line>\d+); (?P<sev>error|warning)\s*:\s*(?P<msg>.*)$")


def parse_ptxas_log(text: str) -> list[dict]:
    """Per-function physical register and spill numbers from ``ptxas -v``."""
    functions: dict[str, dict] = {}
    current: dict | None = None
    for line in text.splitlines():
        entry = _PTXAS_ENTRY.search(line)
        if entry:
            current = functions.setdefault(entry.group(1), {"function": entry.group(1)})
            continue
        if current is None:
            continue
        frame = _PTXAS_FRAME.search(line)
        if frame:
            current.update(
                stack_frame=int(frame.group(1)),
                spill_stores=int(frame.group(2)),
                spill_loads=int(frame.group(3)),
            )
        used = _PTXAS_USED.search(line)
        if used:
            current.update(registers=int(used.group(1)), barriers=int(used.group(2) or 0))
    return [f for f in functions.values() if "registers" in f]


def parse_diagnostics(text: str) -> list[dict]:
    found = []
    for line in text.splitlines():
        match = _DIAG_PAREN.match(line) or _DIAG_COLON.match(line) or _DIAG_PTXAS.match(line)
        if not match:
            continue
        info = match.groupdict()
        found.append({
            "file": info["file"].rsplit("/", 1)[-1],
            "line": int(info["line"]),
            "col": int(info.get("col") or 1),
            "severity": "warning" if info["sev"] == "warning" else "error",
            "message": info["msg"].strip(),
        })
    return found


# ------------------------------------------------------------------ scripts


def _heredoc(path: str, text: str) -> str:
    encoded = base64.encodebytes(text.encode()).decode()
    return f"base64 --decode > {shlex.quote(path)} <<'RIPPLE_EOF'\n{encoded}RIPPLE_EOF\n"


def probe_script(clang_hint: str | None, python_bin: str) -> str:
    hint = shlex.quote(clang_hint) if clang_hint else ""
    return f"""
find_tool() {{ command -v "$1" 2>/dev/null || {{ [ -x "/usr/local/cuda/bin/$1" ] && echo "/usr/local/cuda/bin/$1"; }}; }}
nvcc=$(find_tool nvcc); echo "nvcc $nvcc"
echo "ptxas $(find_tool ptxas)"
[ -n "$nvcc" ] && echo "nvcc_version $("$nvcc" --version 2>/dev/null | grep -o 'release [0-9.]*' | head -1)"
for c in {hint} clang /opt/homebrew/opt/llvm*/bin/clang /usr/lib/llvm-*/bin/clang; do
  p=$(command -v "$c" 2>/dev/null) || continue
  if "$p" --print-targets 2>/dev/null | grep -q nvptx64; then echo "clang $p"; break; fi
done
command -v nvidia-smi >/dev/null 2>&1 && echo "gpu $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
echo "triton $({shlex.quote(python_bin)} -c 'import triton; print(triton.__version__)' 2>/dev/null)"
true
"""


def compile_script(req: CompileRequest, kind: str, info: ToolchainInfo, python_bin: str) -> tuple[str, str]:
    """Return (script, backend)."""
    name = shlex.quote(req.filename)
    arch = shlex.quote(req.arch)
    flags = " ".join(shlex.quote(f) for f in req.flags)
    opt = "" if any(f.startswith("-O") for f in req.flags) else "-O3"
    head = (
        'set -u\nd=$(mktemp -d) || exit 97\ntrap \'rm -rf "$d"\' EXIT\ncd "$d" || exit 97\nmkdir ptx\n'
        "emit() { printf '%s ' \"$1\"; [ -f \"$2\" ] && base64 < \"$2\" | tr -d '\\n'; echo; }\n"
        + _heredoc(req.filename, req.source)
    )

    if kind == "ptx":
        backend = "ptx"
        front = f"cp {name} ptx/000.ptx\n"
    elif kind == "triton":
        if not req.allow_run:
            raise ToolchainError("a Triton file runs Python on the runner; start it with the Run button")
        if not info.triton:
            raise ToolchainError("Triton is not installed on the runner")
        backend = "triton"
        front = (
            f'TRITON_CACHE_DIR="$d/tc" TRITON_ALWAYS_COMPILE=1 {shlex.quote(python_bin)} {name} > front.log 2>&1\n'
            'echo "front_rc $?"\n'
            'i=0; for f in $(find "$d/tc" -name "*.ptx" 2>/dev/null | sort); do '
            'cp "$f" "ptx/$(printf %03d $i).ptx"; i=$((i+1)); done\n'
        )
    elif info.nvcc:
        backend = "nvcc"
        front = (
            f"{shlex.quote(info.nvcc)} -ptx -lineinfo {opt} -arch={arch} {flags} {name} -o ptx/000.ptx"
            ' > front.log 2>&1\necho "front_rc $?"\n'
        )
    elif info.clang:
        backend = "clang-nvptx"
        feature = ptx_feature_for(req.arch)
        front = _heredoc("ripple_shim.h", CLANG_SHIM) + (
            f"{shlex.quote(info.clang)} -x cuda --cuda-device-only -nocudainc -nocudalib -ffreestanding"
            f" --cuda-gpu-arch={arch} -Xclang -target-feature -Xclang +{feature} -include ripple_shim.h"
            f" -fno-color-diagnostics -gline-tables-only {opt} {flags} -S {name} -o ptx/000.ptx"
            ' > front.log 2>&1\necho "front_rc $?"\n'
        )
    else:
        raise ToolchainError("no CUDA frontend found (nvcc, or a clang with the NVPTX target)")

    tail = 'cat ptx/*.ptx > out.ptx 2>/dev/null\n'
    if info.ptxas:
        tail += (
            "rc=0; : > ptxas.log\n"
            f'for f in ptx/*.ptx; do [ -f "$f" ] || continue; {shlex.quote(info.ptxas)} -v --gpu-name {arch}'
            ' "$f" -o /dev/null >> ptxas.log 2>&1 || rc=$?; done\necho "ptxas_rc $rc"\n'
        )
    tail += "emit ptx out.ptx\nemit front_log front.log\nemit ptxas_log ptxas.log\n"
    return head + front + tail, backend


# ------------------------------------------------------------------ service


def _parse_kv(stdout: str) -> dict[str, str]:
    pairs = {}
    for line in stdout.splitlines():
        key, _, value = line.partition(" ")
        if key:
            pairs[key] = value.strip()
    return pairs


def _b64(pairs: dict[str, str], key: str) -> str:
    try:
        return base64.b64decode(pairs.get(key, "")).decode(errors="replace")
    except ValueError:
        return ""


class Toolchain:
    """Probes the runner once in a while and compiles on request."""

    def __init__(self, ssh_host: str | None = None, clang_hint: str | None = None, python_bin: str = "python3"):
        if ssh_host and not SSH_HOST_RE.match(ssh_host):
            raise ToolchainError(f"bad ssh host: {ssh_host!r}")
        self._ssh_host = ssh_host
        self._clang_hint = clang_hint
        self._python_bin = python_bin
        self._info: ToolchainInfo | None = None

    @property
    def runner(self) -> str:
        return f"ssh:{self._ssh_host}" if self._ssh_host else "local"

    def _run(self, script: str, timeout: float) -> subprocess.CompletedProcess[str]:
        argv = ["bash", "-s"]
        if self._ssh_host:
            argv = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", self._ssh_host, "bash -s"]
        return subprocess.run(argv, input=script, capture_output=True, text=True, timeout=timeout, check=False)

    def info(self, refresh: bool = False) -> ToolchainInfo:
        fresh = self._info is not None and time.time() - self._info.probed_at < PROBE_TTL_S
        if fresh and not refresh:
            return self._info  # type: ignore[return-value]
        try:
            done = self._run(probe_script(self._clang_hint, self._python_bin), PROBE_TIMEOUT_S)
            pairs = _parse_kv(done.stdout)
            error = None if done.returncode == 0 else (done.stderr.strip()[:400] or f"probe exit {done.returncode}")
        except (subprocess.TimeoutExpired, OSError) as exc:
            pairs, error = {}, f"probe failed: {exc}"
            log.warning("toolchain probe failed: %s", exc)
        self._info = ToolchainInfo(
            runner=self.runner,
            nvcc=pairs.get("nvcc") or None,
            nvcc_version=pairs.get("nvcc_version") or None,
            ptxas=pairs.get("ptxas") or None,
            clang=pairs.get("clang") or None,
            triton=pairs.get("triton") or None,
            gpu=pairs.get("gpu") or None,
            error=error,
            probed_at=time.time(),
        )
        return self._info

    def compile(self, req: CompileRequest) -> dict:
        kind = validate_request(req)
        info = self.info()
        script, backend = compile_script(req, kind, info, self._python_bin)
        started = time.time()
        try:
            done = self._run(script, COMPILE_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            raise ToolchainError(f"compile timed out after {COMPILE_TIMEOUT_S} s") from None
        except OSError as exc:
            raise ToolchainError(f"cannot start the runner: {exc}") from exc

        pairs = _parse_kv(done.stdout)
        ptx = _b64(pairs, "ptx")
        front_log = _b64(pairs, "front_log")
        ptxas_log = _b64(pairs, "ptxas_log")
        front_rc = int(pairs["front_rc"]) if "front_rc" in pairs else None
        ptxas_rc = int(pairs["ptxas_rc"]) if "ptxas_rc" in pairs else None
        if done.returncode != 0 and not front_log:
            front_log = done.stderr.strip() or f"runner exit {done.returncode}"

        notes = []
        if backend == "clang-nvptx":
            notes.append("PTX comes from LLVM's NVPTX backend with a shim header, not from nvcc. "
                         "Use it to read structure; nvcc output will differ.")
        if not info.ptxas:
            notes.append("ptxas was not found, so physical register and spill counts are not available.")
        if backend == "triton" and not ptx:
            notes.append("No PTX in the Triton cache. The script must call the kernel on a CUDA device.")

        return {
            "ok": bool(ptx) and front_rc in (0, None) and done.returncode == 0,
            "backend": backend,
            "runner": self.runner,
            "arch": req.arch,
            "seconds": round(time.time() - started, 2),
            "ptx": ptx,
            "frontend": {"rc": front_rc, "log": front_log},
            "ptxas": {
                "available": bool(info.ptxas),
                "rc": ptxas_rc,
                "log": ptxas_log,
                "functions": parse_ptxas_log(ptxas_log),
            },
            "diagnostics": parse_diagnostics(front_log) + parse_diagnostics(ptxas_log),
            "notes": notes,
        }
