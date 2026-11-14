"""Inline edit: rewrite the selected part of a file as instructed, as a stream.

The reply is started for the model with an empty think block and a code fence,
the same way as inline completion, so the first token of new code arrives at
once and nothing but code comes back.
"""

from __future__ import annotations

from dataclasses import dataclass

from ide.complete import EMPTY_THINK, FENCE_LANGUAGE, KERNEL_LANGUAGES, KERNEL_RULES, LANGUAGE_RE

MAX_SELECTION_CHARS = 24_000
MAX_INSTRUCTION_CHARS = 2_000
CONTEXT_CHARS = 3_000
MAX_TOKENS_FLOOR = 2048  # a two-line stub can become a long function
MAX_TOKENS_CEILING = 8_192

SYSTEM_PROMPT = (
    "You edit code inside an editor. The user selected part of a file and says how to change it. "
    "Reply with the new text for the selected part only. Keep its indentation. No explanation."
)


@dataclass(frozen=True)
class EditRequest:
    path: str
    language: str
    before: str
    selection: str
    after: str
    instruction: str

    @property
    def max_tokens(self) -> int:
        # about 3.5 characters a token; leave room for the code to grow
        return max(MAX_TOKENS_FLOOR, min(MAX_TOKENS_CEILING, len(self.selection) // 2 + MAX_TOKENS_FLOOR))


def parse_request(body: dict) -> EditRequest:
    language = body.get("language")
    selection = body.get("selection")
    instruction = body.get("instruction")
    if not isinstance(language, str) or not LANGUAGE_RE.match(language):
        raise ValueError("language must be a short language id")
    if not isinstance(selection, str) or not selection.strip():
        raise ValueError("selection is empty")
    if len(selection) > MAX_SELECTION_CHARS:
        raise ValueError(f"selection is larger than {MAX_SELECTION_CHARS} characters")
    if not isinstance(instruction, str) or not instruction.strip():
        raise ValueError("instruction is empty")
    return EditRequest(
        path=str(body.get("path", ""))[:200],
        language=language,
        before=str(body.get("before") or "")[-CONTEXT_CHARS:],
        selection=selection,
        after=str(body.get("after") or "")[:CONTEXT_CHARS],
        instruction=instruction.strip()[:MAX_INSTRUCTION_CHARS],
    )


def build_messages(req: EditRequest) -> list[dict]:
    system = SYSTEM_PROMPT + (KERNEL_RULES if req.language in KERNEL_LANGUAGES else "")
    user = (
        f"File: {req.path or 'file'} ({req.language})\n"
        f"<before>\n{req.before}</before>\n<selected>\n{req.selection}\n</selected>\n<after>\n{req.after}</after>\n"
        f"Change the selected part like this: {req.instruction}"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def prefill(req: EditRequest) -> str:
    return f"{EMPTY_THINK}```{FENCE_LANGUAGE.get(req.language, req.language)}\n"


STOP = ["```", "</selected>"]


def mock_edit(req: EditRequest) -> str:
    """No model: the selection comes back with the instruction as a comment on top."""
    first = req.selection.split("\n", 1)[0]
    indent = first[: len(first) - len(first.lstrip())]
    mark = "# " if req.language in ("python", "triton", "shell", "yaml") else "// "
    return f"{indent}{mark}mock edit: {req.instruction}\n{req.selection}"
