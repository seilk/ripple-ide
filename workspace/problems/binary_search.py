"""Binary Search

Given a sorted list and a target, return the index of the target, or -1 when it is not
in the list. Use O(log n) steps.

Write the function body, then press Run to check it.
"""


def binary_search(nums: list[int], target: int) -> int:
    # Your solution goes here. Delete `pass` and write it.
    pass


if __name__ == "__main__":
    cases = [
        (([-1, 0, 3, 5, 9, 12], 9), 4),
        (([-1, 0, 3, 5, 9, 12], 2), -1),
        (([5], 5), 0),
        (([], 1), -1),
    ]
    passed = 0
    for args, want in cases:
        got = binary_search(*args)
        ok = got == want
        passed += ok
        print("pass" if ok else "FAIL", args, "->", got, "" if ok else f"(want {want})")
    print(f"{passed} of {len(cases)} passed")
