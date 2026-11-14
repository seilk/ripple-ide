"""A small script to try the Run button and inline suggestions."""


def mean(values: list[float]) -> float:
    return sum(values) / len(values)


def main() -> None:
    samples = [3.0, 4.5, 6.0]
    print(f"{len(samples)} samples, mean {mean(samples):.2f}")


if __name__ == "__main__":
    main()
