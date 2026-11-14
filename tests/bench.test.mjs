import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COMPLETION_CASES } from '../web/src/bench-cases.js';
import { compare, percentile, summarize } from '../web/src/bench.js';
import { fuzzyScore } from '../web/src/palette.js';

test('percentile picks the nearest rank and handles empty input', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([30, 10, 20], 0.5), 20);
  assert.equal(percentile([10, 20, 30, 40], 0.95), 40);
  assert.equal(percentile([7], 0.95), 7);
});

test('summary counts passes and errors and leaves failed requests out of latency', () => {
  const summary = summarize(
    [{ pass: true, ms: 100 }, { pass: false, ms: 300 }, { pass: false, ms: 9000, error: 'boom' }],
    [{ ttft: 200, tokps: 80 }, { ttft: null, tokps: null, error: 'down' }]);

  assert.deepEqual(summary, { total: 3, passed: 1, errors: 2, p50: 100, p95: 300, ttft: 200, tokps: 80 });
});

test('compare knows which direction is good for each number', () => {
  const diff = compare({ passed: 10, p50: 80, p95: 200, ttft: 150, tokps: 120 },
    { passed: 8, p50: 100, p95: 180, ttft: 150, tokps: 90 });

  assert.deepEqual(diff, {
    passed: { diff: 2, good: true }, tokps: { diff: 30, good: true },
    p50: { diff: -20, good: true }, p95: { diff: 20, good: false },
  });
  assert.deepEqual(compare({ passed: 1, p50: null }, null), {});
});

test('every completion case has a valid pattern that an obvious good answer passes', () => {
  const good = {
    'py-main-guard': '"__main__":\n    main()', 'py-numpy-alias': 'py as np', 'py-return-mean': 'sum(values) / len(values)',
    'py-list-comp': 'i ** 2 for i in range(n)]', 'js-console': 'log(total);', 'js-for-of': 'item of items) {',
    'js-arrow-map': 'user.name', 'cuda-global-index': 'blockIdx.x * blockDim.x + threadIdx.x;', 'cuda-float-suffix': 'f;',
    'cuda-syncthreads': 'threads();', 'triton-arange': 'tl.arange(0, BLOCK)', 'ptx-load-global': 'global.f32 \t%f1, [%rd1];',
    'py-body-fib': 'if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)', 'cuda-bounds-guard': 'if (i < n) y[i] *= a;',
  };
  assert.equal(new Set(COMPLETION_CASES.map((c) => c.id)).size, COMPLETION_CASES.length);
  for (const item of COMPLETION_CASES) {
    assert.ok(new RegExp(item.accept).test(good[item.id]), item.id);
    assert.ok(!new RegExp(item.accept).test(''), `${item.id} must not pass on an empty answer`);
  }
});

test('fuzzy score ranks closer matches first and rejects non-matches', () => {
  assert.equal(fuzzyScore('xyz', 'mode: kernel'), -1);
  assert.ok(fuzzyScore('kern', 'mode: kernel') >= 0);
  assert.ok(fuzzyScore('mode', 'mode: kernel') < fuzzyScore('mode', 'toggle live compile mode'));
});

test('stripFence leaves code only, also while the answer is still streaming', async () => {
  const { stripFence } = await import('../web/src/inline-edit.js');
  assert.equal(stripFence('x = 1\n'), 'x = 1');
  assert.equal(stripFence('```python\nx = 1\ny = 2\n```\n'), 'x = 1\ny = 2');
  assert.equal(stripFence('```py'), '');
  assert.equal(stripFence('```python\nx = '), 'x = ');
  assert.equal(stripFence('  a\n  b'), '  a\n  b');
});

test('remainder takes the typed characters off the front of a suggestion', async () => {
  const { remainder } = await import('../web/src/complete.js');
  assert.equal(remainder('    return ', 'sum(values) / len(values)', '    return su'), 'm(values) / len(values)');
  assert.equal(remainder('x = ', 'total', 'x = '), 'total');
  assert.equal(remainder('x = ', 'total', 'x = to'), 'tal');
  assert.equal(remainder('x = ', 'total', 'x = total'), null); // nothing left to show
  assert.equal(remainder('x = ', 'total', 'x = ma'), null);     // the typing went another way
  assert.equal(remainder('x = ', 'total', 'y = '), null);       // the line changed before the cursor
});
