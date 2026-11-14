"""Maximum Subarray

Return the largest sum of a contiguous, non-empty part of the list.

Write the function body, then press Run to check it.
"""


def max_subarray(nums: list[int]) -> int:
    # Your solution goes here. Delete `pass` and write it.
    pass


if __name__ == "__main__":
    cases = [
        (([-2, 1, -3, 4, -1, 2, 1, -5, 4],), 6),
        (([1],), 1),
        (([5, 4, -1, 7, 8],), 23),
        (([-3, -1, -2],), -1),
    ]
    passed = 0
    for args, want in cases:
        got = max_subarray(*args)
        ok = got == want
        passed += ok
        print("pass" if ok else "FAIL", args, "->", got, "" if ok else f"(want {want})")
    print(f"{passed} of {len(cases)} passed")
