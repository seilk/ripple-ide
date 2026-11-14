"""FizzBuzz

Return the list for 1..n where multiples of 3 are "Fizz", multiples of 5 are "Buzz",
multiples of both are "FizzBuzz", and every other number is the number as a string.

Write the function body, then press Run to check it.
"""


def fizzbuzz(n: int) -> list[str]:
    # Your solution goes here. Delete `pass` and write it.
    pass


if __name__ == "__main__":
    cases = [
        ((5,), ["1", "2", "Fizz", "4", "Buzz"]),
        ((15,), ["1", "2", "Fizz", "4", "Buzz", "Fizz", "7", "8", "Fizz", "Buzz", "11", "Fizz", "13", "14", "FizzBuzz"]),
    ]
    passed = 0
    for args, want in cases:
        got = fizzbuzz(*args)
        ok = got == want
        passed += ok
        print("pass" if ok else "FAIL", args, "->", got, "" if ok else f"(want {want})")
    print(f"{passed} of {len(cases)} passed")
