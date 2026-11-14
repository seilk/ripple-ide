// End-to-end smoke test. Starts the IDE on a copy of the sample workspace,
// drives it in Chromium and writes screenshots.
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROMIUM=/path/to/chrome node tests/e2e/smoke.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
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

// A stand-in for a locally tuned Ripple server: always the same answer, after a short delay.
const FAKE_PORT = PORT + 2;
const fakeSeen = {};
const fake = createServer((request, response) => {
  let raw = '';
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => setTimeout(() => {
    const body = JSON.parse(raw);
    if (!body.stream) Object.assign(fakeSeen, body); // keep the last suggestion request
    const text = 'blockIdx.x * blockDim.x + threadIdx.x;';
    if (!body.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const word of ['tuned ', 'answer']) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  }, 30));
}).listen(FAKE_PORT, '127.0.0.1');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const problems = [];
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(`console: ${msg.text()}`); });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  const step = async (name, fn) => { await fn(); console.log(`ok  ${name}`); };
  const modelText = (suffix) => page.evaluate((s) => window.monaco.editor.getModels()
    .find((m) => m.uri.path.endsWith(s))?.getValue() ?? null, suffix);
  const setModelText = (suffix, text) => page.evaluate(([s, t]) => window.monaco.editor.getModels()
    .find((m) => m.uri.path.endsWith(s)).setValue(t), [suffix, text]);
  const chatHas = (pattern) => page.waitForFunction((source) => new RegExp(source).test(document.querySelector('#chat')?.textContent || ''), pattern, { timeout: 20000 });
  const openFromTree = async (name) => {
    await page.locator('#file-list .file', { hasText: name }).click();
    await page.waitForFunction((n) => document.querySelector('.tab[aria-selected="true"]')?.title.endsWith(n), name);
  };
  const activeTab = () => page.locator('.tab[aria-selected="true"]').getAttribute('title');
  /** Put the cursor at the end of the source editor and type. */
  const typeAtEnd = async (text) => {
    await page.evaluate(() => {
      const editor = window.monaco.editor.getEditors().find((e) => e.getContainerDomNode().id === 'src-editor');
      const model = editor.getModel();
      editor.setPosition({ lineNumber: model.getLineCount(), column: model.getLineMaxColumn(model.getLineCount()) });
      editor.focus();
    });
    await page.keyboard.type(text, { delay: 15 });
  };
  const setMode = async (name) => {
    await page.keyboard.press('ControlOrMeta+Shift+p');
    await page.waitForSelector('#palette[open]');
    await page.keyboard.type(`Mode: ${name}`);
    await page.keyboard.press('Enter');
    await page.waitForFunction((n) => document.querySelector('#mode').textContent === n, name);
  };
  const metric = (fn, label) => page.locator(`.fn[data-fn="${fn}"] [data-metric="${label}"] dd span`).first().innerText();

  await step('boots as a general IDE: file tree, welcome file, no kernel chrome', async () => {
    await page.goto(base);
    await page.waitForSelector('body[data-ready="1"]', { timeout: 20000 });
    assert.equal(await page.title(), 'Ripple IDE');
    assert.equal(await page.locator('#file-list .file.folder').count(), 2);
    assert.equal(await page.locator('#file-list .file:not(.folder)').count(), 7);
    assert.equal(await activeTab(), 'README.md');
    assert.equal(await page.locator('.ptx-pane').isVisible(), false);
    assert.equal(await page.locator('#toolchain').isVisible(), false);
    assert.equal(await page.locator('#primary').isDisabled(), true); // nothing runs a .md file
  });

  await step('runs a Python file and streams its output', async () => {
    await openFromTree('hello.py');
    assert.equal(await page.locator('#primary-label').innerText(), 'Run');
    assert.equal(await page.locator('#language').innerText(), 'Python');
    await page.locator('#primary').click();
    await page.waitForFunction(() => /exit 0 in/.test(document.querySelector('#output').textContent));
    assert.match(await page.locator('#output').innerText(), /3 samples, mean 4\.50/);
    assert.match(await page.locator('#status').innerText(), /Ran in/);
  });

  await step('inline suggestion appears as ghost text and Tab accepts it', async () => {
    await typeAtEnd('\nimport num');
    await page.waitForFunction(() => /Tab accepts \(idioms\)/.test(document.querySelector('#suggest-state').textContent));
    await page.waitForSelector('#src-editor .ghost-text-decoration, #src-editor .ghost-text');
    await page.keyboard.press('Tab');
    assert.match(await modelText('hello.py'), /import numpy as np$/);
  });
  await page.screenshot({ path: join(SHOTS, 'general-1440.png') });

  await step('suggestions can be switched off', async () => {
    await page.locator('#toggle-suggest').click();
    await typeAtEnd('\nimport num');
    await page.waitForTimeout(700);
    assert.equal(await page.locator('#src-editor .ghost-text-decoration, #src-editor .ghost-text').count(), 0);
    await page.locator('#toggle-suggest').click();
  });

  await step('quick open finds a kernel; it compiles live and the kernel tools appear', async () => {
    await page.keyboard.press('ControlOrMeta+p');
    await page.waitForSelector('#palette[open]');
    await page.keyboard.type('saxpy.cu');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.tab[aria-selected="true"]')?.title === 'kernels/saxpy.cu');
    assert.equal(await page.locator('.ptx-pane').isVisible(), false); // General mode: a .cu file is just a source file
    assert.equal(await page.locator('#language').innerText(), 'CUDA');
    assert.match(await page.locator('#status').innerText(), /Kernel mode adds the PTX pane/);
    await setMode('Kernel');
    await page.waitForSelector('.fn[data-fn="saxpy"]'); // no click on Compile: live compile
    assert.equal(await activeTab(), 'kernels/saxpy.cu');
    assert.equal(await page.locator('.ptx-pane').isVisible(), true);
    assert.match(await page.locator('#toolchain').innerText(), /nvcc|clang NVPTX preview/);
    assert.equal(await page.locator('#primary-label').innerText(), 'Compile to PTX');
    assert.equal(await page.locator('#tab-report').getAttribute('aria-selected'), 'true');
    assert.equal(await metric('saxpy', 'fp64 ops'), '4');
    assert.equal(await page.locator('.fn[data-fn="saxpy"] .lint[data-code="fp64"]').count(), 4);
    assert.equal(await page.locator('#outline .kernel').count(), 1);
  });

  await step('line info is folded away until asked for', async () => {
    // Folded lines leave the PTX editor with fewer view lines than the model has.
    const folded = () => page.evaluate(() => {
      const editor = window.monaco.editor.getEditors().find((e) => e.getContainerDomNode().id === 'ptx-editor');
      return editor.getModel().getLineCount() - editor._getViewModel().getLineCount();
    });
    assert.ok(await folded() >= 10);
    await page.locator('#toggle-debug').click();
    assert.equal(await folded(), 0);
    await page.locator('#toggle-debug').click();
    assert.ok(await folded() >= 10);
  });

  await step('links a source line to its PTX lines and marks the source', async () => {
    await page.locator('#src-editor .view-line', { hasText: '0.5 * y[i]' }).click();
    await page.waitForSelector('.ptx-pane .linked-line');
    assert.ok(await page.locator('.ptx-pane .linked-line').count() >= 3);
    const markers = await page.evaluate(() => window.monaco.editor.getModelMarkers({ owner: 'kernel-lint' })
      .filter((m) => m.resource.path.endsWith('saxpy.cu')).map((m) => [m.startLineNumber, m.source]));
    assert.deepEqual(markers, [[7, 'fp64']]);
  });
  await page.screenshot({ path: join(SHOTS, 'kernel-1440.png') });

  await step('the quick fix adds the f suffix and the report shows the drop against the baseline', async () => {
    await page.evaluate(() => {
      const editor = window.monaco.editor.getEditors().find((e) => e.getContainerDomNode().id === 'src-editor');
      editor.setPosition({ lineNumber: 7, column: 5 });
      editor.focus();
      editor.trigger('test', 'editor.action.autoFix', null);
    });
    await page.waitForFunction(() => window.monaco.editor.getModels().find((m) => m.uri.path.endsWith('saxpy.cu')).getValue().includes('0.5f * y[i]'));
    await page.waitForFunction(() => document.querySelector('.fn[data-fn="saxpy"] [data-metric="fp64 ops"] dd span')?.textContent === '0');
    assert.equal(await page.locator('.fn[data-fn="saxpy"] [data-metric="fp64 ops"] .delta[data-dir="down"]').innerText(), '−4');
    assert.match(await page.locator('.baseline').innerText(), /Changes are against the .* compile/);
    assert.match(await page.locator('#status').innerText(), /Live: 0 findings/);
  });

  await step('a kernel idiom is suggested inline in CUDA', async () => {
    await typeAtEnd('\nfloat scale = 0.25');
    await page.waitForFunction(() => /Tab accepts/.test(document.querySelector('#suggest-state').textContent));
    await page.keyboard.press('Tab');
    await page.keyboard.type(';');
    assert.match(await modelText('saxpy.cu'), /float scale = 0\.25f;$/);
  });

  await step('rowsum.cu: loops, local memory, the remainder, loop strips', async () => {
    await openFromTree('rowsum.cu');
    await page.waitForSelector('.fn[data-fn="rowsum"]');
    assert.equal(await metric('rowsum', 'Local bytes'), '32');
    assert.equal(await page.locator('.fn[data-fn="rowsum"] .lint[data-code="int-div"][data-severity="warn"]').count(), 1);
    await page.locator('.fn[data-fn="rowsum"] .lint[data-code="local-mem"][data-hot]').first().click();
    await page.waitForSelector('.ptx-pane .loop-1, .ptx-pane .loop-2'); // Monaco draws visible lines only
  });

  await step('a syntax error keeps the last good PTX and shows the diagnostic', async () => {
    const good = await modelText('rowsum.cu');
    await setModelText('rowsum.cu', good.replace('float sum = 0.0f;', 'float sum = ;'));
    await page.waitForSelector('.note[data-stale]');
    assert.match(await page.locator('.diag').first().innerText(), /error/);
    assert.equal(await page.locator('#ptx-empty').isHidden(), true);
    assert.match(await page.locator('#ptx-meta').innerText(), /last good compile/);
    assert.ok(await page.evaluate(() => window.monaco.editor.getModelMarkers({ owner: 'compiler' }).length) >= 1);
    await setModelText('rowsum.cu', good);
    await page.waitForFunction(() => !document.querySelector('.note[data-stale]'));
  });

  await step('a .ptx file is analysed live in one pane', async () => {
    await openFromTree('saxpy_sm100.ptx');
    await page.waitForSelector('.fn[data-fn="saxpy"]');
    assert.equal(await page.locator('.ptx-pane').isVisible(), false);
    assert.equal(await page.locator('#primary-label').innerText(), 'Check PTX');
    const original = await modelText('saxpy_sm100.ptx');
    await setModelText('saxpy_sm100.ptx', original.replaceAll('f64', 'f32'));
    await page.waitForFunction(() => document.querySelectorAll('.fn[data-fn="saxpy"] .lint[data-code="fp64"]').length === 0);
    await setModelText('saxpy_sm100.ptx', original);
    await page.waitForFunction(() => document.querySelectorAll('.fn[data-fn="saxpy"] .lint[data-code="fp64"]').length === 4);
  });

  await step('dividers resize panes by dragging and reset on double-click', async () => {
    const size = (id, side) => page.evaluate(([i, s]) => document.getElementById(i).getBoundingClientRect()[s], [id, side]);
    const drag = async (id, dx, dy) => {
      const box = await page.locator(`#${id}`).boundingBox();
      const x = box.x + box.width / 2; const y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 4 }); await page.mouse.up();
    };
    const dock = await size('dock', 'height');
    await drag('divide-dock', 0, -80);
    assert.ok(Math.abs(await size('dock', 'height') - (dock + 80)) <= 2);
    const ripple = await size('ripple', 'width');
    await drag('divide-ripple', -60, 0);
    assert.ok(Math.abs(await size('ripple', 'width') - (ripple + 60)) <= 2);
    const files = await size('files', 'width');
    await drag('divide-files', 40, 0);
    assert.ok(Math.abs(await size('files', 'width') - (files + 40)) <= 2);
    await page.locator('#divide-dock').dblclick();
    await page.locator('#divide-ripple').dblclick();
    await page.locator('#divide-files').dblclick();
    assert.ok(Math.abs(await size('dock', 'height') - dock) <= 2);
    await openFromTree('rowsum.cu');
    const src = await size('src-pane', 'width');
    await drag('divide-split', 90, 0);
    assert.ok(Math.abs(await size('src-pane', 'width') - (src + 90)) <= 2);
    await page.locator('#divide-split').dblclick();
  });

  await step('search in files opens the hit, and the JavaScript file runs', async () => {
    await page.keyboard.press('ControlOrMeta+Shift+f');
    await page.waitForSelector('#palette[open]');
    await page.keyboard.type('FizzBuzz');
    await page.waitForFunction(() => /scripts\/fizz\.js:\d+/.test(document.querySelector('.palette-row')?.textContent || ''));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.tab[aria-selected="true"]')?.title === 'scripts/fizz.js');
    await page.locator('#primary').click();
    await page.waitForFunction(() => /exit 0 in/.test(document.querySelector('#output').textContent));
    assert.match(await page.locator('#output').innerText(), /Fizz\nBuzz/);
  });

  await step('creates a file and deletes it', async () => {
    await page.locator('#new-file').click();
    await page.locator('#new-file-path').fill('notes/todo.py');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.tab[aria-selected="true"]')?.title === 'notes/todo.py');
    assert.equal(existsSync(join(workspace, 'notes/todo.py')), true);
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('.file-row', { hasText: 'todo.py' }).hover();
    await page.locator('.file-row', { hasText: 'todo.py' }).locator('.file-delete').click();
    await page.waitForFunction(() => !document.querySelector('#file-list').textContent.includes('todo.py'));
    assert.equal(existsSync(join(workspace, 'notes/todo.py')), false);
  });

  await step('mock Ripple reads a kernel, compiles it and reports', async () => {
    await openFromTree('rowsum.cu');
    await page.locator('#quick button', { hasText: 'Why is this kernel slow' }).click();
    await chatHas('Findings: local-mem');
    assert.equal(await page.locator('.tool[data-state="ok"]').count(), 2);
    assert.match(await page.locator('#perf').innerText(), /first token \d+ ms, \d+ tok\/s/);
    assert.match(await page.locator('#ctx').innerText(), /of 1\.05M tokens/);
  });

  await step('a Ripple edit needs approval, then lands in the editor and on disk', async () => {
    await page.locator('#quick button', { hasText: 'Add a header comment' }).click();
    await page.waitForSelector('#diff-dialog[open]');
    await page.screenshot({ path: join(SHOTS, 'diff-1440.png') });
    await page.locator('#diff-accept').click();
    await chatHas('The change is in kernels/rowsum\\.cu');
    assert.match(await modelText('rowsum.cu'), /^\/\/ Reviewed by Ripple \(mock run\)\./);
    const disk = await (await fetch(`${base}/api/file?path=kernels/rowsum.cu`)).json();
    assert.match(disk.content, /^\/\/ Reviewed by Ripple/);
    assert.equal(await page.locator('.tab[title="kernels/rowsum.cu"][data-dirty]').count(), 0);
  });

  await step('a rejected edit changes nothing', async () => {
    const before = await modelText('rowsum.cu');
    await page.locator('#prompt').fill('edit this again');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#diff-dialog[open]');
    await page.locator('#diff-reject').click();
    await chatHas('You rejected the change');
    assert.equal(await modelText('rowsum.cu'), before);
  });

  await step('Ripple runs a file only after the user allows it', async () => {
    await openFromTree('fizz.js');
    await page.locator('#prompt').fill('run this file');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#confirm-dialog[open]');
    assert.equal(await page.locator('#confirm-detail').innerText(), 'scripts/fizz.js');
    await page.locator('#confirm-yes').click();
    await chatHas('The run finished[\\s\\S]*FizzBuzz'); // the answer streams word by word
  });
  await page.screenshot({ path: join(SHOTS, 'ripple-1440.png') });

  await step('Ripple lab: a profile change applies at once and the benchmark measures it', async () => {
    await setMode('Ripple lab');
    assert.equal(await page.locator('#lab-pane').isVisible(), true);
    assert.equal(await page.locator('.ptx-pane').isVisible(), false);
    assert.equal(await page.locator('#toolchain').isVisible(), false);
    assert.equal(await page.locator('#tab-bench').getAttribute('aria-selected'), 'true');
    await page.locator('#bench-run').click();
    await page.waitForSelector('.bench-table tbody tr');
    const first = await page.locator('.bench-table tbody tr').first().innerText();
    assert.match(first, /Mock Ripple \(offline\)\s+9\/12/); // the idiom table knows 9 of the 12 cases
    assert.match(first, /baseline/);

    // A copy of the profile, pointed at a local stand-in for a tuned Ripple server.
    await page.locator('#lab-duplicate').click();
    await page.locator('#lab-endpoint').selectOption('custom');
    await page.locator('#lab-url').fill(`http://127.0.0.1:${FAKE_PORT}/v1`);
    await page.locator('#lab-model').fill('ripple-opt');
    await page.locator('#lab-name').fill('Tuned runtime');
    await page.locator('#lab-tokens').fill('48');
    await page.locator('#lab-extraBody').fill('{"top_k": 20}');
    assert.equal(await page.locator('#preset').evaluate((el) => el.selectedOptions[0].textContent), 'Tuned runtime');
    await page.locator('#bench-run').click();
    await page.waitForFunction(() => document.querySelectorAll('.bench-table tbody tr').length === 2);
    const tuned = await page.locator('.bench-table tbody tr').first().innerText();
    assert.match(tuned, /Tuned runtime\s+2\/12/); // the stand-in gives one fixed answer; it fits two patterns
    assert.equal(await page.locator('.bench-table tbody tr').first().locator('.delta[data-dir="up"]').first().innerText(), '\u22127');
    assert.match(tuned, /\d+ ms\+\d+/); // slower than the offline mock, and the table says so
    assert.deepEqual([fakeSeen.model, fakeSeen.max_tokens, fakeSeen.top_k], ['ripple-opt', 48, 20]);
    await page.screenshot({ path: join(SHOTS, 'lab-1440.png') });

    // The same profile now drives the editor: the suggestion comes from the stand-in server.
    await openFromTree('hello.py');
    await typeAtEnd('\nindex = ');
    await page.waitForFunction(() => /Tab accepts \(Ripple, \d+ ms\)/.test(document.querySelector('#suggest-state').textContent));
    await page.keyboard.press('Tab');
    assert.match(await modelText('hello.py'), /index = blockIdx\.x \* blockDim\.x \+ threadIdx\.x;$/);
    await page.waitForFunction(() => /Suggestions: \d+ shown, [3-9] accepted/.test(document.querySelector('.lab-session').textContent));

    await page.locator('#preset').selectOption('mock');
    assert.equal(await page.locator('#lab-name').inputValue(), 'Mock Ripple (offline)');
    await setMode('General');
    assert.equal(await page.locator('#lab-pane').isVisible(), false);
    assert.equal(await page.locator('#tab-bench').isVisible(), false);
  });

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
  fake.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
