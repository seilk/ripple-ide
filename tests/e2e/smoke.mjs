// End-to-end smoke test. Starts the IDE on a copy of the sample workspace,
// drives it in Chromium and writes screenshots.
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROMIUM=/path/to/chrome node tests/e2e/smoke.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT || 8791);
const SHOTS = process.env.SHOTS || join(ROOT, 'tests/e2e/shots');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const workspace = mkdtempSync(join(tmpdir(), 'ripple-ide-'));
cpSync(join(ROOT, 'workspace'), workspace, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const server = spawn('python3', ['server.py', '--port', String(PORT), '--workspace', workspace, '--mock-delay', '0.004'],
  { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${base}/api/presets`)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 100));
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const problems = [];
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(`console: ${msg.text()}`); });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  const modelText = (suffix) => page.evaluate((s) => window.monaco.editor.getModels()
    .find((m) => m.uri.path.endsWith(s))?.getValue() ?? null, suffix);
  const step = async (name, fn) => { await fn(); console.log(`ok  ${name}`); };

  await step('boots with the sample workspace and a toolchain', async () => {
    await page.goto(base);
    await page.waitForSelector('body[data-ready="1"]', { timeout: 20000 });
    assert.equal(await page.locator('.file').count(), 4);
    assert.match(await page.locator('.file[aria-current="true"]').innerText(), /rowsum\.cu|saxpy\.cu/);
    await page.locator('.file', { hasText: 'saxpy.cu' }).click();
    assert.match(await page.locator('#toolchain').innerText(), /nvcc|clang NVPTX preview/);
  });

  await step('compiles saxpy.cu and reports the fp64 ops', async () => {
    await page.locator('#compile').click();
    await page.waitForSelector('.fn[data-fn="saxpy"]');
    assert.match(await page.locator('#status').innerText(), /findings/);
    const fp64 = await page.locator('.fn[data-fn="saxpy"] .metrics div', { hasText: 'fp64 ops' }).locator('dd').innerText();
    assert.equal(fp64, '4');
    assert.equal(await page.locator('.fn[data-fn="saxpy"] .lint[data-code="fp64"]').count(), 4);
    const ptx = await page.evaluate(() => window.monaco.editor.getModels().find((m) => m.getLanguageId() === 'ptx' && m.uri.scheme !== 'file').getValue());
    assert.match(ptx, /\.entry _Z5saxpy/);
    assert.equal(await page.locator('#ptx-empty').isHidden(), true);
  });

  await step('links a source line to its PTX lines and marks the source', async () => {
    await page.locator('#src-editor .view-line', { hasText: '0.5 * y[i]' }).click();
    await page.waitForSelector('.ptx-pane .linked-line');
    assert.ok(await page.locator('.ptx-pane .linked-line').count() >= 3);
    const markers = await page.evaluate(() => window.monaco.editor.getModelMarkers({ owner: 'kernel-lint' })
      .filter((m) => m.resource.path.endsWith('saxpy.cu')).map((m) => [m.startLineNumber, m.source]));
    assert.deepEqual(markers, [[7, 'fp64']]);
  });

  await step('a finding jumps to its PTX line', async () => {
    await page.locator('.fn[data-fn="saxpy"] .lint[data-code="fp64"]').first().click();
    const line = await page.evaluate(() => window.monaco.editor.getEditors()
      .find((e) => e.getModel()?.getLanguageId() === 'ptx').getPosition().lineNumber);
    const ptxLine = await page.evaluate((n) => window.monaco.editor.getModels()
      .find((m) => m.getLanguageId() === 'ptx' && m.uri.scheme !== 'file').getLineContent(n), line);
    assert.match(ptxLine, /f64/);
  });
  await page.screenshot({ path: join(SHOTS, 'saxpy-1440.png') });

  await step('compiles rowsum.cu with Cmd/Ctrl+Enter: loops, local memory, heat strips', async () => {
    await page.locator('.file', { hasText: 'rowsum.cu' }).click();
    await page.locator('#src-editor .view-line').first().click();
    await page.keyboard.press('ControlOrMeta+Enter');
    await page.waitForSelector('.fn[data-fn="rowsum"]');
    const local = await page.locator('.fn[data-fn="rowsum"] .metrics div', { hasText: 'Local bytes' }).locator('dd').innerText();
    assert.equal(local, '32');
    assert.ok(await page.locator('.fn[data-fn="rowsum"] .lint[data-code="local-mem"]').count() >= 1);
    assert.equal(await page.locator('.fn[data-fn="rowsum"] .lint[data-code="int-div"][data-severity="warn"]').count(), 1);
    await page.locator('.fn[data-fn="rowsum"] .lint[data-code="local-mem"][data-hot]').first().click();
    await page.waitForSelector('.ptx-pane .loop-1, .ptx-pane .loop-2'); // Monaco draws visible lines only
  });
  await page.screenshot({ path: join(SHOTS, 'rowsum-1440.png') });

  await step('a syntax error shows a diagnostic on the source line', async () => {
    await page.evaluate(() => { const m = window.monaco.editor.getModels().find((x) => x.uri.path.endsWith('rowsum.cu')); window.__keep = m.getValue(); m.setValue(m.getValue().replace('float sum = 0.0f;', 'float sum = ;')); });
    await page.locator('#compile').click();
    await page.waitForSelector('.diag');
    assert.match(await page.locator('.diag').first().innerText(), /error/);
    const errors = await page.evaluate(() => window.monaco.editor.getModelMarkers({ owner: 'compiler' }).length);
    assert.ok(errors >= 1);
    assert.equal(await page.locator('.tab[data-dirty]').count(), 1);
    await page.evaluate(() => window.monaco.editor.getModels().find((x) => x.uri.path.endsWith('rowsum.cu')).setValue(window.__keep));
  });

  await step('a .ptx file is analysed live in one pane', async () => {
    await page.locator('.file', { hasText: 'saxpy_sm100.ptx' }).click();
    await page.waitForSelector('.fn[data-fn="saxpy"]');
    assert.equal(await page.locator('.ptx-pane').isVisible(), false);
    assert.equal(await page.locator('#compile-label').innerText(), 'Check PTX');
    await page.evaluate(() => { const m = window.monaco.editor.getModels().find((x) => x.uri.path.endsWith('saxpy_sm100.ptx')); window.__keep = m.getValue(); m.setValue(m.getValue().replaceAll('f64', 'f32')); });
    await page.waitForFunction(() => document.querySelectorAll('.fn[data-fn="saxpy"] .lint[data-code="fp64"]').length === 0);
    await page.evaluate(() => window.monaco.editor.getModels().find((x) => x.uri.path.endsWith('saxpy_sm100.ptx')).setValue(window.__keep));
    await page.waitForFunction(() => document.querySelectorAll('.fn[data-fn="saxpy"] .lint[data-code="fp64"]').length === 4);
  });
  await page.screenshot({ path: join(SHOTS, 'ptx-1440.png') });

  await step('mock Ripple reads, compiles and summarises', async () => {
    await page.locator('.file', { hasText: 'saxpy.cu' }).click();
    await page.locator('#quick button', { hasText: 'Why is this kernel slow' }).click();
    await page.waitForFunction(() => /Findings: fp64/.test(document.querySelector('#chat')?.textContent || ''), null, { timeout: 20000 });
    assert.equal(await page.locator('.tool[data-state="ok"]').count(), 2);
    assert.match(await page.locator('#perf').innerText(), /first token \d+ ms, \d+ tok\/s/);
    assert.match(await page.locator('#ctx').innerText(), /of 1\.05M tokens/);
  });

  await step('a Ripple edit needs approval, then lands in the editor and on disk', async () => {
    await page.locator('#quick button', { hasText: 'Add a header comment' }).click();
    await page.waitForSelector('#diff-dialog[open]');
    await page.screenshot({ path: join(SHOTS, 'diff-1440.png') });
    await page.locator('#diff-accept').click();
    await page.waitForFunction(() => /The change is in saxpy\.cu/.test(document.querySelector('#chat')?.textContent || ''));
    await page.waitForSelector('.fn[data-fn="saxpy"]'); // the report follows the applied edit
    assert.match(await modelText('saxpy.cu'), /^\/\/ Reviewed by Ripple \(mock run\)\./);
    const disk = await (await fetch(`${base}/api/file?path=saxpy.cu`)).json();
    assert.match(disk.content, /^\/\/ Reviewed by Ripple/);
    assert.equal(await page.locator('.tab[title="saxpy.cu"][data-dirty]').count(), 0);
  });

  await step('a rejected edit changes nothing', async () => {
    const before = await modelText('saxpy.cu');
    await page.locator('#prompt').fill('edit this again');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#diff-dialog[open]');
    await page.locator('#diff-reject').click();
    await page.waitForSelector('.tool[data-state="rejected"]');
    await page.waitForFunction(() => /You rejected the change/.test(document.querySelector('#chat')?.textContent || ''));
    assert.equal(await modelText('saxpy.cu'), before);
  });
  await page.screenshot({ path: join(SHOTS, 'ripple-1440.png') });

  await step('no horizontal overflow at 1024 and 1440', async () => {
    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `overflow ${overflow}px at ${width}`);
    }
    await page.screenshot({ path: join(SHOTS, 'ripple-1024.png') });
  });

  assert.deepEqual(problems, [], 'browser console must stay clean (CSP, script errors)');
  console.log('ok  browser console stayed clean');
} catch (error) {
  failed = true;
  console.error(`FAIL ${error.stack || error}`);
  if (problems.length) console.error(problems.join('\n'));
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
