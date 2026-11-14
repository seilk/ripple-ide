"""Valid Palindrome

Return True when the text reads the same forward and backward. Ignore case and every
character that is not a letter or a digit.

Write the function body, then press Run to check it.
"""


def is_palindrome(text: str) -> bool:
    # Your solution goes here. Delete `pass` and write it.
    pass


if __name__ == "__main__":
    cases = [
        (("A man, a plan, a canal: Panama",), True),
        (("race a car",), False),
        (("",), True),
    ]
    passed = 0
    for args, want in cases:
        got = is_palindrome(*args)
        ok = got == want
        passed += ok
        print("pass" if ok else "FAIL", args, "->", got, "" if ok else f"(want {want})")
    print(f"{passed} of {len(cases)} passed")
