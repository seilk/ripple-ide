// Valid Anagram
//
// Return true when the two words use the same letters the same number of times.
// Write the function body, then press Run to check it.

function isAnagram(a, b) {
  // Your solution goes here.
}

const cases = [
  [['anagram', 'nagaram'], true],
  [['rat', 'car'], false],
  [['listen', 'silent'], true],
  [['a', 'ab'], false],
];
let passed = 0;
for (const [args, want] of cases) {
  const got = isAnagram(...args);
  const ok = got === want;
  passed += ok ? 1 : 0;
  console.log(ok ? 'pass' : 'FAIL', JSON.stringify(args), '->', got, ok ? '' : `(want ${want})`);
}
console.log(`${passed} of ${cases.length} passed`);
