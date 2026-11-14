"""Merge Two Sorted Lists

Given two sorted lists, return one sorted list with all their elements.

Write the function body, then press Run to check it.
"""


def merge_sorted(left: list[int], right: list[int]) -> list[int]:
    # Your solution goes here. Delete `pass` and write it.
    pass


if __name__ == "__main__":
    cases = [
        (([1, 2, 4], [1, 3, 4]), [1, 1, 2, 3, 4, 4]),
        (([], []), []),
        (([], [0]), [0]),
    ]
    passed = 0
    for args, want in cases:
        got = merge_sorted(*args)
        ok = got == want
        passed += ok
        print("pass" if ok else "FAIL", args, "->", got, "" if ok else f"(want {want})")
    print(f"{passed} of {len(cases)} passed")
