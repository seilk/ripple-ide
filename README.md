# Ripple Kernel IDE

A browser IDE for GPU kernels with Ripple-65B as the engineer in the side panel.
You see a CUDA, Triton or PTX kernel next to its PTX. Ripple reads the kernel,
compiles it, reads the kernel report, proposes an edit as a diff, and compiles
again to check its own work.

```bash
python3 server.py            # http://127.0.0.1:8787, sample kernels, mock Ripple
```

No install step: Python 3.11+ standard library on the server, vendored Monaco in
the browser.

## What it does

| Area | Function |
|------|----------|
| Source and PTX | Two listings side by side. The cursor line in the source marks its PTX instructions, and back (from `.loc`, through inlined code). |
| PTX files | Open or write `.ptx` directly. Syntax colours, and the report follows as you type. |
| Kernel report | Per function: instructions, loops, memory traffic by state space, fp64 ops, thread-local bytes, shared bytes, and with `ptxas` the physical register and spill counts. |
| Findings | `fp64`, `local-mem`, `int-div`, `fp-div-hot`, `call`, `sext-index`. Each row jumps to its PTX line and source line. Findings in a loop come first. |
| Ripple | Tools: `list_files`, `read_file`, `compile_kernel`, `write_file`. A write shows a diff and needs your approval. |
| Runtime readout | Time to first token and tokens per second of the last answer, in the top bar. |

## Toolchain

The server looks for these on the runner and uses the best one it finds.

| Frontend | When | Notes |
|----------|------|-------|
| `nvcc -ptx -lineinfo` | CUDA toolkit present | The real thing. With `ptxas -v` the report shows registers and spills. |
| clang NVPTX preview | no `nvcc`, a clang with the `nvptx64` target | LLVM's backend plus a shim header. Good for structure. **Its PTX differs from nvcc's.** No register counts. |
| Triton | `.py` files, Run button only | Runs the file on the runner and reads the PTX from the Triton cache. Needs a CUDA device. |

```bash
python3 server.py --ssh gpubox                # compile on a GPU machine over ssh
python3 server.py --workspace ~/code/kernels  # your own kernel folder
```

## Ripple endpoint

The IDE does not run the model. See [docs/RUNTIME.md](docs/RUNTIME.md) for the
runtime slot and its contract.

| Endpoint | Setup |
|----------|-------|
| Team Ripple runtime | `RIPPLE_RUNTIME_URL`, `RIPPLE_RUNTIME_MODEL` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Ollama | `ollama pull ripple-preview:65b` |
| Mock | default; streams Ripple-shaped events with no network |

Keys stay in the server process. The browser never sees them.

## Sharing on a private network

The server edits files and runs compilers, so it listens on localhost by
default. To reach it from other machines on a network you trust:

```bash
python3 server.py --host <address> --allow-host <dns-name>
```

## Tests

```bash
python3 -m pytest tests -q          # server, toolchain, workspace, mock Ripple
node --test tests/*.test.mjs        # PTX analyzer
tests/e2e/run.sh                    # browser smoke test (needs Playwright + Chromium)
```

## Status

Checked on macOS with the clang NVPTX preview and the mock Ripple.
Not yet run: real `nvcc`/`ptxas`, the `--ssh` runner, the Triton path, and a
live Ripple endpoint. Stand-in tools cover the `nvcc`/`ptxas` plumbing in tests.

## Layout

```text
server.py            HTTP routes
ide/toolchain.py     nvcc / clang NVPTX / Triton -> PTX, ptxas log parsing
ide/workspace.py     workspace file access
ide/ripple_api.py    Ripple endpoints and the mock
web/src/ptx-analyze.js   PTX reader, findings, line links
web/src/                 editor, linker, report, Ripple panel
docs/                    runtime slot, design direction
```

Design direction: [docs/DESIGN.md](docs/DESIGN.md). Monaco Editor is vendored
under `web/vendor/monaco` (MIT).
