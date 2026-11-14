// The agent makes a file (the IDE then opens it) and keeps working. Reports the run time and
// how much of the prompt the Ripple server took from its prefix cache during the run.
// The server counters are for the whole server: run this while nobody else uses it.
//   RIPPLE_RUNTIME_URL=http://127.0.0.1:8000/v1 PLAYWRIGHT_CORE=... CHROMIUM=... node tools/bench-agent-make.mjs [runs]
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = Number(process.argv[2] || 3);
const PORT = 8797;
const PROMPT = 'Read site/index.html, site/style.css, site/app.js and README.md. Then create site/about.html, a short page about '
  + 'this project in the same style. After that read site/about.html back and add one footer line to it.';
const METRICS = `${process.env.RIPPLE_RUNTIME_URL.replace(/\/v1\/?$/, '')}/metrics`;
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const counter = async (name) => {
  const text = await (await fetch(METRICS)).text();
  return [...text.matchAll(new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([-+0-9.eE]+)$`, 'gm'))].reduce((sum, m) => sum + Number(m[1]), 0);
};
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const rows = [];
try {
  for (let run = 0; run < RUNS; run += 1) {
    const workspace = mkdtempSync(join(tmpdir(), 'ripple-bench-'));
    cpSync(join(ROOT, 'workspace'), workspace, { recursive: true });
    const server = spawn('python3', ['server.py', '--port', String(PORT), '--workspace', workspace], { cwd: ROOT, stdio: 'ignore', env: process.env });
    await new Promise((r) => setTimeout(r, 1500));
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    let turns = 0;
    page.on('request', (request) => { if (request.url().endsWith('/api/chat')) turns += 1; });
    await page.goto(`http://127.0.0.1:${PORT}`);
    await page.waitForSelector('body[data-ready="1"]');
    await page.locator('#toggle-suggest').click(); // no suggestion requests in the count
    const [prompt0, cached0] = [await counter('vllm:prompt_tokens_total'), await counter('vllm:prompt_tokens_cached_total')];
    const started = Date.now();
    await page.locator('#prompt').fill(PROMPT);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#send').textContent === 'Send' && document.querySelector('#chat .say'), null, { timeout: 240000 });
    const seconds = (Date.now() - started) / 1000;
    const [prompt, cached] = [await counter('vllm:prompt_tokens_total') - prompt0, await counter('vllm:prompt_tokens_cached_total') - cached0];
    rows.push({ seconds, turns, share: cached / prompt, uncached: prompt - cached });
    console.log(`run ${run + 1}: ${seconds.toFixed(1)} s, ${turns} model turns, ${Math.round(prompt)} prompt tokens, ${Math.round(100 * cached / prompt)} % from cache, ${Math.round(prompt - cached)} computed`);
    await context.close();
    server.kill();
    rmSync(workspace, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`median of ${RUNS}: ${median(rows.map((r) => r.seconds)).toFixed(1)} s, ${median(rows.map((r) => r.turns))} turns, ${Math.round(100 * median(rows.map((r) => r.share)))} % from cache, ${Math.round(median(rows.map((r) => r.uncached)))} prompt tokens computed`);
} finally {
  await browser.close();
}
