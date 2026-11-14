"""Linear-time streaming of long tool-call string values for vLLM's Ripple parser.

Without this, vLLM scans the whole tool call again for every streamed piece of it.
A 6,000-token `write_file` call then costs seconds of pure Python in the API server,
and the server answers nothing else in that time (suggestions and status checks hang).

`apply.py` inserts the function below into `vllm/parser/ripple.py`.
"""

from vllm.parser.utils import extract_json_member_object


# --- begin patch ---
def _ripple_arg_value_extender(raw_args: str):
    """While a string value of `arguments` is open, pass deltas through without a new scan.

    The arguments are streamed as the verbatim text of the `arguments` object, so inside
    an open string a delta is its own JSON text. The extender ends at the quote that
    closes the string; the engine then does a full conversion again.
    """
    try:
        args = extract_json_member_object(raw_args, "arguments")
    except ValueError:
        return None
    if not args:
        return None

    depth = 0
    in_string = False
    escape = False
    after_colon = False  # at depth 1: the last token was the colon after a key
    string_depth = 0
    string_is_value = False
    for ch in args:
        if escape:
            escape = False
        elif in_string:
            if ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
            string_depth = depth
            string_is_value = after_colon
            after_colon = False
        elif ch in "{[":
            depth += 1
            after_colon = False
        elif ch in "}]":
            depth -= 1
            after_colon = False
        elif ch == ":":
            after_colon = depth == 1
        elif ch not in " \t\n\r":
            after_colon = False
    if not in_string or string_depth < 1:
        return None
    if string_depth == 1 and not string_is_value:
        # An open key of `arguments`. The engine has streamed up to the value before
        # it, so text of the key must not be appended.
        return None

    def extend(delta: str):
        nonlocal escape
        if not escape and '"' not in delta and "\\" not in delta:
            return delta
        for ch in delta:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                return None  # the value closes in this delta
        return delta

    return extend
# --- end patch ---
