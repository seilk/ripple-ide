"""Check the patch off line: same streamed output as the original parser, and how much faster.

    python check.py <path to the model snapshot with the tokenizer>
"""

import dataclasses
import json
import random
import sys
import time

from transformers import AutoTokenizer
from vllm.entrypoints.openai.chat_completion.protocol import ChatCompletionRequest
from vllm.parser.ripple import RippleParser, ripple_config

from ripple_extender import _ripple_arg_value_extender

TOOLS = [
    {"type": "function", "function": {"name": "write_file", "description": "Write a file", "parameters": {
        "type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
    {"type": "function", "function": {"name": "edit_file", "description": "Edit a file", "parameters": {
        "type": "object", "properties": {"path": {"type": "string"}, "old": {"type": "string"}, "new": {"type": "string"},
                                         "count": {"type": "integer"}, "all": {"type": "boolean"}}}}},
    {"type": "function", "function": {"name": "batch", "description": "Many edits", "parameters": {
        "type": "object", "properties": {"edits": {"type": "array", "items": {"type": "object"}}, "note": {"type": "string"}}}}},
    {"type": "function", "function": {"name": "free", "description": "No schema"}},
]
REQUEST = ChatCompletionRequest(model="ripple", messages=[{"role": "user", "content": "x"}], tools=TOOLS, tool_choice="auto", stream=True)

HTML = '<!doctype html>\n<html lang="en">\n<head>\n<style>\n  body { font: 16px/1.5 "IBM Plex Sans"; }\n  a::after { content: "\\201C"; }\n</style>\n</head>\n<body class="page">\n<script>\nconst s = "a \\"quoted\\" word"; const re = /[{}:,\\\\]/g; // é ü 한글 😀\nconsole.log(`${s}: {"k": [1, 2]}`);\n</script>\n</body>\n</html>\n'


def call(name, arguments, name_first=True):
    body = {"name": name, "arguments": arguments} if name_first else {"arguments": arguments, "name": name}
    return "\n<tool_call>\n" + json.dumps(body, ensure_ascii=False) + "\n</tool_call>"


def cases():
    yield "write, long html", "<think>\nI will write the file.\n</think>\nHere it is." + call("write_file", {"path": "a/b.html", "content": HTML * 3})
    yield "edit, three strings and other types", call("edit_file", {"path": "x.py", "old": 'print("a")\n', "new": "print('b')\\n\\", "count": 2, "all": True})
    yield "arguments before name", call("write_file", {"path": "p", "content": 'x "y" z'}, name_first=False)
    yield "nested", call("batch", {"edits": [{"old": 'a"b', "new": "c\\d"}, {"old": "", "new": "{}[]:,"}], "note": "done: \"ok\""})
    yield "no schema", call("free", {"a": "text with \"quotes\" and \\ slash", "b": {"c": ["x", "y\"z"]}, "d": None})
    yield "empty strings", call("edit_file", {"path": "", "old": "", "new": ""})
    yield "string ends with backslashes", call("write_file", {"path": "a\\\\", "content": "line\\\\"})
    yield "two calls", "text" + call("write_file", {"path": "1", "content": HTML}) + call("edit_file", {"path": "2", "old": HTML, "new": "n"})
    full = call("write_file", {"path": "cut.html", "content": HTML * 2})
    yield "cut inside the string", full[: len(full) // 2]
    cut = full.index('\\"quoted') + 1
    yield "cut after a backslash", full[:cut]
    yield "cut inside a key", '\n<tool_call>\n{"name": "write_file", "arguments": {"path": "a", "cont'
    yield "cut after a colon", '\n<tool_call>\n{"name": "write_file", "arguments": {"path": "a", "content": '
    yield "repeated key", '\n<tool_call>\n{"name": "write_file", "arguments": {"path": "a", "content": "one", "content": "two two two"}}\n</tool_call>'
    yield "arguments is not an object", '\n<tool_call>\n{"name": "write_file", "arguments": "a string value"}\n</tool_call>'
    yield "no tool call", "<think>\nhmm \"quoted\"\n</think>\nJust text with {\"json\": \"inside\"}."
    yield "spaces in json", '\n<tool_call>\n{ "name" : "write_file" , "arguments" : { "path" : "a b" , "content" :   "x\\ty" } }\n</tool_call>'


def stream(text, pieces, patched, tokenizer):
    config = ripple_config()
    if patched:
        config = dataclasses.replace(config, arg_value_extender=_ripple_arg_value_extender)
    parser = RippleParser(tokenizer, REQUEST.tools, parser_engine_config=config)
    out = []
    for i, (piece, ids) in enumerate(pieces):
        delta = parser.parse_delta(piece, ids, REQUEST, finished=i == len(pieces) - 1)
        if delta is None:
            continue
        calls = [(c.index, c.function.name if c.function else None, c.function.arguments if c.function else None) for c in (delta.tool_calls or [])]
        out.append((delta.content, delta.reasoning, calls))
    return out


def joined(out):
    """What a client ends with: content, reasoning, and name + arguments of each call."""
    content = "".join(o[0] or "" for o in out)
    reasoning = "".join(o[1] or "" for o in out)
    calls = {}
    for _, _, cs in out:
        for index, name, arguments in cs:
            slot = calls.setdefault(index, ["", ""])
            slot[0] += name or ""
            slot[1] += arguments or ""
    return content, reasoning, calls


def by_token(text, tokenizer):
    enc = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True)
    starts = [s for s, _ in enc["offset_mapping"]] + [len(text)]
    pieces = [(text[starts[i]:starts[i + 1]], [enc["input_ids"][i]]) for i in range(len(enc["input_ids"]))]
    assert "".join(p for p, _ in pieces) == text
    return pieces


def by_chars(text, rng, largest):
    pieces, at = [], 0
    while at < len(text):
        size = rng.randint(1, largest)
        pieces.append((text[at:at + size], []))
        at += size
    return pieces


def main():
    tokenizer = AutoTokenizer.from_pretrained(sys.argv[1])
    rng = random.Random(7)
    checked = failed = 0
    for label, text in cases():
        splits = [("tokens", by_token(text, tokenizer))]
        splits += [(f"chars up to {n}", by_chars(text, rng, n)) for n in (1, 2, 3, 5, 9, 40) for _ in range(4)]
        for how, pieces in splits:
            before, after = stream(text, pieces, False, tokenizer), stream(text, pieces, True, tokenizer)
            checked += 1
            if before != after:
                failed += 1
                first = next((i for i, (a, b) in enumerate(zip(before, after)) if a != b), min(len(before), len(after)))
                print(f"DIFFERENT  {label} / {how}: delta {first}: {before[first:first + 1]} vs {after[first:first + 1]}")
        _, _, calls = joined(stream(text, by_token(text, tokenizer), True, tokenizer))
        print(f"same  {label:38s} calls: " + "; ".join(f"{name} {len(arguments)} chars" for name, arguments in calls.values()))
    print(f"\n{checked} streams compared, {failed} different")

    print("\ntime to parse one streamed write_file call, by tokens:")
    for copies in (10, 20, 40, 80):
        text = call("write_file", {"path": "big.html", "content": HTML * copies})
        pieces = by_token(text, tokenizer)
        row = []
        for patched in (False, True):
            start = time.perf_counter()
            out = stream(text, pieces, patched, tokenizer)
            row.append(time.perf_counter() - start)
        arguments = joined(out)[2][0][1]
        assert json.loads(arguments)["content"] == HTML * copies
        print(f"  {len(pieces):6d} tokens: original {row[0]:7.2f} s, patched {row[1]:6.3f} s  ({row[0] / row[1]:.0f}x)")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
