# Ripple IDE

A browser IDE with Ripple-65B as the coding model: inline suggestions as you
type, and an agent in the side panel that reads, searches, edits, runs and
checks its own work. GPU kernel files (CUDA, Triton, PTX) get extra tools.

```bash
python3 server.py                       # http://127.0.0.1:8787, sample project, mock Ripple
python3 server.py --workspace ~/code/x  # your own project
```

No install step: Python 3.11+ standard library on the server, vendored Monaco in
the browser.

## Editor

| Area | Function |
|------|----------|
| Languages | Every language Monaco ships, plus CUDA (`.cu`) and PTX (`.ptx`). |
| Files | Folder tree, new file, delete. Go to file `⌘P`. Search in files `⇧⌘F`. |
| Inline suggestions | Ghost text after a short pause. `Tab` accepts, `Esc` dismisses, `⌘→` accepts a word. Toggle in the status bar. |
| Run | `⌘↵` runs `.py`, `.js`, `.mjs` and `.sh` files and streams the output. |
| Ripple panel | Tools: `list_files`, `read_file`, `search_files`, `write_file`, `run_file`, `compile_kernel`. A write shows a diff and a run asks first. |
| Ask about code | `⌘L` puts the selection in the prompt. |
| Layout | Drag any divider. Double-click it to reset. Arrow keys work on a focused divider. |

## Kernel files

Open a `.cu` or `.ptx` file, or a Python file that imports Triton, and the
kernel tools appear.

| Area | Function |
|------|----------|
| Source and PTX | Two listings side by side. The cursor line in the source marks its PTX instructions, and back. |
| Live compile | The PTX and the report follow as you type. A failed compile keeps the last good listing. |
| Kernel report | Per function: instructions, loops, memory traffic by state space, fp64 ops, thread-local bytes, and with `ptxas` the physical register and spill counts. |
| Baseline | Each number shows its change against the first good compile. `Set baseline here` moves the reference. |
| Findings | `fp64`, `local-mem`, `int-div`, `fp-div-hot`, `call`, `sext-index`, with PTX and source lines. |
| Quick fixes | On a finding: a direct edit when it is mechanical (add the `f` suffix), or `Ask Ripple to fix`. |
| Hover notes | PTX opcodes, state spaces and special registers; CUDA and Triton built-ins. |

Kernel toolchain, best one found on the runner:

| Frontend | When | Notes |
|----------|------|-------|
| `nvcc -ptx -lineinfo` | CUDA toolkit present | With `ptxas -v` the report shows registers and spills. |
| clang NVPTX preview | no `nvcc`, a clang with the `nvptx64` target | LLVM's backend plus a shim header. **Its PTX differs from nvcc's.** No register counts. |
| Triton | Run button only | Runs the file on the runner and reads the PTX from the Triton cache. Needs a CUDA device. |

`python3 server.py --ssh gpubox` compiles on a GPU machine over ssh.

## Ripple endpoint

The IDE does not run the model. See [docs/RUNTIME.md](docs/RUNTIME.md) for the
runtime slot and its contract.

| Endpoint | Setup |
|----------|-------|
| Team Ripple runtime | `RIPPLE_RUNTIME_URL`, `RIPPLE_RUNTIME_MODEL` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Ollama | `ollama pull ripple-preview:65b` |
| Mock | default; no network. Chat follows a fixed script and suggestions come from a small idiom table. |

Keys stay in the server process. The browser never sees them.

## Sharing on a private network

The server edits files and runs code, so it listens on localhost by default.

```bash
python3 server.py --host <address> --allow-host <dns-name>               # edit and compile
python3 server.py --host <address> --allow-host <dns-name> --allow-run   # also run files
```

Without `--allow-run`, a shared server refuses the Run button and `run_file`.

## Tests

```bash
python3 -m pytest tests -q          # server, toolchain, workspace, runner, completion
node --test tests/*.test.mjs        # PTX analyzer
tests/e2e/run.sh                    # browser test (needs Playwright + Chromium)
```

## Status

Checked on macOS with the clang NVPTX preview and the mock Ripple.
Not yet run: a live Ripple endpoint (chat and inline suggestions), real
`nvcc`/`ptxas`, the `--ssh` runner, and the Triton path. Stand-in servers and
tools cover that plumbing in tests.

## Layout

```text
server.py            HTTP routes
ide/workspace.py     project files: list, read, write, delete, search
ide/runner.py        run a file and stream its output
ide/complete.py      inline completion: prompt, answer cleaning, idiom table
ide/ripple_api.py    Ripple endpoints and the mock
ide/toolchain.py     nvcc / clang NVPTX / Triton -> PTX, ptxas log parsing
web/src/             editor, file tree, palette, suggestions, Ripple panel,
                     and the kernel tools (ptx-analyze, link, report, fixes)
docs/                runtime slot, design direction
```

Design direction: [docs/DESIGN.md](docs/DESIGN.md). Monaco Editor is vendored
under `web/vendor/monaco` (MIT).
