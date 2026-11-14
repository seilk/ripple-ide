"""Does the Ripple server stop answering while it streams one long answer?

Run it on the machine that serves Ripple (it reads the CPU time of `vllm serve`):

    python bench-server-stall.py <stream 0|1> <tools 0|1> <max_tokens>

It asks for one long file, and times GET /v1/models four times a second until the answer
ends. With tools on, the answer is one long `write_file` call. Before the parser patch in
tools/vllm-patch the status request waited 10 to 12 s near the end of a 6,000-token call.
"""
import http.client, json, sys, threading, time, subprocess, os
stream, tools, max_tokens = sys.argv[1] == "1", sys.argv[2] == "1", int(sys.argv[3])
TOOLS = [{"type": "function", "function": {"name": "write_file", "description": "Write a file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}}]
done = threading.Event(); info = {}
def load():
    body = {"model": "ripple", "max_tokens": max_tokens, "stream": stream,
            "messages": [{"role": "user", "content": "Make a complete single-file HTML page that reviews a code editor: long, with CSS and JavaScript, at least 600 lines." + (" Use write_file." if tools else "")}]}
    if tools: body["tools"] = TOOLS; body["tool_choice"] = "auto"
    if stream: body["stream_options"] = {"include_usage": True}
    c = http.client.HTTPConnection("127.0.0.1", 8000, timeout=900); t = time.time()
    c.request("POST", "/v1/chat/completions", json.dumps(body), {"Content-Type": "application/json"})
    r = c.getresponse(); n = 0; first = None; usage = None
    if stream:
        for line in r:
            if line.startswith(b"data: {"):
                n += 1; first = first or time.time() - t
                u = json.loads(line[6:]).get("usage")
                if u: usage = u
    else:
        usage = json.loads(r.read()).get("usage")
    info.update(seconds=round(time.time() - t, 1), chunks=n, first=first and round(first, 2), usage=usage); done.set()
threading.Thread(target=load, daemon=True).start()
pid = subprocess.run("pgrep -f 'vllm serve' | head -1", shell=True, capture_output=True, text=True).stdout.strip()
def cpu():
    a = open(f"/proc/{pid}/stat").read().split(); return int(a[13]) + int(a[14])
tick = os.sysconf("SC_CLK_TCK"); rows = []; c0, t0 = cpu(), time.time(); start = t0
while not done.is_set():
    t = time.time()
    try:
        c = http.client.HTTPConnection("127.0.0.1", 8000, timeout=60); c.request("GET", "/v1/models"); c.getresponse().read(); c.close(); err = ""
    except Exception as e: err = repr(e)
    d = time.time() - t; rows.append((t - start, d))
    time.sleep(0.25)
c1, t1 = cpu(), time.time()
v = sorted(d for _, d in rows)
print(f"stream={stream} tools={tools}: answer {info}")
print(f"  status request: n={len(v)} median {v[len(v)//2]*1000:.0f} ms, max {v[-1]:.2f} s, over 1 s: {sum(x>1 for x in v)}, over 4 s: {sum(x>4 for x in v)}")
print(f"  API server CPU: {(c1-c0)/tick/(t1-t0)*100:.0f} % of one core")
print("  latency over time (s into the answer: s):", " ".join(f"{a:.0f}:{d:.1f}" for a, d in rows if d > 0.5)[:600])
