"""Inline completion (ghost text).

Ripple is a chat model with no fill-in-the-middle mode, so the request is built
to make a chat turn act like one. Measured on Ripple-65B NVFP4 (vLLM, one B200,
12 lab cases):

    instruction only                      empty answers: the model reasons first
    + empty think block                   7/12, median 1106 ms (it explains, or runs on)
    + reply starts with the current line  9/12, median  100 ms   <- `plan_prefill`
    + answer held to a line pattern       see `_line_pattern`

The request carries the whole context; the assistant turn is started for the
model with a code fence and the current line, and generation stops at the end
of that line. The mock endpoint answers from a small idiom table instead.

The context window moves in steps (`stable_window`), so the prompt keeps the same
start from one keystroke to the next and the server can reuse its prefix cache.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

KERNEL_LANGUAGES = frozenset({"cuda", "triton", "ptx"})
LANGUAGE_RE = re.compile(r"^[\w+#.-]{1,32}$")
MAX_PREFIX_CHARS = 6000
MAX_SUFFIX_CHARS = 1500
MAX_BODY_CHARS = 400_000
MAX_FINDINGS = 8
MAX_LINES = 10
MAX_SYSTEM_EXTRA_CHARS = 2000
MAX_TOKENS = 192
TEMPERATURE = 0.0  # sampling made answers worse in the lab cases (7/12 at 0.2, 9/12 at 0)
EMPTY_THINK = "<think>\n\n</think>\n"  # Ripple's chat template: an empty think block means "answer now"
FENCE_LANGUAGE = {"cuda": "cpp", "triton": "python", "ptx": "asm", "shell": "bash"}
PARTIAL_WORD_RE = re.compile(r"[A-Za-z_]\w*$")
OPEN_LINE_RE = re.compile(r"[.(\[,=+\-*/%<>&|!\s]$")  # the line clearly wants more text
WINDOW_STEP_CHARS = 2000
SINGLE_LINE_MAX_TOKENS = 64

SYSTEM_PROMPT = (
    "You complete code inside an editor. Reply with only the text to insert at the cursor: "
    "no explanation, no code fences, no repeat of the text before or after the cursor. "
    "Finish the current statement or block in at most 8 lines. Match the style of the file. "
    "If nothing useful fits, reply with an empty message."
)
PREFILL_SYSTEM_PROMPT = (
    "You complete code inside an editor. Your reply is inserted at the cursor, so it holds only new code: "
    "no explanation, and no repeat of the text before or after the cursor. Match the style of the file."
)
KERNEL_RULES = (
    " This file is a GPU kernel. Float literals carry the f suffix unless the code is double precision on purpose; "
    "indices are unsigned or size_t; no integer division or remainder inside a loop when a shift or mask does it; "
    "no stack arrays that a register can replace."
)


@dataclass(frozen=True)
class CompletionRequest:
    path: str
    language: str
    prefix: str
    suffix: str
    findings: tuple[str, ...] = ()
    max_lines: int = MAX_LINES
    system_extra: str = ""
    reason: bool = False  # let the model reason before it answers (slow; off by default)

    @property
    def line_prefix(self) -> str:
        return self.prefix.rsplit("\n", 1)[-1]

    @property
    def line_suffix(self) -> str:
        return self.suffix.split("\n", 1)[0]


def _bounded(options: dict, name: str, default: int, low: int, high: int) -> int:
    if options.get(name) is None:
        return default
    try:
        value = int(options[name])
    except (TypeError, ValueError):
        raise ValueError(f"options.{name} must be a whole number") from None
    if not low <= value <= high:
        raise ValueError(f"options.{name} must be between {low} and {high}")
    return value


def parse_request(body: dict) -> CompletionRequest:
    """`options` carries the lab settings: how much context to send and how to trim the answer."""
    options = body.get("options") or {}
    if not isinstance(options, dict):
        raise ValueError("options must be an object")
    prefix_chars = _bounded(options, "prefix_chars", MAX_PREFIX_CHARS, 200, 40_000)
    suffix_chars = _bounded(options, "suffix_chars", MAX_SUFFIX_CHARS, 0, 16_000)
    language = body.get("language")
    prefix = body.get("prefix")
    suffix = body.get("suffix", "")
    if not isinstance(language, str) or not LANGUAGE_RE.match(language):
        raise ValueError("language must be a short language id")
    if not isinstance(prefix, str) or not isinstance(suffix, str):
        raise ValueError("prefix and suffix must be text")
    if len(prefix) + len(suffix) > MAX_BODY_CHARS:
        raise ValueError("prefix and suffix are too large")
    findings = body.get("findings") or []
    if not isinstance(findings, list):
        raise ValueError("findings must be a list")
    return CompletionRequest(
        path=str(body.get("path", ""))[:200],
        language=language,
        prefix=stable_window(prefix, prefix_chars),
        suffix=suffix[:suffix_chars],
        findings=tuple(str(item)[:200] for item in findings[:MAX_FINDINGS]),
        max_lines=_bounded(options, "max_lines", MAX_LINES, 1, 40),
        system_extra=str(options.get("system_extra") or "")[:MAX_SYSTEM_EXTRA_CHARS],
        reason=options.get("reason") is True,
    )


def build_messages(req: CompletionRequest) -> list[dict]:
    notes = "".join(f"- {finding}\n" for finding in req.findings)
    user = (
        f"File: {req.path or 'kernel'} ({req.language})\n"
        + (f"Findings from the last compile:\n{notes}" if notes else "")
        + f"<before_cursor>\n{req.prefix}</before_cursor>\n<after_cursor>\n{req.suffix}</after_cursor>\n"
        "Write the text that belongs at the cursor."
    )
    system = SYSTEM_PROMPT + (KERNEL_RULES if req.language in KERNEL_LANGUAGES else "")
    if req.system_extra.strip():
        system += " " + req.system_extra.strip()
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def stable_window(prefix: str, limit: int) -> str:
    """The last `limit` characters of the prefix, cut at a line start that moves in steps.

    A window that slides by one character per keystroke changes the start of the prompt
    every time, and the server's prefix cache never hits. This window keeps its start
    until about WINDOW_STEP_CHARS more characters are typed.
    """
    if len(prefix) <= limit:
        return prefix
    step = max(1, min(WINDOW_STEP_CHARS, limit // 3))  # the window keeps at least two thirds of the limit
    cut = len(prefix) - limit
    cut += -cut % step  # round up to the next step
    newline = prefix.find("\n", cut)
    return prefix[newline + 1:] if newline != -1 else prefix[cut:]


def _line_pattern(line: str, typed_word: str) -> str | None:
    """A pattern for the rest of the line, for servers with structured output.

    Seen on Ripple: after a half-typed word or a trailing dot, the first token is often
    a newline and the answer is empty. With a pattern the answer has to start with the
    word being typed (`import num` -> ` numpy as np`), or has to hold some text.
    A line that looks complete gets no pattern, so it can stay without a suggestion.
    """
    if typed_word:
        return " ?" + re.escape(typed_word) + "[^\\n]*\\n"
    if OPEN_LINE_RE.search(line):
        return "[^\\n]+\\n"
    return None


@dataclass(frozen=True)
class PrefillPlan:
    """A chat request whose assistant turn is already started, so the model continues code."""

    messages: list[dict]
    prefill: str
    stop: list[str]
    typed_word: str  # a word the user is in the middle of; the model writes it again in full
    strip_space: bool  # the line ended in a space that the prefill does not carry
    max_tokens: int = MAX_TOKENS
    pattern: str | None = None  # regular expression for the answer (structured output)


def plan_prefill(req: CompletionRequest) -> PrefillPlan:
    line = req.line_prefix
    mid_line = bool(line.strip())
    # A prefill that ends inside a word or in a trailing space falls between tokens and
    # the model stops at once ("import num" gave an empty answer). Back up to the last
    # whole word; `finish_prefilled` takes the repeated part off again.
    word = PARTIAL_WORD_RE.search(line) if mid_line else None
    typed_word = word.group(0) if word else ""
    start = line[: len(line) - len(typed_word)].rstrip(" \t") if mid_line else ""
    notes = "".join(f"- {finding}\n" for finding in req.findings)
    task = ("The cursor is on a new line between the two parts. Your reply starts with that line as far as it "
            "is typed. Continue it and stop at its end."
            if mid_line else "Write the lines that belong between the two parts. Stop when the statement or block is complete.")
    # The current line is left out of the request text. With it in, the model copied the
    # closing tag that came after it. Without it, the request also stays the same for a
    # whole line of typing, so the server's prefix cache covers all of it.
    before = req.prefix[: len(req.prefix) - len(line)]
    user = (
        f"File: {req.path or 'file'} ({req.language})\n"
        + (f"Findings from the last compile:\n{notes}" if notes else "")
        + f"<before_cursor>\n{before}</before_cursor>\n<after_cursor>\n{req.suffix}</after_cursor>\n{task}"
    )
    system = PREFILL_SYSTEM_PROMPT + (KERNEL_RULES if req.language in KERNEL_LANGUAGES else "")
    if req.system_extra.strip():
        system += " " + req.system_extra.strip()
    fence = FENCE_LANGUAGE.get(req.language, req.language)
    return PrefillPlan(
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        prefill=f"{EMPTY_THINK}```{fence}\n{start}",
        stop=["\n", "```", "</before_cursor>"] if mid_line else ["```", "\n\n\n", "</before_cursor>"],
        typed_word=typed_word,
        strip_space=mid_line and start != line[: len(line) - len(typed_word)],
        max_tokens=SINGLE_LINE_MAX_TOKENS if mid_line else MAX_TOKENS,
        pattern=_line_pattern(line, typed_word) if mid_line else None,
    )


def finish_prefilled(raw: str, req: CompletionRequest, plan: PrefillPlan) -> str:
    text = raw.lstrip(" \t") if plan.strip_space or plan.typed_word else raw
    if plan.typed_word:
        if not text.startswith(plan.typed_word):
            return ""  # the model went another way than the word being typed
        text = text[len(plan.typed_word):]
    tail = req.line_suffix.strip()
    if tail and text.rstrip().endswith(tail):  # it also wrote what already follows the cursor
        text = text.rstrip()[: -len(tail)]
    return clean_completion(text, req)


def clean_completion(text: str, req: CompletionRequest) -> str:
    """Turn a model answer into text that is safe to show as ghost text."""
    fenced = re.search(r"```[\w+-]*\n(.*?)(?:```|\Z)", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    text = text.replace("\r\n", "\n").rstrip()
    if not text.strip():
        return ""

    line_prefix = req.line_prefix
    if line_prefix.strip():
        if text.startswith(line_prefix):  # the model repeated the line it should continue
            text = text[len(line_prefix):]
        elif text.lstrip().startswith(line_prefix.strip()):
            text = text.lstrip()[len(line_prefix.strip()):]
        if line_prefix.endswith((" ", "\t")):
            text = text.lstrip(" \t")
    else:
        text = text.lstrip("\n")
        if line_prefix and text.startswith(line_prefix):  # indentation given twice
            text = text[len(line_prefix):]

    following = next((line.strip() for line in req.suffix.split("\n") if line.strip()), "")
    if len(following) >= 3:
        cut = text.find(following)
        if cut > 0:  # the model ran on into the text after the cursor
            text = text[:cut].rstrip()

    lines = text.split("\n")
    return "\n".join(lines[:req.max_lines]).rstrip() if text.strip() else ""


# ------------------------------------------------------------------ mock idioms

_INDEX = "blockIdx.x * blockDim.x + threadIdx.x;"
_KERNEL_BODY = (
    "kernel(const float* in, float* out, int n) {\n"
    "  int i = blockIdx.x * blockDim.x + threadIdx.x;\n"
    "  if (i < n) {\n"
    "    out[i] = in[i];\n"
    "  }\n"
    "}"
)

# (language, pattern on the text before the cursor on this line, text to insert)
_IDIOMS: tuple[tuple[str, re.Pattern[str], str], ...] = tuple(
    (language, re.compile(pattern), insert)
    for language, pattern, insert in (
        ("cuda", r"\b(?:int|unsigned|size_t|uint32_t)\s+(?:i|idx|tid|gid)\s*=\s*$", _INDEX),
        ("cuda", r"__global__\s+void\s+$", _KERNEL_BODY),
        ("cuda", r"(?<![\w.])\d+\.\d+$", "f"),
        ("cuda", r"__shared__\s+float\s+$", "partial[256];"),
        ("cuda", r"\b__sync$", "threads();"),
        ("cuda", r"\bthreadIdx\.$", "x"),
        ("cuda", r"\bif\s*\(\s*i\s*<\s*$", "n) {"),
        ("cuda", r"\bfor\s*\(\s*$", "int k = 0; k < n; ++k) {"),
        ("cuda", r"\batomic$", "Add(&out[i], value);"),
        ("triton", r"@triton\.$", "jit"),
        ("triton", r"\b(?:row|pid)\s*=\s*$", "tl.program_id(0)"),
        ("triton", r"\boffsets\s*=\s*$", "tl.arange(0, BLOCK)"),
        ("triton", r"\bmask\s*=\s*$", "offsets < n_cols"),
        ("triton", r"\btl\.load\($", "x_ptr + offsets, mask=mask, other=0.0)"),
        ("triton", r"\btl\.store\($", "y_ptr + offsets, y, mask=mask)"),
        ("python", r"^if\s+__name__\s*==\s*$", '"__main__":\n    main()'),
        ("python", r"^\s*for\s+\w+\s+in\s+range\($", "len(items)):"),
        ("python", r"^import\s+num$", "py as np"),
        ("javascript", r"\bconsole\.$", "log();"),
        ("javascript", r"^\s*for\s*\(\s*const\s+$", "item of items) {"),
        ("ptx", r"^\s*ld\.$", "global.f32 \t%f1, [%rd1];"),
        ("ptx", r"^\s*st\.$", "global.f32 \t[%rd1], %f1;"),
        ("ptx", r"^\s*cvta\.$", "to.global.u64 \t%rd1, %rd1;"),
        ("ptx", r"^\s*fma\.$", "rn.f32 \t%f3, %f1, %f2, %f3;"),
        ("ptx", r"^\s*setp\.$", "lt.s32 \t%p1, %r1, %r2;"),
        ("ptx", r"^\s*mov\.u32\s+%r\d+,\s*%$", "tid.x;"),
    )
)


def mock_complete(req: CompletionRequest) -> str:
    """Idioms keyed on the text before the cursor. Not a model."""
    if req.line_suffix.strip(" \t)];"):
        return ""  # only complete at the end of a line, or before closing punctuation
    for language, pattern, insert in _IDIOMS:
        same = language == req.language or (language == "python" and req.language == "triton")
        if same and pattern.search(req.line_prefix):
            return insert
    return ""
