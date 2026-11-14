"""Inline completion (ghost text) for kernel files.

With a Ripple endpoint the model fills in the text at the cursor. Ripple is a
chat model, so the request is a fill-in-the-middle prompt and the answer is
cleaned before it reaches the editor. The mock endpoint answers from a small
table of kernel idioms, so the editor behaviour can be shown without a model.
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
MAX_TOKENS = 192
TEMPERATURE = 0.2

SYSTEM_PROMPT = (
    "You complete code inside an editor. Reply with only the text to insert at the cursor: "
    "no explanation, no code fences, no repeat of the text before or after the cursor. "
    "Finish the current statement or block in at most 8 lines. Match the style of the file. "
    "If nothing useful fits, reply with an empty message."
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

    @property
    def line_prefix(self) -> str:
        return self.prefix.rsplit("\n", 1)[-1]

    @property
    def line_suffix(self) -> str:
        return self.suffix.split("\n", 1)[0]


def parse_request(body: dict) -> CompletionRequest:
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
        prefix=prefix[-MAX_PREFIX_CHARS:],
        suffix=suffix[:MAX_SUFFIX_CHARS],
        findings=tuple(str(item)[:200] for item in findings[:MAX_FINDINGS]),
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
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


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
    return "\n".join(lines[:MAX_LINES]).rstrip() if text.strip() else ""


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
