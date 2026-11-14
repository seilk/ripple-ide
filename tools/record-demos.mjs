// Records the main features on a real Ripple and writes one GIF for each: a suggestion while
// typing, an inline edit (Cmd+K), the agent fixing and running a file, and the Ripple status panel.
//
//   RIPPLE_RUNTIME_URL=http://127.0.0.1:8000/v1 RIPPLE_RUNTIME_MODEL=ripple \
//   PLAYWRIGHT_CORE=... CHROMIUM=... node tools/record-demos.mjs [out dir] [scene ...]
//
// Needs ffmpeg. The answers come from the model, so look at each GIF before you use it.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] || join(ROOT, 'docs/media'));
const ONLY = process.argv.slice(3);
const PORT = 8796;
const VIEW = { width: 1120, height: 700 }; // tall enough for the sample file and the lines Ripple adds
const GIF_WIDTH = 1680; // frames are painted at twice the view size; 1.5x keeps small text sharp on a slide
const GIF_FPS = 12.5; // 8 hundredths of a second for each frame, which a GIF can hold exactly
const LONGEST_STILL_S = 1.6; // a wait with nothing on screen is cut to this
const LAST_FRAME_S = 3;
// Pane sizes for each scene (the IDE reads them from its saved settings): room for the part that matters.
const PANES = {
  suggest: { '--files-w': '176px', '--ripple-w': '264px', '--dock-h': '96px' },
  edit: { '--files-w': '176px', '--ripple-w': '264px', '--dock-h': '96px' },
  agent: { '--files-w': '176px', '--dock-h': '150px' },
  status: { '--files-w': '176px', '--ripple-w': '420px', '--dock-h': '150px' },
};
const BUGGY = `def average(values):
    total = 0
    for value in values:
        total += value
    return total / (len(values) - 1)


print(average([2, 4, 6]))  # expected 4.0
`;

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
if (!process.env.RIPPLE_RUNTIME_URL) { console.error('set RIPPLE_RUNTIME_URL'); process.exit(2); }

const workspace = mkdtempSync(join(tmpdir(), 'ripple-demo-'));
cpSync(join(ROOT, 'workspace'), workspace, { recursive: true });
writeFileSync(join(workspace, 'average.py'), BUGGY);
mkdirSync(OUT, { recursive: true });
const server = spawn('python3', ['server.py', '--port', String(PORT), '--workspace', workspace], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: process.env });
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${base}/api/presets`)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 100));
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });

/** Frames of the page as the browser paints them, each with the time it was painted. */
async function record(page, frames) {
  const cdp = await page.context().newCDPSession(page);
  const shots = [];
  let count = 0;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = join(frames, `${String(count).padStart(5, '0')}.jpg`);
    count += 1;
    writeFileSync(file, Buffer.from(data, 'base64'));
    shots.push({ file, at: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
  return async () => { await cdp.send('Page.stopScreencast'); return shots; };
}

function toGif(shots, frames, target, crop) {
  // The time of each frame, with long waits cut short.
  const times = [0];
  for (let i = 1; i < shots.length; i += 1) times.push(times[i - 1] + Math.min(LONGEST_STILL_S, shots[i].at - shots[i - 1].at));
  // One picture for each GIF frame: what was on screen at that moment.
  const total = Math.ceil((times.at(-1) + LAST_FRAME_S) * GIF_FPS);
  let shown = 0;
  for (let frame = 0; frame < total; frame += 1) {
    while (shown + 1 < shots.length && times[shown + 1] <= frame / GIF_FPS) shown += 1;
    symlinkSync(shots[shown].file, join(frames, `seq-${String(frame).padStart(5, '0')}.jpg`));
  }
  // A scene can keep one part of the page: `crop` is in page pixels, the frames are larger by a fixed ratio.
  const part = crop ? `crop=iw*${crop.width / VIEW.width}:ih*${crop.height / VIEW.height}:iw*${crop.x / VIEW.width}:ih*${crop.y / VIEW.height},` : '';
  const width = crop ? Math.round(crop.width) * 2 : GIF_WIDTH; // a part is small, so it keeps every pixel of the frame
  const filter = `${part}scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(GIF_FPS), '-i', join(frames, 'seq-%05d.jpg'), '-vf', filter, target], { stdio: 'inherit' });
  if (made.status !== 0) throw new Error(`ffmpeg failed for ${target}`);
  return total / GIF_FPS;
}

const helpers = (page) => ({
  open: async (name) => {
    await page.locator('#file-list .file', { hasText: name }).click();
    await page.waitForFunction((n) => document.querySelector('.tab[aria-selected="true"]')?.title.endsWith(n), name);
  },
  toEnd: () => page.evaluate(() => {
    const editor = window.monaco.editor.getEditors().find((e) => e.getContainerDomNode().id === 'src-editor');
    const model = editor.getModel();
    const last = model.getLineCount();
    editor.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
    editor.revealLine(last);
    editor.focus();
  }),
  suggestionReady: () => page.waitForFunction(() => /Tab accepts/.test(document.querySelector('#suggest-state').textContent), null, { timeout: 20000 }),
  text: (suffix) => page.evaluate((s) => window.monaco.editor.getModels().find((m) => m.uri.path.endsWith(s))?.getValue() ?? '', suffix),
});

const SCENES = {
  // 1. Type the first line of a function. Ripple writes the body; Tab takes it.
  suggest: async (page, h, start) => {
    await h.open('hello.py');
    await h.toEnd();
    const stop = await start();
    await page.waitForTimeout(700);
    await page.keyboard.type('\n\ndef median(values: list[float]) -> float:\n', { delay: 70 });
    await h.suggestionReady();
    await page.waitForTimeout(1500);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1200);
    console.log('  hello.py now ends with:\n' + (await h.text('hello.py')).split('\n').slice(-10).map((l) => '    ' + l).join('\n'));
    return stop;
  },
  // 2. Select a function, press Cmd+K, say what to change.
  edit: async (page, h, start) => {
    await h.open('hello.py');
    await page.evaluate(() => {
      const editor = window.monaco.editor.getEditors().find((e) => e.getContainerDomNode().id === 'src-editor');
      const lines = editor.getModel().getLinesContent();
      const first = lines.findIndex((l) => l.startsWith('def mean(')) + 1;
      editor.setSelection(new window.monaco.Range(first, 1, first + 1, lines[first].length + 1));
      editor.revealLineInCenter(first);
      editor.focus();
    });
    const stop = await start();
    await page.waitForTimeout(900);
    await page.keyboard.press('ControlOrMeta+k');
    await page.waitForSelector('#edit-bar:not([hidden])');
    await page.waitForTimeout(400);
    await page.keyboard.type('return 0.0 when the list is empty, and add a short docstring', { delay: 35 });
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Edited \d+ lines? in|Edit failed|no change/.test(document.querySelector('#status').textContent), null, { timeout: 40000 });
    console.log('  status:', await page.locator('#status').innerText());
    await page.waitForTimeout(1200);
    return stop;
  },
  // 3. Ask the agent to fix a file and check it. It reads, edits, asks to run, and reports.
  agent: async (page, h, start) => {
    await h.open('average.py');
    const stop = await start();
    await page.waitForTimeout(700);
    await page.locator('#prompt').click();
    await page.keyboard.type('average.py prints the wrong number. Fix it and run it to check.', { delay: 28 });
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    const allow = setInterval(async () => {
      try {
        if (await page.locator('#confirm-dialog[open]').count()) {
          await page.waitForTimeout(1100); // long enough to read the question
          await page.locator('#confirm-yes').click();
        }
      } catch { /* page busy */ }
    }, 300);
    await page.waitForFunction(() => document.querySelector('#send').textContent === 'Send' && document.querySelectorAll('#chat .tool').length > 0, null, { timeout: 180000 });
    clearInterval(allow);
    console.log('  tools:', (await page.locator('#chat .tool').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').slice(0, 60)).join(' | '));
    console.log('  answer:', (await page.locator('#chat .say').last().innerText()).replace(/\s+/g, ' ').slice(0, 300));
    console.log('  average.py:', JSON.stringify((await h.text('average.py')).split('\n')[4]));
    await page.waitForTimeout(800);
    return stop;
  },
  // 4. The status panel while Ripple writes a long answer: tokens per second, cache, draft model.
  status: async (page, h, start) => {
    await h.open('hello.py');
    await page.locator('#ripple-status').click();
    await page.waitForSelector('#ripple-panel:not([hidden])');
    await page.waitForTimeout(1200);
    const panel = await page.locator('#ripple-panel').boundingBox();
    const chat = await page.locator('#ripple').boundingBox();
    const left = Math.max(0, Math.floor(Math.min(panel.x, chat.x) - 16));
    const stop = await start();
    await page.waitForTimeout(1500);
    await page.locator('#prompt').focus(); // a click outside the panel would close it
    await page.keyboard.type('Explain this file part by part, in about 800 words.', { delay: 28 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#send').textContent !== 'Send', null, { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('#send').textContent === 'Send', null, { timeout: 120000 });
    console.log('  panel:', (await page.locator('#ripple-panel').innerText()).replace(/\s+/g, ' ').slice(0, 260));
    await page.waitForTimeout(2500);
    stop.crop = { x: left, y: 0, width: VIEW.width - left, height: Math.ceil(panel.y + panel.height + 20) };
    return stop;
  },
};

try {
  for (const [name, scene] of Object.entries(SCENES)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    console.log(`scene: ${name}`);
    const frames = mkdtempSync(join(tmpdir(), `ripple-frames-${name}-`));
    const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2 });
    await context.addInitScript((sizes) => {
      for (const [variable, size] of Object.entries(sizes)) localStorage.setItem(`ripple-ide:size:${variable}`, size);
    }, PANES[name]);
    const page = await context.newPage();
    await page.goto(base);
    await page.waitForSelector('body[data-ready="1"]', { timeout: 20000 });
    await page.waitForTimeout(1500); // the first status check and the file tree
    const stop = await scene(page, helpers(page), () => record(page, frames));
    const shots = await stop();
    await context.close();
    const target = join(OUT, `${name}.gif`);
    const seconds = toGif(shots, frames, target, stop.crop);
    rmSync(frames, { recursive: true, force: true });
    console.log(`  recorded ${(shots.at(-1).at - shots[0].at).toFixed(1)} s, GIF ${seconds.toFixed(1)} s -> ${target}`);
  }
} catch (error) {
  console.error('FAIL', error.stack || error);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
  rmSync(workspace, { recursive: true, force: true });
}
