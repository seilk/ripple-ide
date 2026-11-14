"""Climbing Stairs

You climb a staircase of n steps, 1 or 2 steps at a time. Return the number of distinct
ways to reach the top.

Write the function body, then press Run to check it.
"""


def climb_stairs(n: int) -> int:
    # Your solution goes here. Delete `pass` and write it.
    pass


if __name__ == "__main__":
    cases = [
        ((1,), 1),
        ((2,), 2),
        ((3,), 3),
        ((5,), 8),
        ((10,), 89),
    ]
    passed = 0
    for args, want in cases:
        got = climb_stairs(*args)
        ok = got == want
        passed += ok
        print("pass" if ok else "FAIL", args, "->", got, "" if ok else f"(want {want})")
    print(f"{passed} of {len(cases)} passed")
