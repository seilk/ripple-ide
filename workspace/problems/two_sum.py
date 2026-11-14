"""Two Sum

Given a list of numbers and a target, return the indices of the two numbers that add up
to the target. Each input has exactly one answer. Return the smaller index first.

Write the function body, then press Run to check it.
"""


def two_sum(nums: list[int], target: int) -> list[int]:
    # Your solution goes here. Delete `pass` and write it.
    pass


if __name__ == "__main__":
    cases = [
        (([2, 7, 11, 15], 9), [0, 1]),
        (([3, 2, 4], 6), [1, 2]),
        (([3, 3], 6), [0, 1]),
    ]
    passed = 0
    for args, want in cases:
        got = two_sum(*args)
        ok = got == want
        passed += ok
        print("pass" if ok else "FAIL", args, "->", got, "" if ok else f"(want {want})")
    print(f"{passed} of {len(cases)} passed")
