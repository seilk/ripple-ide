// How long the agent takes for a task that needs several files, and in how many model turns.
//   RIPPLE_RUNTIME_URL=... PLAYWRIGHT_CORE=... CHROMIUM=... node tools/bench-agent-reads.mjs [runs]
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = Number(process.argv[2] || 3);
const PORT = 8796;
const PROMPT = 'Read hello.py, scripts/fizz.js, site/index.html, site/style.css, site/app.js and problems/two_sum.py, '
  + 'and compile kernels/saxpy.cu and kernels/rowsum.cu. Then give me one table: lines per file, and instructions per kernel. '
  + 'Do not change anything.';
const SSH = process.env.BENCH_SSH ? ['--ssh', process.env.BENCH_SSH] : []; // compile on the GPU machine, as the demo server does
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const workspace = mkdtempSync(join(tmpdir(), 'ripple-bench-'));
cpSync(join(ROOT, 'workspace'), workspace, { recursive: true });
const server = spawn('python3', ['server.py', '--port', String(PORT), '--workspace', workspace, ...SSH], { cwd: ROOT, stdio: 'ignore', env: process.env });
await new Promise((r) => setTimeout(r, 1500));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rows = [];
try {
  for (let run = 0; run < RUNS; run += 1) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    let turns = 0;
    page.on('request', (request) => { if (request.url().endsWith('/api/chat')) turns += 1; });
    await page.goto(`http://127.0.0.1:${PORT}`);
    await page.waitForSelector('body[data-ready="1"]');
    const started = Date.now();
    await page.locator('#prompt').fill(PROMPT);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#send').textContent === 'Send' && document.querySelector('#chat .say'), null, { timeout: 180000 });
    const seconds = (Date.now() - started) / 1000;
    const calls = await page.locator('#chat .tool').count();
    const toolMs = Number(await page.locator('#chat .msg-ripple').last().getAttribute('data-tool-ms') || 0); // the IDE's own clock
    rows.push({ seconds, turns, toolMs });
    console.log(`run ${run + 1}: ${seconds.toFixed(1)} s, ${turns} model turns, ${calls} tool calls, tools took ${toolMs} ms`);
    await context.close();
  }
  console.log(`median of ${RUNS}: ${median(rows.map((r) => r.seconds)).toFixed(1)} s, ${median(rows.map((r) => r.turns))} model turns, tools ${median(rows.map((r) => r.toolMs))} ms`);
} finally {
  await browser.close();
  server.kill();
  rmSync(workspace, { recursive: true, force: true });
}
