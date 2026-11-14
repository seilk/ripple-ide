// Runs the lab's suggestion cases against an IDE server from the command line.
//   node tools/bench-cli.mjs [http://127.0.0.1:8787] [preset] ['{"temperature":0}']
import { COMPLETION_CASES } from '../web/src/bench-cases.js';
import { percentile } from '../web/src/bench.js';

const base = process.argv[2] || 'http://127.0.0.1:8787';
const preset = process.argv[3] || 'runtime';
const options = JSON.parse(process.argv[4] || '{}');
const times = [];
let passed = 0;
for (const test of COMPLETION_CASES) {
  const started = performance.now();
  const response = await fetch(`${base}/api/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset, options, language: test.language, path: test.path, prefix: test.prefix, suffix: test.suffix }),
  });
  const body = await response.json();
  const ms = Math.round(performance.now() - started);
  const got = body.completion ?? `ERROR ${body.error}`;
  const pass = response.ok && new RegExp(test.accept).test(got);
  if (response.ok) times.push(ms);
  passed += pass ? 1 : 0;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${test.id.padEnd(18)} ${String(ms).padStart(5)} ms  ${JSON.stringify(got).slice(0, 110)}`);
}
console.log(`\n${passed}/${COMPLETION_CASES.length} passed, median ${percentile(times, 0.5)} ms, 95th ${percentile(times, 0.95)} ms (${preset})`);
