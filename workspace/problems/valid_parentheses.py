"""Valid Parentheses

Given a string of the characters ( ) [ ] { }, return True when every bracket is closed
by the same kind of bracket in the right order.

Write the function body, then press Run to check it.
"""


def is_valid(text: str) -> bool:
    # Your solution goes here. Delete `pass` and write it.
    pass


if __name__ == "__main__":
    cases = [
        (("()",), True),
        (("()[]{}",), True),
        (("(]",), False),
        (("([)]",), False),
        (("{[]}",), True),
        (("(",), False),
    ]
    passed = 0
    for args, want in cases:
        got = is_valid(*args)
        ok = got == want
        passed += ok
        print("pass" if ok else "FAIL", args, "->", got, "" if ok else f"(want {want})")
    print(f"{passed} of {len(cases)} passed")
