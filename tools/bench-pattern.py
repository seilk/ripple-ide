#!/usr/bin/env python3
"""What the line pattern (structured output by regular expression) does for a suggestion.

    RIPPLE_RUNTIME_URL=http://127.0.0.1:8000/v1 RIPPLE_RUNTIME_MODEL=ripple python3 tools/bench-pattern.py [rounds]

Each case stops in the middle of a word or after an open character. The same request goes to
Ripple two times: with the pattern from `ide/complete.py`, and without it.
"""
from __future__ import annotations

import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ide import complete, ripple_api  # noqa: E402

ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 3
PY = "import math\nimport numpy as np\n\n\ndef mean(values: list[float]) -> float:\n    return sum(values) / len(values)\n\n\n"
CASES = [  # (language, text before the cursor)
    ("python", "import num"),
    ("python", PY + "def median(values: list[float]) -> float:\n    ordered = sor"),
    ("python", PY + "samples = [3.0, 4.5, 6.0]\nprint(me"),
    ("python", PY + "for i in ran"),
    ("python", PY + "total = np."),
    ("python", PY + "def variance(values: list[float]) -> float:\n    m = mean(values)\n    return sum((v - m) ** 2 for v in val"),
    ("python", PY + "if __name__ == \"__ma"),
    ("python", PY + "area = math.pi * radius *"),
    ("javascript", "const fs = require('fs');\nconst text = fs.readF"),
    ("javascript", "function twoSum(nums, target) {\n  const seen = new Map();\n  for (let i = 0; i < nums.len"),
    ("cuda", "__global__ void saxpy(int n, float a, const float* x, float* y) {\n    int i = blockIdx.x * blockDim.x + thr"),
    ("cuda", "__global__ void saxpy(int n, float a, const float* x, float* y) {\n    int i = blockIdx.x * blockDim.x + threadIdx.x;\n    if (i < n) y[i] = a * x[i] +"),
]


def ask(preset: dict, body: dict, use_pattern: bool) -> tuple[str, float]:
    request = complete.parse_request(body)
    plan = complete.plan_prefill(request)
    started = time.perf_counter()
    raw, truncated = ripple_api.complete_once(preset, plan.messages, plan.max_tokens, complete.TEMPERATURE, {},
                                              plan.prefill, plan.stop, plan.pattern if use_pattern else None)
    seconds = time.perf_counter() - started
    return complete.finish_prefilled(raw, request, plan, truncated), seconds * 1000


def main() -> None:
    preset = ripple_api.PRESETS["runtime"]
    rows = {True: [], False: []}
    for case, (language, prefix) in enumerate(CASES):
        answers = {}
        for use_pattern in (False, True):
            for turn in range(ROUNDS):
                # A new first line each time, so no answer comes from the server's cache of a past request.
                body = {"language": language, "path": "case", "suffix": "\n",
                        "prefix": f"// run {case} {turn} {use_pattern} {time.time()}\n".replace("//", "#" if language == "python" else "//") + prefix}
                text, ms = ask(preset, body, use_pattern)
                rows[use_pattern].append((bool(text.strip()), ms))
                answers[use_pattern] = text
        line = prefix.rsplit("\n", 1)[-1].strip()
        print(f"{line[-34:]:>34s} | without: {answers[False]!r:32.32s} | with: {answers[True]!r:.40s}")
    for use_pattern in (False, True):
        got = sum(1 for ok, _ in rows[use_pattern] if ok)
        times = [ms for _, ms in rows[use_pattern]]
        print(f"{'with pattern' if use_pattern else 'without pattern':16s}: a suggestion in {got} of {len(times)} requests, "
              f"median {statistics.median(times):.0f} ms")
    pattern = complete.plan_prefill(complete.parse_request({"language": "python", "prefix": "import num", "suffix": ""})).pattern
    print("pattern for `import num`:", pattern)


if __name__ == "__main__":
    main()
