// FizzBuzz for the first 15 numbers.
function fizz(n) {
  if (n % 15 === 0) return 'FizzBuzz';
  if (n % 3 === 0) return 'Fizz';
  if (n % 5 === 0) return 'Buzz';
  return String(n);
}

for (let n = 1; n <= 15; n += 1) {
  console.log(fizz(n));
}
