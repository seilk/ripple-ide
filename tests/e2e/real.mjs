// Drives the IDE against a real Ripple server and prints what happened.
// Not part of the offline test suite: the model's answers vary.
//
//   RIPPLE_RUNTIME_URL=http://127.0.0.1:8000/v1 RIPPLE_RUNTIME_MODEL=ripple \
//   PLAYWRIGHT_CORE=... CHROMIUM=... node tests/e2e/real.mjs
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8794;
const SHOTS = join(ROOT, 'tests/e2e/shots');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
if (!process.env.RIPPLE_RUNTIME_URL) { console.error('set RIPPLE_RUNTIME_URL'); process.exit(2); }

const workspace = mkdtempSync(join(tmpdir(), 'ripple-real-'));
cpSync(join(ROOT, 'workspace'), workspace, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const server = spawn('python3', ['server.py', '--port', String(PORT), '--workspace', workspace], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: process.env });
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${base}/api/presets`)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 100));
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
const text = (selector) => page.locator(selector).innerText();
const modelText = (suffix) => page.evaluate((s) => window.monaco.editor.getModels().find((m) => m.uri.path.endsWith(s))?.getValue() ?? null, suffix);
const openFromTree = async (name) => {
  await page.locator('#file-list .file', { hasText: name }).click();
  await page.waitForFunction((n) => document.querySelector('.tab[aria-selected="true"]')?.title.endsWith(n), name);
};
const setMode = async (name) => {
  await page.keyboard.press('ControlOrMeta+Shift+p');
  await page.waitForSelector('#palette[open]');
  await page.keyboard.type(`Mode: ${name}`);
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => document.querySelector('#mode').textContent === n, name);
};
const typeAtEnd = async (typed, delay = 60) => {
  await page.evaluate(() => {
    const editor = window.monaco.editor.getEditors().find((e) => e.getContainerDomNode().id === 'src-editor');
    const model = editor.getModel();
    editor.setPosition({ lineNumber: model.getLineCount(), column: model.getLineMaxColumn(model.getLineCount()) });
    editor.focus();
  });
  await page.keyboard.type(typed, { delay });
};
const ghost = () => page.evaluate(() => [...document.querySelectorAll('#src-editor .ghost-text-decoration, #src-editor .ghost-text')].map((el) => el.textContent).join(''));

try {
  await page.goto(base);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 20000 });
  console.log('profile in use:', await page.locator('#preset').evaluate((el) => el.selectedOptions[0].textContent));

  // 1. Inline suggestions while typing at a human pace.
  await openFromTree('hello.py');
  const seen = [];
  await page.exposeFunction('noteSuggest', (state) => seen.push(state));
  await page.evaluate(() => new MutationObserver(() => window.noteSuggest(document.querySelector('#suggest-state').textContent))
    .observe(document.querySelector('#suggest-state'), { childList: true, characterData: true, subtree: true }));
  await typeAtEnd('\n\ndef median(values: list[float]) -> float:\n');
  await page.waitForFunction(() => /Tab accepts/.test(document.querySelector('#suggest-state').textContent), null, { timeout: 15000 });
  console.log('\n[suggestion] after "def median(...):" ->', JSON.stringify(await ghost()), '|', await text('#suggest-state'));
  await page.keyboard.press('Tab');
  await page.waitForTimeout(800);
  console.log('[suggestion] after accept, next ->', JSON.stringify(await ghost()), '|', await text('#suggest-state'));
  await page.keyboard.press('Escape');
  await typeAtEnd('\n\nprint(med');
  await page.waitForFunction(() => /Tab accepts/.test(document.querySelector('#suggest-state').textContent), null, { timeout: 15000 });
  console.log('[suggestion] after "print(med" ->', JSON.stringify(await ghost()), '|', await text('#suggest-state'));
  await page.keyboard.press('Tab');
  const fromRipple = seen.filter((s) => /Ripple, \d+ ms/.test(s)).map((s) => Number(/(\d+) ms/.exec(s)[1]));
  console.log(`[suggestion] ${fromRipple.length} answers from Ripple while typing, ms: ${fromRipple.join(', ')}; kept while typing: ${seen.filter((s) => /kept/.test(s)).length}`);
  console.log('--- hello.py tail ---\n' + (await modelText('hello.py')).split('\n').slice(-12).join('\n'));
  await page.screenshot({ path: join(SHOTS, 'real-suggest.png') });

  // 2. Inline edit with Cmd+K on the mean() function.
  await page.evaluate(() => {
    const editor = window.monaco.editor.getEditors().find((e) => e.getContainerDomNode().id === 'src-editor');
    const lines = editor.getModel().getLinesContent();
    const start = lines.findIndex((l) => l.startsWith('def mean(')) + 1;
    editor.setSelection(new window.monaco.Range(start, 1, start + 1, lines[start].length + 1));
    editor.focus();
  });
  await page.keyboard.press('ControlOrMeta+k');
  await page.waitForSelector('#edit-bar:not([hidden])');
  await page.keyboard.type('return 0.0 when the list is empty, and add a short docstring');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /Edited \d+ lines? in|Edit failed|no change/.test(document.querySelector('#status').textContent), null, { timeout: 30000 });
  console.log('\n[inline edit]', await text('#status'));
  const edited = (await modelText('hello.py')).split('\n');
  const at = edited.findIndex((l) => l.startsWith('def mean('));
  console.log('--- mean() after the edit ---\n' + edited.slice(at, at + 9).join('\n'));
  await page.screenshot({ path: join(SHOTS, 'real-edit.png') });
  await page.locator('#primary').click();
  await page.waitForFunction(() => /exit \d+ in/.test(document.querySelector('#output').textContent), null, { timeout: 20000 });
  console.log('[run after edits]', (await text('#output')).trim().split('\n').slice(-3).join(' | '));

  // 3. The agent on a kernel: read, compile, fix, compile again.
  await setMode('Kernel');
  await openFromTree('saxpy.cu');
  await page.waitForSelector('.fn[data-fn="saxpy"]');
  const fp64 = () => page.locator('.fn[data-fn="saxpy"] [data-metric="fp64 ops"] dd span').first().innerText();
  console.log('\n[agent] fp64 ops before:', await fp64());
  let approved = 0;
  const approve = setInterval(async () => {
    try { if (await page.locator('#diff-dialog[open]').count()) { approved += 1; await page.locator('#diff-accept').click(); } } catch { /* page busy */ }
  }, 400);
  const started = Date.now();
  await page.locator('#prompt').fill('This kernel has double-precision ops. Find the cause, fix it with the smallest edit, and confirm with a compile.');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#send').textContent === 'Send' && document.querySelectorAll('#chat .tool').length > 0, null, { timeout: 180000 });
  clearInterval(approve);
  console.log(`[agent] finished in ${((Date.now() - started) / 1000).toFixed(1)} s; diffs approved: ${approved}; ${await text('#perf')}`);
  console.log('[agent] tools:', (await page.locator('#chat .tool').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').slice(0, 70)).join('\n               '));
  console.log('[agent] answer:', (await page.locator('#chat .say').last().innerText()).replace(/\s+/g, ' ').slice(0, 400));
  await page.waitForTimeout(1500);
  console.log('[agent] fp64 ops after:', await fp64(), '| line 7:', (await modelText('saxpy.cu')).split('\n').find((l) => l.includes('y[i] =')));
  await page.screenshot({ path: join(SHOTS, 'real-agent.png') });

  // 4. Benchmark in the lab.
  await setMode('Ripple lab');
  await page.locator('#bench-run').click();
  await page.waitForSelector('.bench-table tbody tr', { timeout: 120000 });
  console.log('\n[benchmark]', (await page.locator('.bench-table tbody tr').first().innerText()).replace(/\s+/g, ' '));
  console.log('[session]', await text('.lab-session'));
  await page.screenshot({ path: join(SHOTS, 'real-lab.png') });
  console.log('\npage errors:', problems.length ? problems : 'none');
} catch (error) {
  console.error('FAIL', error.stack || error);
  await page.screenshot({ path: join(SHOTS, 'real-fail.png') }).catch(() => {});
  console.error('status:', await text('#status').catch(() => '?'), '| page errors:', problems);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
