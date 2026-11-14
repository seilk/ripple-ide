# Ripple IDE

A browser IDE with Ripple-65B as the coding model: inline suggestions as you
type, and an agent in the side panel that reads, searches, edits, runs and
checks its own work. Ripple runs on your own machine, so the IDE also lets you
change how it is used and measure the result.

## Modes

One IDE, three modes. `⇧⌘P` opens the command list; type `Mode`. The open
files stay when the mode changes.

| Mode | What the IDE is made of |
|------|-------------------------|
| General | Files, editor, run output, Ripple panel. A `.cu` file is an ordinary source file here. |
| Kernel | Adds the PTX pane, toolchain, arch and flags, live compile, the kernel report and kernel quick fixes. |
| Ripple lab | Adds the profile editor next to the code and the benchmark below it. |

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
| Inline edit | `⌘K` on a selection: describe the change, and Ripple rewrites those lines in place while the text streams in. One undo brings the old text back. |
| Run | `⌘↵` runs `.py`, `.js`, `.mjs` and `.sh` files and streams the output. |
| Ripple panel | Tools: `list_files`, `read_file`, `search_files`, `edit_file`, `write_file`, `run_file`, `compile_kernel`. An edit shows a diff and a run asks first. |
| Ask about code | `⌘L` puts the selection in the prompt. |
| Layout | Drag any divider. Double-click it to reset. Arrow keys work on a focused divider. |

## Ripple lab

A profile is one way to use Ripple. The list in the top bar picks the profile
the whole IDE uses, and a change applies to the next request with no restart.

| Setting | Effect |
|---------|--------|
| Endpoint | A server preset, or a custom URL on localhost or a private address. Point a second profile at a second build of the runtime to compare them. |
| Inline suggestions | Pause before asking, context before and after the cursor, max tokens, max lines, temperature, extra instruction. |
| Chat | Temperature, top p, max tokens, extra instruction. |
| Extra request body | JSON merged into every request, for runtime-specific fields. |

`Run benchmark` sends 12 suggestion cases and 2 chat prompts, one request at a
time, and adds a row: cases passed, median and 95th percentile latency, time to
first token, tokens per second. Each row shows its change against the baseline
row. A case passes when the suggestion matches a pattern, so the score tells
you when a change breaks answers; it is not a judgement of code quality.

The pane also counts this session: suggestions shown and accepted, and the
median latency of real use.

## Kernel mode

Open a `.cu` or `.ptx` file, or a Python file that imports Triton.

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
Without `--allow-custom-endpoints`, it also refuses custom URLs in the lab.

## Speed with a real Ripple

Measured with Ripple-65B Preview (NVFP4) on vLLM, one B200, the IDE on another
machine behind an SSH forward (13 ms round trip). See `ide/complete.py` for how
a chat model is made to act as a completion model.

| What | Plain | With DFlash2 speculative decoding |
|------|-------|-----------------------------------|
| Generation speed | 77 tok/s | 230 to 310 tok/s |
| Suggestion, lab cases, median | 116 ms (14 of 14 pass) | 76 ms (13 of 14 pass) |
| Suggestion, lab cases, 95th percentile | 644 ms | 153 ms |
| Suggestion while typing in a 35k-character file | median 173 ms | not measured |
| Inline edit of a 2-line function into 5 lines | 0.71 s, first text after 95 ms | not measured |
| Agent: read a kernel, compile, fix a double literal, compile again | 8.2 s | not measured |

A block suggestion (cursor at the start of a line) runs to the end of its block,
up to 30 lines. With speculative decoding, one suggestion solved each of the
eight problems in `workspace/problems` in 114 to 324 ms (all checks pass), and
wrote a correct 26-line "median of two sorted arrays" in 0.63 s.

Before the request was shaped for a chat model, the same suggestion cases gave
empty answers (the model reasoned first and used up its tokens), then 7 of 12
at a median of 1106 ms with reasoning switched off only. The prefix cache halves
latency in a large file (124 ms against 228 ms for the same 2000-token context).
Suggestions slow down a lot while a chat answer is being generated on the same
GPU: one run measured 0.4 to 3.6 s per suggestion during chat traffic.

Three later changes, each measured before and after on the same server:

| Change | Before | After |
|--------|--------|-------|
| Keep the connection to Ripple open (`ide/upstream.py`) | 54 to 59 ms per suggestion | 47 ms |
| Keep the agent’s first message the same; the active file moves to the end | first token after 400 ms, 4 % of the prompt from cache | 61 ms, 98 % |
| Same, in a real agent run that makes a file | 76 % from cache | 85 % |
| Run read-only tool calls together | 590 ms for 8 calls | 314 ms |

`tools/bench-latency.py`, `tools/bench-agent-cache.py`, `tools/bench-agent-make.mjs` and
`tools/bench-agent-reads.mjs` produce these numbers.

What the IDE does for speed: starts the model's reply for it so it answers
without reasoning; stops at the end of the line; holds the answer to a line
pattern so a half-typed word is finished; sends a context window whose start
moves in steps so the server's prefix cache keeps hitting; shows the rest of a
suggestion again with no request while you type through it; waits 75 ms, and
not at all right after an accept; and edits with `edit_file`, which sends the
changed text only.

`tests/e2e/real.mjs` runs these flows in a browser against a live server, and
`tools/bench-cli.mjs` runs the suggestion cases from a terminal.

## Tests

```bash
python3 -m pytest tests -q          # server, toolchain, workspace, runner, completion
node --test tests/*.test.mjs        # PTX analyzer, benchmark maths
tests/e2e/run.sh                    # browser test (needs Playwright + Chromium)
node tests/e2e/real.mjs             # the same kind of run against a live Ripple (set RIPPLE_RUNTIME_URL)
```

## Status

Checked with a live Ripple-65B (NVFP4, vLLM nightly, one B200): chat with
tools, inline suggestions, inline edit and the lab benchmark. Kernel tools were
checked on macOS with the clang NVPTX preview.
Not yet run: real `nvcc`/`ptxas`, the `--ssh` runner, and the Triton path.
Stand-in tools cover that plumbing in tests.

## Layout

```text
server.py            HTTP routes
ide/workspace.py     project files: list, read, write, delete, search
ide/runner.py        run a file and stream its output
ide/complete.py      inline completion: prefilled request, line pattern, cache-friendly window
ide/edit.py          inline edit: streamed rewrite of a selection
ide/ripple_api.py    Ripple endpoints and the mock
ide/toolchain.py     nvcc / clang NVPTX / Triton -> PTX, ptxas log parsing
web/src/             editor, file tree, palette, suggestions, Ripple panel,
                     lab (lab, bench, bench-cases),
                     kernel tools (ptx-analyze, link, report, fixes)
docs/                runtime slot, design direction
```

Design direction: [docs/DESIGN.md](docs/DESIGN.md). Monaco Editor is vendored
under `web/vendor/monaco` (MIT).
