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

## Inline suggestions

The same endpoint serves ghost text: one short request per pause in typing,
`stream: false`, `max_tokens: 192`, `temperature: 0.2`. The prompt is a
fill-in-the-middle request for a chat model (text before and after the cursor),
and the server cleans the answer (code fences, repeated text). Latency of this
call is what the user feels while typing, so it gains the most from a fast
runtime. The status bar shows the time of each suggestion.

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
