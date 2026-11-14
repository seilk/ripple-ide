#!/usr/bin/env python3
"""Latency of one short suggestion through an IDE server, many times.

    python3 tools/bench-latency.py http://127.0.0.1:8788 [count]
"""
from __future__ import annotations

import json
import statistics
import sys
import time
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
COUNT = int(sys.argv[2]) if len(sys.argv) > 2 else 60
BODY = {"preset": "runtime", "language": "python", "path": "stats.py",
        "prefix": "def mean(values):\n    return ", "suffix": "\n"}


def once(salt: int) -> float:
    body = {**BODY, "prefix": f"# run {salt}\n" + BODY["prefix"]}  # a new line on top, so no answer comes from a cache
    request = urllib.request.Request(BASE + "/api/complete", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=60) as response:
        answer = json.load(response)
    if not answer.get("completion"):
        raise SystemExit(f"empty answer: {answer}")
    return (time.perf_counter() - started) * 1000


def main() -> None:
    for salt in range(5):
        once(salt)  # warm up
    times = sorted(once(100 + n) for n in range(COUNT))
    pick = lambda q: times[min(len(times) - 1, int(q * len(times)))]
    print(f"{COUNT} suggestions via {BASE}: median {statistics.median(times):.1f} ms, "
          f"10th {pick(0.1):.1f} ms, 90th {pick(0.9):.1f} ms, mean {statistics.fmean(times):.1f} ms")


if __name__ == "__main__":
    main()
