# Ripple runtime slot

The IDE does not run Ripple. It talks to a Ripple server through one preset,
`runtime`, so the team's tuned inference stack plugs in without IDE changes.
Kernel work on the inference side stays in its own repository.

## Connect the team server

```bash
RIPPLE_RUNTIME_URL=http://<host>:<port>/v1 \
RIPPLE_RUNTIME_MODEL=ricursiveAI/Ripple-65B-Preview \
python3 server.py
```

`RIPPLE_RUNTIME_KEY` is optional (sent as a Bearer token). When
`RIPPLE_RUNTIME_URL` is set, `runtime` is the default endpoint in the IDE.

## Contract

`POST {RIPPLE_RUNTIME_URL}/chat/completions`, OpenAI format, `stream: true`.

| Item | The IDE needs |
|------|---------------|
| Text | `choices[0].delta.content` |
| Reasoning | `delta.reasoning` or `delta.reasoning_content` (both accepted) |
| Tool calls | `delta.tool_calls[]` with `index`, `id`, `function.name`, `function.arguments` fragments |
| Usage | a last chunk with `usage` (`stream_options.include_usage`) |
| Tools sent | `list_files`, `read_file`, `search_files`, `write_file`, `run_file`, `compile_kernel`, `tool_choice: auto` |

With vLLM this is `--reasoning-parser ripple --enable-auto-tool-choice --tool-call-parser ripple`.

## Serving Ripple for the IDE

What ran for the measurements in the README:

```bash
# vLLM nightly (the released 0.33.0 has no Ricursive model class and no `ripple` parsers)
uv pip install -U vllm --pre \
  --extra-index-url https://wheels.vllm.ai/nightly/cu130 \
  --extra-index-url https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match

vllm serve ricursiveAI/Ripple-65B-Preview-NVFP4 --host 127.0.0.1 --port 8000 \
  --served-model-name ricursiveAI/Ripple-65B-Preview-NVFP4 ripple \
  --tensor-parallel-size 1 --max-model-len 262144 \
  --reasoning-parser ripple --enable-auto-tool-choice --tool-call-parser ripple \
  --speculative-config '{"method":"dflash","model":"ricursiveAI/Ripple-65B-Preview-DFlash2","num_speculative_tokens":7}'
```

The last flag turns on DFlash2 speculative decoding: about 230 to 310 tokens per
second against 77 without it. The first start with it builds a flashinfer module
for about five minutes; later starts reuse it.

### Parser patch for long tool calls

vLLM 0.34.0rc1.dev156 scans the whole tool call again for every streamed piece of
it (`vllm/parser/ripple.py` has no `arg_value_extender`). The cost grows with the
square of the length. When the agent writes a long file, the API server process
does only that for seconds, and it answers nothing else: status checks and
suggestions time out. The IDE showed this as "does not answer (timed out)".

`tools/vllm-patch` adds the missing function. Apply it once after the install,
then start `vllm serve`:

```bash
python tools/vllm-patch/apply.py            # --check to look, --revert to undo
python tools/vllm-patch/check.py <snapshot> # 400 streams, same output as the original parser
```

| On the server, while one `write_file` call streams | Original | Patched |
|---|---|---|
| Parse time, 5,231-token call (`check.py`) | 9.61 s | 0.094 s |
| Parse time, 10,431-token call | 37.89 s | 0.448 s |
| Longest wait of a status request (`tools/bench-server-stall.py`, 6,000 tokens) | 12.05 s | under 0.01 s |
| API server CPU during the answer | 66 % of one core | 2 % |

Through the IDE with the patch (`tools/bench-busy.py`): during one 105 s answer
with 99,000 characters of tool-call arguments, 335 status checks took 0.14 s at
most and 335 suggestions 1.01 s at most.

From the machine that runs the IDE:

```bash
tools/ripple-forward.sh <ssh-host> 8000 8000          # keeps the port forward open
RIPPLE_RUNTIME_URL=http://127.0.0.1:8000/v1 RIPPLE_RUNTIME_MODEL=ripple python3 server.py
```

The IDE uses three server features beyond plain chat: continuing a final
assistant message (`continue_final_message`), stop strings, and structured
output by regular expression (`structured_outputs.regex`). vLLM and SGLang have
them. Without them the IDE falls back to a plain instruction, which is slow.

## Trying a runtime change from inside the IDE

1. Start the changed runtime on its own port, next to the current one.
2. In the IDE: `⇧⌘P`, `Mode: Ripple lab`. Duplicate a profile, set Endpoint to
   `Custom URL`, and enter the new port. Name it after the change.
3. `Run benchmark` on the old profile, then on the new one. The new row shows
   its change in latency, tokens per second and cases passed against the old.
4. Pick the new profile in the top bar and keep working. Suggestions and chat
   now use the changed runtime, and the session line shows real-use latency.

A custom URL must be on localhost or a private address. Fields the runtime
understands beyond the OpenAI ones go in `Extra request body`. The IDE does not
restart or reconfigure the runtime process: settings that need a restart (for
example the KV cache type or speculative decoding) are a new port and a new
profile.

## Inline suggestions

The same endpoint serves ghost text: one short request per pause in typing,
`stream: false`, `temperature: 0`, 64 tokens for the rest of a line or 192 for
a block. Ripple has no fill-in-the-middle mode, so the request starts the
assistant turn for the model: an empty think block, a code fence and the current
line. The model continues that line and a stop string ends the answer at the
line end. Latency of this call is what the user feels while typing, so it gains
the most from a fast runtime: at 80 tokens per second a 10-token line is 125 ms
of generation. The status bar shows the time of each suggestion.

## What the IDE shows about the runtime

The top bar shows time to first token and output tokens per second for the
last answer, measured in the browser from the stream. `usage.completion_tokens`
gives the token count; without `usage`, the IDE counts stream chunks instead.
This is a quick readout for demos, not a benchmark.

## Dogfooding

Point the IDE at the inference kernels themselves:

```bash
python3 server.py --workspace /path/to/ripple-runtime/kernels --ssh <gpu-host>
```

`--ssh` compiles on the GPU machine with its `nvcc` and `ptxas`, so the report
shows real register and spill counts.
