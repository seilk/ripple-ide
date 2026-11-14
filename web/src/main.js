// Ripple IDE: one editor, three modes. General is a plain IDE with Ripple.
// Kernel adds the PTX pane, live compile and the kernel report. Lab changes how
// the IDE talks to Ripple and measures what each change did.

import { createAgent } from './agent.js';
import { api, streamRun } from './api.js';
import { snapshot } from './baseline.js';
import { registerInlineSuggestions } from './complete.js';
import { createDiffEditor, createEditor, languageFor, loadMonaco } from './editor.js';
import { registerQuickFixes } from './fixes.js';
import { registerKernelLanguages } from './kernel-lang.js';
import { createLab } from './lab.js';
import { createInlineEdit } from './inline-edit.js';
import { createLinker } from './link.js';
import { createPalette } from './palette.js';
import { analyzePtx, basename } from './ptx-analyze.js';
import { renderReport } from './report.js';
import { setupDividers } from './resize.js';
import { createRippleStatus } from './status.js';
import { createRippleTools, editorState, systemPrompt } from './ripple-tools.js';
import { createTree } from './tree.js';
import { $, debounce, errorText, extOf, h, kernelKind, prefs } from './ui.js';

const LIVE_ANALYSIS_MS = 250;
const LIVE_COMPILE_MS = 600;
const MAX_FINDINGS_FOR_SUGGESTIONS = 8;
const MAX_OUTPUT_CHARS = 200_000;
const PREVIEW_DELAY_MS = 300;
const PREVIEW_PAGE = ['html', 'htm'];
const PREVIEW_PART = ['css', 'js', 'mjs', 'svg', 'json'];
const COMPILE_LABEL = { cuda: 'Compile to PTX', ptx: 'Check PTX', triton: 'Run for PTX' };
const PREF_KEY = { live: 'live', suggest: 'suggest', showDebugLines: 'debug-lines', autoApply: 'auto-apply' };
const MODES = { general: 'General', kernel: 'Kernel', lab: 'Ripple lab' };
const DEBUG_LINE_RE = /^\s*(?:\.loc\b|\$L__(?:tmp|func_begin|func_end)\d+:)/; // line info, not instructions
const QUICK_PROMPTS = {
  kernel: ['Why is this kernel slow', 'Explain the hot loop', 'Add a header comment'],
  general: ['Explain this file', 'Find bugs in this file', 'Add a header comment'],
};

const state = {
  /** @type {Array<{path: string, size: number}>} */ files: [],
  /** @type {Map<string, {model: any, savedVersion: number}>} */ open: new Map(),
  /** @type {string|null} */ active: null,
  /** @type {Map<string, {res: any, analysis: any, ptx: string, stale: boolean}>} */ results: new Map(),
  /** @type {Map<string, {at: Date, fns: Record<string, any>}>} */ baselines: new Map(),
  /** @type {Map<string, number>} */ compileSeq: new Map(),
  /** @type {any} */ toolchain: null,
  run: { enabled: false, /** @type {string[]} */ extensions: [] },
  /** @type {AbortController|null} */ running: null,
  /** @type {'general'|'kernel'|'lab'} */ mode: 'general',
  /** @type {'general'|'kernel'} */ modeBeforeLab: 'general',
  /** @type {string|null} the page shown in the preview pane */ previewPath: null,
  previewVersion: 0,
  live: prefs.get('live', 'on') === 'on',
  suggest: prefs.get('suggest', 'on') === 'on',
  autoApply: prefs.get('auto-apply', 'on') === 'on',
  /** @type {Map<string, {path: string, before: string, after: string, existed: boolean}>} changes Ripple applied without asking */ changes: new Map(),
  showDebugLines: prefs.get('debug-lines', 'off') === 'on',
};

const els = {
  toolchain: $('toolchain'), arch: /** @type {HTMLSelectElement} */ ($('arch')),
  flags: /** @type {HTMLInputElement} */ ($('flags')), primary: /** @type {HTMLButtonElement} */ ($('primary')),
  primaryLabel: $('primary-label'), preset: /** @type {HTMLSelectElement} */ ($('preset')), mode: $('mode'),
  root: $('root'), outline: $('outline'), outlineTitle: $('outline-title'),
  newFile: $('new-file'), newFileForm: /** @type {HTMLFormElement} */ ($('new-file-form')),
  newFilePath: /** @type {HTMLInputElement} */ ($('new-file-path')),
  tabs: $('tabs'), split: $('split'), welcome: $('welcome'),
  ptxMeta: $('ptx-meta'), ptxEmpty: $('ptx-empty'),
  output: $('output'), report: $('report'), log: $('log'),
  tabOutput: $('tab-output'), tabReport: $('tab-report'), tabLog: $('tab-log'), tabBench: $('tab-bench'),
  bench: $('bench'), status: $('status'),
  toggleLive: $('toggle-live'), toggleSuggest: $('toggle-suggest'), toggleDebug: $('toggle-debug'),
  suggestState: $('suggest-state'), cursor: $('cursor'), language: $('language'),
  diffDialog: /** @type {HTMLDialogElement} */ ($('diff-dialog')), diffPath: $('diff-path'),
  confirmDialog: /** @type {HTMLDialogElement} */ ($('confirm-dialog')),
};

let monaco; let srcEditor; let ptxEditor; let ptxModel; let linker; let diffEditor; let agent; let tree; let palette; let lab; let inlineEdit; let rippleStatus;

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.dataset.kind = kind;
}

/** What the file is: 'cuda', 'ptx', 'triton', or null for an ordinary file. */
function fileKind(path) {
  return kernelKind(path, state.open.get(path)?.model.getValue() ?? '');
}

/** The kernel kind the IDE acts on. Kernel tools are on in Kernel mode only. */
function kindOf(path) {
  return state.mode === 'kernel' ? fileKind(path) : null;
}

const canRun = (path) => state.run.enabled && state.run.extensions.includes(`.${extOf(path)}`);

// ------------------------------------------------------------------ files

/** Kernels of the active file, from the last analysis. */
function renderOutline(analysis, sourceName) {
  const functions = analysis?.functions || [];
  els.outlineTitle.hidden = functions.length === 0;
  els.outline.replaceChildren(...functions.map((fn) => {
    const findings = analysis.lints.filter((lint) => lint.fn === fn.name).length;
    const first = analysis.lineMap.find((entry) => entry.ptxLine >= fn.startLine && entry.ptxLine <= fn.endLine
      && basename(entry.file) === basename(sourceName));
    return h('li', {}, h('button', {
      class: 'file kernel', type: 'button', title: `${fn.name}: ${fn.instructions} instructions, ${findings} findings`,
      onclick: () => jump({ ptxLine: fn.startLine, srcLine: first?.srcLine ?? null, focusSource: Boolean(first) }),
    }, h('span', { class: 'ext' }, fn.kind === 'entry' ? 'krn' : 'fn'), h('span', { class: 'name' }, fn.pretty),
    h('span', { class: 'count' }, findings || '')));
  }));
}

function isDirty(path) {
  const entry = state.open.get(path);
  return Boolean(entry) && entry.model.getAlternativeVersionId() !== entry.savedVersion;
}

function renderTabs() {
  els.tabs.replaceChildren(...[...state.open.keys()].map((path) => h('button', {
    class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(path === state.active),
    'data-dirty': isDirty(path) || null, title: path, onclick: () => setActive(path),
  }, h('span', {}, path.split('/').pop()), h('span', { class: 'dirty', 'aria-label': isDirty(path) ? 'unsaved' : null }),
  h('span', { class: 'close', role: 'button', 'aria-label': `Close ${path}`, onclick: (event) => { event.stopPropagation(); closeFile(path); } }, '×'))));
}

async function refreshFiles() {
  const listing = await api.files();
  state.files = listing.files;
  state.run = listing.run;
  els.root.textContent = listing.root;
  tree.render(state.files);
  return state.files;
}

/** @type {Map<string, Promise<any>>} files that are being opened right now */
const opening = new Map();

/** The editor model of a file, loaded once even when two callers ask at the same time. */
function ensureOpen(path) {
  const existing = state.open.get(path);
  if (existing) return Promise.resolve(existing);
  if (!opening.has(path)) opening.set(path, loadFile(path).finally(() => opening.delete(path)));
  return opening.get(path);
}

async function loadFile(path) {
  const file = await api.read(path);
  const model = monaco.editor.createModel(file.content, languageFor(path), monaco.Uri.parse(`file:///${path}`));
  const entry = { model, savedVersion: model.getAlternativeVersionId() };
  model.onDidChangeContent(() => {
    renderTabs();
    if (path === state.active && previewFor(path)) refreshPreview();
    const kind = kindOf(path);
    if (kind === 'ptx' && path === state.active) livePtx();
    if (kind === 'cuda') liveCompile(path);
  });
  state.open.set(path, entry);
  return entry;
}

async function openFile(path, line) {
  await ensureOpen(path);
  setActive(path);
  if (line) { srcEditor.revealLineInCenter(line); srcEditor.setPosition({ lineNumber: line, column: 1 }); }
}

function closeFile(path, { force = false } = {}) {
  const entry = state.open.get(path);
  if (!entry) return;
  if (!force && isDirty(path) && !window.confirm(`${path} has unsaved changes. Close it anyway?`)) return;
  state.open.delete(path);
  state.results.delete(path);
  state.baselines.delete(path);
  if (state.active === path) {
    const next = [...state.open.keys()].pop() || null;
    if (next) setActive(next); else clearActive();
  } else renderTabs();
  entry.model.dispose();
}

function clearActive() {
  state.active = null;
  srcEditor.setModel(null);
  linker.clear();
  els.welcome.hidden = false;
  els.language.textContent = '';
  renderTabs();
  tree.refresh();
  updatePrimary();
  showResult();
}

async function save(path) {
  const entry = state.open.get(path);
  if (!entry) return false;
  try {
    await api.write(path, entry.model.getValue());
    entry.savedVersion = entry.model.getAlternativeVersionId();
    renderTabs();
    return true;
  } catch (error) {
    setStatus(`Save failed: ${errorText(error)}`, 'error');
    return false;
  }
}

async function saveActive() {
  if (state.active && await save(state.active)) setStatus(`Saved ${state.active}`, 'ok');
}

async function createFile(path) {
  const clean = path.trim().replace(/^\/+/, '');
  if (!clean) return;
  if (state.files.some((file) => file.path === clean)) { await openFile(clean); return; }
  await api.write(clean, '');
  await refreshFiles();
  await openFile(clean);
}

async function deleteFile(path) {
  if (!window.confirm(`Delete ${path}? This cannot be undone.`)) return;
  try {
    await api.remove(path);
    closeFile(path, { force: true });
    await refreshFiles();
    setStatus(`Deleted ${path}`, 'ok');
  } catch (error) {
    setStatus(errorText(error), 'error');
  }
}

async function deleteFolder(path, fileCount) {
  const unsaved = [...state.open.keys()].filter((file) => file.startsWith(`${path}/`) && isDirty(file)).length;
  const what = `${fileCount} ${fileCount === 1 ? 'file' : 'files'}${unsaved ? `, ${unsaved} with unsaved changes` : ''}`;
  if (!window.confirm(`Delete the folder ${path} and its ${what}? This cannot be undone.`)) return;
  try {
    await api.removeFolder(path);
    for (const file of [...state.open.keys()].filter((open) => open.startsWith(`${path}/`))) closeFile(file, { force: true });
    if (state.previewPath?.startsWith(`${path}/`)) state.previewPath = null;
    await refreshFiles();
    if (state.active) showResult();
    setStatus(`Deleted ${path} (${fileCount} ${fileCount === 1 ? 'file' : 'files'})`, 'ok');
  } catch (error) {
    setStatus(errorText(error), 'error');
  }
}

function setActive(path) {
  state.active = path;
  setStatus('');
  linker.clear();
  const model = state.open.get(path).model;
  srcEditor.setModel(model);
  els.welcome.hidden = true;
  prefs.set('active', path);
  const kind = kindOf(path);
  const language = monaco.languages.getLanguages().find((item) => item.id === model.getLanguageId());
  els.language.textContent = fileKind(path) === 'triton' ? 'Triton' : language?.aliases?.[0] || model.getLanguageId();
  agent.setQuick(kind ? QUICK_PROMPTS.kernel : QUICK_PROMPTS.general);
  renderTabs();
  tree.refresh();
  updatePrimary();
  showResult();
  selectDock(state.mode === 'lab' ? 'bench' : kind ? 'report' : 'output');
  srcEditor.focus();
  if (kind === 'cuda' && !state.results.has(path)) liveCompile(path); // show PTX as soon as a kernel opens
  if (state.mode === 'general' && fileKind(path)) setStatus('Kernel file. Kernel mode adds the PTX pane and the report (Cmd/Ctrl+Shift+P)');
}

/** Change what the IDE is made of. The open files stay. */
function setMode(mode) {
  if (mode === 'lab' && state.mode !== 'lab') state.modeBeforeLab = state.mode; // where the lab's close button goes back to
  state.mode = mode;
  prefs.set('mode', mode);
  document.body.dataset.mode = mode;
  els.mode.textContent = MODES[mode];
  if (state.active) setActive(state.active);
  else { showResult(); selectDock(mode === 'lab' ? 'bench' : 'output'); updatePrimary(); }
}

// ------------------------------------------------------------------ primary action: run or compile

/** What the main button does for the active file. */
function primaryAction() {
  const path = state.active;
  if (state.running) return { type: 'stop', label: 'Stop', reason: '' };
  if (!path) return { type: 'none', label: 'Run', reason: 'Open a file first' };
  const kind = kindOf(path);
  const tc = state.toolchain;
  if (kind === 'cuda' && tc && !tc.cuda_frontend) return { type: 'none', label: COMPILE_LABEL.cuda, reason: 'No nvcc and no clang with the NVPTX target on the runner' };
  if (kind === 'triton' && tc && !tc.triton) {
    return canRun(path) ? { type: 'run', label: 'Run', reason: '' }
      : { type: 'none', label: COMPILE_LABEL.triton, reason: 'Triton is not installed on the runner' };
  }
  if (kind) return { type: 'compile', label: COMPILE_LABEL[kind], reason: '' };
  if (canRun(path)) return { type: 'run', label: 'Run', reason: '' };
  return {
    type: 'none', label: 'Run',
    reason: state.run.enabled ? `No interpreter for .${extOf(path)} files` : 'Running files is off on this server (--allow-run)',
  };
}

function updatePrimary() {
  const action = primaryAction();
  els.primaryLabel.textContent = action.label;
  els.primary.disabled = action.type === 'none';
  els.primary.title = action.reason || `${action.label} (Cmd/Ctrl+Enter)`;
}

function doPrimary() {
  const action = primaryAction();
  if (action.type === 'stop') state.running.abort();
  else if (action.type === 'compile') compileActive();
  else if (action.type === 'run') runFile(state.active).catch((error) => setStatus(errorText(error), 'error'));
}

function appendOutput(text, meta = null) {
  const node = meta ? h('span', { class: 'run-meta', 'data-failed': meta === 'failed' }, text) : document.createTextNode(text);
  els.output.append(node);
  if (els.output.textContent.length > MAX_OUTPUT_CHARS) els.output.firstChild?.remove();
  els.output.scrollTop = els.output.scrollHeight;
}

/** Save the file, run it on the server and stream its output to the Output tab. */
async function runFile(path) {
  if (state.running) throw new Error('Another run is in progress');
  await ensureOpen(path);
  if (isDirty(path) && !(await save(path))) throw new Error('Could not save before the run');
  selectDock('output');
  els.output.replaceChildren();
  state.running = new AbortController();
  updatePrimary();
  setStatus(`Running ${path}`);
  let output = '';
  let exit = { code: -1, seconds: 0, note: 'stopped', command: path };
  try {
    await streamRun(path, (event) => {
      if (event.type === 'out') { output += event.text; appendOutput(event.text); }
      if (event.type === 'exit') exit = event;
    }, state.running.signal);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) { state.running = null; updatePrimary(); throw error; }
  }
  state.running = null;
  updatePrimary();
  const failed = exit.code !== 0;
  appendOutput(`\n${exit.command}: exit ${exit.code} in ${exit.seconds.toFixed(2)} s${exit.note ? ` (${exit.note})` : ''}\n`, failed ? 'failed' : 'ok');
  setStatus(failed ? `Exit ${exit.code}` : `Ran in ${exit.seconds.toFixed(2)} s`, failed ? 'error' : 'ok');
  return { code: exit.code, output, seconds: exit.seconds };
}

// ------------------------------------------------------------------ kernel results

function showLog(res) {
  els.log.textContent = res
    ? [`# frontend (${res.backend}) exit ${res.frontend.rc ?? 'n/a'}`, res.frontend.log || '(no output)',
      `\n# ptxas ${res.ptxas.available ? `exit ${res.ptxas.rc}` : 'not available'}`, res.ptxas.log || ''].join('\n')
    : '';
}

function jump({ ptxLine, srcLine, focusSource = false }) {
  const ptxInSource = state.active && kindOf(state.active) === 'ptx';
  if (ptxLine && ptxInSource) {
    srcEditor.revealLineInCenter(ptxLine);
    srcEditor.setPosition({ lineNumber: ptxLine, column: 1 });
    srcEditor.focus();
    return;
  }
  if (ptxLine) {
    ptxEditor.revealLineInCenter(ptxLine);
    ptxEditor.setPosition({ lineNumber: ptxLine, column: 1 });
    linker.showFromPtx(ptxLine);
  }
  const line = srcLine ?? (ptxLine ? linker.sourceLineOf(ptxLine) : null);
  if (line) {
    srcEditor.revealLineInCenter(line);
    if (!ptxLine || focusSource) { srcEditor.setPosition({ lineNumber: line, column: 1 }); srcEditor.focus(); }
  }
}

/**
 * The page to preview while `path` is open: the file itself when it is HTML, or the
 * page already in the preview when `path` is a stylesheet or script next to it.
 */
function previewFor(path) {
  const ext = extOf(path);
  if (PREVIEW_PAGE.includes(ext)) return path;
  const folder = (file) => file.split('/').slice(0, -1).join('/');
  if (state.previewPath && PREVIEW_PART.includes(ext) && folder(path).startsWith(folder(state.previewPath))) return state.previewPath;
  return null;
}

function showPreview() {
  state.previewVersion += 1;
  $('preview-path').textContent = state.previewPath;
  /** @type {HTMLIFrameElement} */ ($('preview-frame')).src = `/preview/${state.previewPath.split('/').map(encodeURIComponent).join('/')}?v=${state.previewVersion}`;
}

/** Send the unsaved text of the active file, then load the page again. */
const refreshPreview = debounce(async () => {
  const path = state.active;
  const entry = path && state.open.get(path);
  if (!entry || !state.previewPath) return;
  try {
    await api.previewDraft(path, isDirty(path) ? entry.model.getValue() : null);
    showPreview();
  } catch (error) {
    setStatus(errorText(error), 'error');
  }
}, PREVIEW_DELAY_MS);

/** Fold the line-info lines away, so the listing shows instructions. Line numbers stay true. */
function applyDebugLineFilter() {
  if (typeof ptxEditor.setHiddenAreas !== 'function') return;
  const ranges = [];
  if (!state.showDebugLines) {
    const count = ptxModel.getLineCount();
    for (let line = 1; line <= count; line += 1) {
      if (!DEBUG_LINE_RE.test(ptxModel.getLineContent(line))) continue;
      const last = ranges[ranges.length - 1];
      if (last && last.end === line - 1) last.end = line;
      else ranges.push({ start: line, end: line });
    }
  }
  ptxEditor.setHiddenAreas(ranges.map((r) => new monaco.Range(r.start, 1, r.end, 1)));
}

function setBaseline(path) {
  const stored = state.results.get(path);
  if (!stored?.analysis || stored.stale) return;
  state.baselines.set(path, { at: new Date(), fns: snapshot(stored.analysis, stored.res.ptxas.functions) });
}

/** Show what is known about the active file. Ordinary files have no PTX pane and no report. */
function showResult() {
  const path = state.active;
  const kind = path ? kindOf(path) : null;
  const stored = path ? state.results.get(path) : null;
  const res = stored?.res ?? null;
  const page = path ? previewFor(path) : null;
  if (page && page !== state.previewPath) { state.previewPath = page; showPreview(); }
  const second = state.mode === 'lab' ? 'lab' : kind === 'cuda' || kind === 'triton' ? 'ptx' : page ? 'preview' : null;
  if (second) els.split.dataset.second = second; else delete els.split.dataset.second;
  const report = (analysis) => renderReport(els.report, {
    analysis, res, sourceName: path || '', onJump: jump, stale: stored?.stale ?? false,
    baseline: path && kind !== 'ptx' ? state.baselines.get(path) ?? null : null,
    onSetBaseline: () => { setBaseline(path); showResult(); },
  });

  if (kind === null) { renderOutline(null, ''); report(null); showLog(null); return; }
  if (kind === 'ptx') {
    const analysis = analyzePtx(state.open.get(path).model.getValue());
    linker.decorateSourceAsPtx(analysis);
    renderOutline(analysis, path);
    report(analysis);
    showLog(res);
    return;
  }
  const ptx = stored?.ptx || '';
  if (ptxModel.getValue() !== ptx) ptxModel.setValue(ptx);
  applyDebugLineFilter();
  els.ptxEmpty.hidden = Boolean(ptx);
  const instructions = stored?.analysis ? stored.analysis.functions.reduce((n, fn) => n + fn.instructions, 0) : 0;
  els.ptxMeta.textContent = stored?.analysis
    ? `${stored.analysis.target || ''}, ${instructions} instructions, ${stored.stale ? 'last good compile' : res.backend}` : '';
  if (stored?.analysis && !stored.stale) linker.linkCompiled(stored.analysis, path);
  else linker.clear();
  if (res) linker.showDiagnostics(res.diagnostics, path);
  renderOutline(stored?.analysis ?? null, path);
  report(stored?.analysis ?? null);
  showLog(res);
}

const livePtx = debounce(() => { if (state.active && kindOf(state.active) === 'ptx') showResult(); }, LIVE_ANALYSIS_MS);

async function compile(path, { allowRun = false } = {}) {
  const entry = await ensureOpen(path);
  const seq = (state.compileSeq.get(path) || 0) + 1;
  state.compileSeq.set(path, seq);
  const res = await api.compile({
    path, content: entry.model.getValue(), arch: els.arch.value, flags: els.flags.value.trim(), allow_run: allowRun,
  });
  const isPtx = fileKind(path) === 'ptx'; // Ripple may compile a kernel in any mode
  const text = isPtx ? entry.model.getValue() : res.ptx;
  const previous = state.results.get(path);
  const result = !isPtx && !res.ok && previous?.ptx
    ? { res, analysis: previous.analysis, ptx: previous.ptx, stale: true } // keep the last good listing on screen
    : { res, analysis: text ? analyzePtx(text) : null, ptx: text || '', stale: false };
  if (state.compileSeq.get(path) !== seq) return result; // a newer compile of this file is on its way
  state.results.set(path, result);
  if (res.ok && result.analysis && !isPtx && !state.baselines.has(path)) setBaseline(path);
  if (path === state.active) showResult();
  return result;
}

function reportStatus(path, { res, analysis, stale }, prefix = '') {
  if (path !== state.active) return;
  if (!res.ok || stale) { setStatus(`${prefix}Compile failed`, 'error'); return; }
  setStatus(`${prefix}${analysis ? analysis.lints.length : 0} findings, ${res.seconds.toFixed(2)} s`, 'ok');
}

async function compileActive() {
  const path = state.active;
  if (!path) return;
  els.primary.disabled = true;
  setStatus(`Compiling ${path}`);
  try {
    const result = await compile(path, { allowRun: true });
    reportStatus(path, result);
    selectDock(!result.res.ok && !result.res.diagnostics.length ? 'log' : 'report');
  } catch (error) {
    setStatus(errorText(error), 'error');
  } finally {
    updatePrimary();
  }
}

const liveTimers = new Map();
/** Compile a CUDA file a moment after the last keystroke. */
function liveCompile(path) {
  clearTimeout(liveTimers.get(path));
  if (!state.live || !state.toolchain?.cuda_frontend) return;
  liveTimers.set(path, setTimeout(() => {
    compile(path).then((result) => reportStatus(path, result, 'Live: '))
      .catch((error) => setStatus(errorText(error), 'error'));
  }, LIVE_COMPILE_MS));
}

function selectDock(which) {
  for (const [name, tab, panel] of [['output', els.tabOutput, els.output], ['report', els.tabReport, els.report],
    ['log', els.tabLog, els.log], ['bench', els.tabBench, els.bench]]) {
    tab.setAttribute('aria-selected', String(name === which));
    panel.hidden = name !== which;
  }
}

// ------------------------------------------------------------------ toolchain, presets, toggles

async function refreshToolchain(refresh = false) {
  els.toolchain.textContent = 'Checking toolchain';
  try {
    const tc = await api.toolchain(refresh);
    state.toolchain = tc;
    const front = tc.cuda_frontend === 'nvcc' ? `nvcc ${(tc.nvcc_version || '').replace('release ', '')}`.trim()
      : tc.cuda_frontend === 'clang-nvptx' ? 'clang NVPTX preview' : 'no CUDA frontend';
    els.toolchain.textContent = [front, tc.ptxas ? 'ptxas' : 'no ptxas', tc.triton ? `triton ${tc.triton}` : null,
      tc.gpu, tc.runner].filter(Boolean).join(', ');
    els.toolchain.dataset.state = tc.cuda_frontend === 'nvcc' && tc.ptxas ? 'full' : tc.cuda_frontend ? 'preview' : 'none';
    els.toolchain.title = tc.error ? `Toolchain check failed: ${tc.error}` : 'Check the toolchain again';
  } catch (error) {
    els.toolchain.textContent = errorText(error);
    els.toolchain.dataset.state = 'none';
  }
  updatePrimary();
}

/** Every preset becomes a lab profile; the top-bar list picks the Ripple the IDE uses. */
async function loadLab() {
  const { presets, default: fallback, custom_endpoints: customEndpoints } = await api.presets();
  lab = createLab({
    pane: $('lab-pane'), benchPanel: els.bench, select: els.preset, presets, defaultPreset: fallback,
    customEndpoints, onStatus: setStatus,
    onClose: () => setMode(state.modeBeforeLab),
  });
}

/** @param {HTMLElement} button @param {'live'|'suggest'|'showDebugLines'|'autoApply'} key @param {() => void} onChange */
function bindToggle(button, key, onChange) {
  const paint = () => button.setAttribute('aria-pressed', String(state[key]));
  button.addEventListener('click', () => {
    state[key] = !state[key];
    prefs.set(PREF_KEY[key], state[key] ? 'on' : 'off');
    paint();
    onChange();
  });
  paint();
}

function showSuggestState({ phase, source, ms, message }) {
  const from = source === 'ripple' ? `Ripple, ${ms} ms` : source === 'kept' ? 'kept while typing' : 'idioms';
  if (phase === 'shown' && source !== 'kept') lab.noteSuggestion(ms);
  els.suggestState.textContent = phase === 'asking' ? 'Suggesting'
    : phase === 'shown' ? `Tab accepts (${from})`
      : phase === 'error' ? `Suggestion failed: ${message}` : '';
  els.suggestState.dataset.kind = phase === 'error' ? 'error' : '';
}

// ------------------------------------------------------------------ dialogs and Ripple

/**
 * Show a diff and wait for the answer. By default it asks before a change; with `labels`
 * it shows a change that is already applied, to keep or to undo.
 */
function askForWrite(path, before, after, labels = { title: 'Review change', accept: 'Apply', reject: 'Reject' }) {
  return new Promise((resolve) => {
    const original = monaco.editor.createModel(before, languageFor(path));
    const modified = monaco.editor.createModel(after, languageFor(path));
    els.diffPath.textContent = path;
    $('diff-title').textContent = labels.title;
    $('diff-accept').textContent = labels.accept;
    $('diff-reject').textContent = labels.reject;
    diffEditor.setModel({ original, modified });
    const finish = (accepted) => {
      els.diffDialog.close();
      diffEditor.setModel(null);
      original.dispose(); modified.dispose();
      $('diff-accept').onclick = null; $('diff-reject').onclick = null; els.diffDialog.oncancel = null;
      resolve(accepted);
    };
    $('diff-accept').onclick = () => finish(true);
    $('diff-reject').onclick = () => finish(false);
    els.diffDialog.oncancel = (event) => { event.preventDefault(); finish(false); };
    els.diffDialog.showModal();
  });
}

function askConfirm(title, detail) {
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-detail').textContent = detail;
    const finish = (answer) => {
      els.confirmDialog.close();
      $('confirm-yes').onclick = null; $('confirm-no').onclick = null; els.confirmDialog.oncancel = null;
      resolve(answer);
    };
    $('confirm-yes').onclick = () => finish(true);
    $('confirm-no').onclick = () => finish(false);
    els.confirmDialog.oncancel = (event) => { event.preventDefault(); finish(false); };
    els.confirmDialog.showModal();
  });
}

async function applyWrite(path, content) {
  const known = state.files.some((file) => file.path === path);
  await api.write(path, content);
  if (!known) await refreshFiles();
  const entry = await ensureOpen(path);
  if (entry.model.getValue() !== content) {
    entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text: content }], () => null);
  }
  entry.savedVersion = entry.model.getAlternativeVersionId();
  setActive(path);
  if (kindOf(path) === 'cuda' && !state.live) compile(path).catch((error) => setStatus(errorText(error), 'error'));
}

/** Show a change that Ripple applied without asking. Undo puts the old text back, or removes a new file. */
async function reviewChange(id, row) {
  const change = state.changes.get(id);
  if (!change) return;
  const keep = await askForWrite(change.path, change.before, change.after,
    { title: change.existed ? 'Applied change' : 'New file', accept: 'Keep', reject: change.existed ? 'Undo' : 'Delete file' });
  if (keep) return;
  try {
    if (change.existed) await applyWrite(change.path, change.before);
    else { await api.remove(change.path); closeFile(change.path, { force: true }); await refreshFiles(); }
    state.changes.delete(id);
    row.dataset.state = 'undone';
    row.querySelector('.state').textContent = 'Undone';
    row.querySelector('.quiet')?.remove();
    setStatus(`Undid the change to ${change.path}`, 'ok');
  } catch (error) {
    setStatus(errorText(error), 'error');
  }
}

function askAboutSelection() {
  const model = srcEditor.getModel();
  const selection = srcEditor.getSelection();
  if (!model || !selection || !state.active) return;
  const range = selection.isEmpty()
    ? new monaco.Range(selection.startLineNumber, 1, selection.startLineNumber, model.getLineMaxColumn(selection.startLineNumber))
    : selection;
  const lines = range.startLineNumber === range.endLineNumber ? `line ${range.startLineNumber}`
    : `lines ${range.startLineNumber} to ${range.endLineNumber}`;
  agent.prefill(`About ${lines} of ${state.active}:\n${model.getValueInRange(range).trim()}\n\n`);
}

// ------------------------------------------------------------------ boot

function setupEditors() {
  srcEditor = createEditor(monaco, $('src-editor'));
  ptxModel = monaco.editor.createModel('', 'ptx');
  ptxEditor = createEditor(monaco, $('ptx-editor'), { model: ptxModel, readOnly: true, lineNumbersMinChars: 4 });
  diffEditor = createDiffEditor(monaco, $('diff-editor'));
  linker = createLinker({ monaco, srcEditor, ptxEditor });

  const mod = monaco.KeyMod.CtrlCmd;
  srcEditor.addCommand(mod | monaco.KeyCode.KeyS, saveActive);
  for (const editor of [srcEditor, ptxEditor]) {
    editor.addAction({
      id: 'ide.primary', label: 'Run or compile the active file', contextMenuGroupId: 'ide', contextMenuOrder: 1,
      keybindings: [mod | monaco.KeyCode.Enter], run: doPrimary,
    });
    editor.addCommand(mod | monaco.KeyCode.KeyP, () => palette.open('files'));
    editor.addCommand(mod | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => palette.open('text'));
    editor.addCommand(mod | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => palette.open('commands'));
  }
  srcEditor.addAction({
    id: 'ripple.ask', label: 'Ripple: Ask about selection', contextMenuGroupId: 'ide', contextMenuOrder: 2,
    keybindings: [mod | monaco.KeyCode.KeyL], run: askAboutSelection,
  });
  srcEditor.onDidChangeCursorPosition((event) => {
    els.cursor.textContent = `Ln ${event.position.lineNumber}, Col ${event.position.column}`;
  });
}

function setupChrome() {
  tree = createTree({
    list: $('file-list'), getActive: () => state.active,
    onOpen: (path) => openFile(path).catch((error) => setStatus(errorText(error), 'error')),
    onDelete: deleteFile,
    onDeleteFolder: deleteFolder,
  });
  const open = (path, line) => openFile(path, line).catch((error) => setStatus(errorText(error), 'error'));
  palette = createPalette({
    dialog: /** @type {HTMLDialogElement} */ ($('palette')), input: /** @type {HTMLInputElement} */ ($('palette-input')),
    list: $('palette-list'),
    getFiles: () => state.files.map((file) => ({ label: file.path, run: () => open(file.path) })),
    getCommands: commands,
    search: async (query) => (await api.search(query)).hits
      .map((hit) => ({ label: `${hit.path}:${hit.line}`, detail: hit.text, run: () => open(hit.path, hit.line) })),
  });
  $('open-palette').addEventListener('click', () => palette.open('files'));
  els.mode.addEventListener('click', () => palette.open('commands', 'Mode: '));
  window.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (key === 'p') { event.preventDefault(); palette.open(event.shiftKey ? 'commands' : 'files'); }
    if (key === 'f' && event.shiftKey) { event.preventDefault(); palette.open('text'); }
  });

  els.newFile.addEventListener('click', () => { els.newFileForm.hidden = false; els.newFilePath.value = ''; els.newFilePath.focus(); });
  els.newFilePath.addEventListener('keydown', (event) => { if (event.key === 'Escape') els.newFileForm.hidden = true; });
  els.newFileForm.addEventListener('submit', (event) => {
    event.preventDefault();
    els.newFileForm.hidden = true;
    createFile(els.newFilePath.value).catch((error) => setStatus(errorText(error), 'error'));
  });

  els.primary.addEventListener('click', doPrimary);
  els.toolchain.addEventListener('click', () => refreshToolchain(true));
  els.tabOutput.addEventListener('click', () => selectDock('output'));
  els.tabReport.addEventListener('click', () => selectDock('report'));
  els.tabLog.addEventListener('click', () => selectDock('log'));
  els.tabBench.addEventListener('click', () => selectDock('bench'));
  els.arch.value = prefs.get('arch', els.arch.value);
  els.flags.value = prefs.get('flags', '');
  const rebuild = () => { if (state.active && kindOf(state.active) === 'cuda') liveCompile(state.active); };
  els.arch.addEventListener('change', () => { prefs.set('arch', els.arch.value); rebuild(); });
  els.flags.addEventListener('change', () => { prefs.set('flags', els.flags.value); rebuild(); });
  bindToggle(els.toggleLive, 'live', rebuild);
  bindToggle(els.toggleSuggest, 'suggest', () => showSuggestState({ phase: 'idle' }));
  bindToggle(els.toggleDebug, 'showDebugLines', applyDebugLineFilter);
  bindToggle($('toggle-auto'), 'autoApply', () => {});

  const width = (id) => $(id).getBoundingClientRect().width;
  const height = (id) => $(id).getBoundingClientRect().height;
  setupDividers([
    { id: 'divide-files', variable: '--files-w', axis: 'x', direction: 1, min: 160, max: () => 480, measure: () => width('files') },
    { id: 'divide-ripple', variable: '--ripple-w', axis: 'x', direction: -1, min: 264, max: () => window.innerWidth * 0.5, measure: () => width('ripple') },
    { id: 'divide-split', variable: '--src-w', axis: 'x', direction: 1, min: 160, max: () => width('split') - 160, measure: () => width('src-pane') },
    { id: 'divide-dock', variable: '--dock-h', axis: 'y', direction: -1, min: 96, max: () => height('stage') - 160, measure: () => height('dock') },
  ]);

  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason?.name === 'Canceled') event.preventDefault(); // Monaco cancels pending work when its models go away
  });
  window.addEventListener('beforeunload', (event) => {
    if ([...state.open.keys()].some(isDirty)) event.preventDefault();
  });
}

function setupRipple() {
  const tools = createRippleTools({
    listFiles: refreshFiles,
    readText: async (path) => { const entry = await ensureOpen(path); renderTabs(); return entry.model.getValue(); },
    kernelKindOf: fileKind,
    search: async (query) => (await api.search(query)).hits,
    confirmRun: (path) => askConfirm('Ripple wants to run a file', path),
    run: runFile,
    compile,
    baselineOf: (path) => state.baselines.get(path),
    autoApply: () => state.autoApply,
    confirmWrite: askForWrite,
    applyWrite,
    recordChange: (change) => { const id = `ch${state.changes.size + 1}-${Date.now().toString(36)}`; state.changes.set(id, change); return id; },
  });
  agent = createAgent({
    els: {
      chat: $('chat'), form: /** @type {HTMLFormElement} */ ($('composer')),
      prompt: /** @type {HTMLTextAreaElement} */ ($('prompt')), send: /** @type {HTMLButtonElement} */ ($('send')),
      quick: $('quick'), ctx: $('ctx'), perf: $('perf'),
      chatSelect: /** @type {HTMLSelectElement} */ ($('chat-select')), chatNew: $('chat-new'), chatDelete: $('chat-delete'),
    },
    getRequest: () => ({ target: lab.target(), options: lab.chatOptions() }),
    onPerf: (perf) => lab.noteChat(perf),
    onReview: reviewChange,
    systemPrompt: () => [systemPrompt({ canRun: state.run.enabled, autoApply: state.autoApply }), lab.chatInstruction()]
      .filter(Boolean).join('\n'),
    editorState: () => editorState({
      active: state.active, kernel: state.active ? kindOf(state.active) : null,
      toolchain: state.toolchain, arch: els.arch.value,
    }),
    tools,
  });
  agent.setQuick(QUICK_PROMPTS.general);
  inlineEdit = createInlineEdit({
    monaco, editor: srcEditor, bar: /** @type {HTMLFormElement} */ ($('edit-bar')),
    input: /** @type {HTMLInputElement} */ ($('edit-input')),
    getRequest: () => ({ target: lab.target(), options: lab.chatOptions() }),
    getFile: () => (state.active ? {
      path: state.active,
      language: fileKind(state.active) === 'triton' ? 'triton' : state.open.get(state.active).model.getLanguageId(),
    } : null),
    onStatus: setStatus,
  });
  srcEditor.addAction({
    id: 'ripple.edit', label: 'Ripple: Edit the selection', contextMenuGroupId: 'ide', contextMenuOrder: 3,
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK], run: () => inlineEdit.open(),
  });
  registerQuickFixes({ monaco, askRipple: (prompt) => agent.send(prompt) });
  const pathOf = (model) => model.uri.path.replace(/^\//, '');
  registerInlineSuggestions({
    monaco,
    getRequest: () => ({ target: lab.target(), options: lab.completeOptions(), debounceMs: lab.debounceMs() }),
    onAccepted: () => lab.noteAccepted(),
    isEnabled: () => state.suggest,
    onState: showSuggestState,
    getLanguage: (model) => (fileKind(pathOf(model)) === 'triton' ? 'triton' : model.getLanguageId()),
    getFindings: (model) => (state.results.get(pathOf(model))?.analysis?.lints || [])
      .filter((lint) => lint.src).slice(0, MAX_FINDINGS_FOR_SUGGESTIONS)
      .map((lint) => `${lint.code} at source line ${lint.src.line}`),
  });
}

/** Commands for Cmd/Ctrl+Shift+P. The first three change the mode. */
function commands() {
  const toggle = (button) => () => button.click();
  return [
    ...Object.entries(MODES).map(([id, name]) => ({
      label: `Mode: ${name}`, detail: state.mode === id ? 'current' : MODE_DETAIL[id], run: () => setMode(id),
    })),
    { label: 'Go to file', hint: '⌘P', run: () => palette.open('files') },
    { label: 'Search in files', hint: '⇧⌘F', run: () => palette.open('text') },
    { label: 'New file', run: () => els.newFile.click() },
    { label: 'Save file', hint: '⌘S', run: saveActive },
    { label: 'Run or compile the active file', hint: '⌘↵', run: doPrimary },
    { label: 'Ripple: Edit the selection', hint: '⌘K', run: () => inlineEdit.open() },
    { label: 'Ripple: Ask about selection', hint: '⌘L', run: askAboutSelection },
    { label: 'Ripple: New chat', run: () => agent.newChat() },
    { label: 'Ripple: Show server status', run: () => $('ripple-status').click() },
    { label: `Inline suggestions: turn ${state.suggest ? 'off' : 'on'}`, run: toggle(els.toggleSuggest) },
    { label: 'Lab: Run benchmark', detail: 'speed and accuracy of the active profile', run: () => { setMode('lab'); lab.runBenchmark(); } },
    { label: `Kernel: Live compile: turn ${state.live ? 'off' : 'on'}`, run: toggle(els.toggleLive) },
    { label: `Kernel: ${state.showDebugLines ? 'Hide' : 'Show'} PTX line info`, run: toggle(els.toggleDebug) },
    { label: 'Kernel: Set baseline here', run: () => { if (state.active) { setBaseline(state.active); showResult(); } } },
    { label: 'Kernel: Check toolchain', run: () => refreshToolchain(true) },
  ];
}

const MODE_DETAIL = {
  general: 'editor, run, search, Ripple',
  kernel: 'adds PTX pane, live compile, kernel report',
  lab: 'tune Ripple and benchmark it',
};

async function boot() {
  monaco = await loadMonaco();
  await registerKernelLanguages(monaco);
  setupEditors();
  setupChrome();
  await loadLab();
  setupRipple();
  renderReport(els.report, { analysis: null, res: null, sourceName: '', onJump: jump });
  await Promise.all([refreshFiles(), refreshToolchain()]);
  const mode = prefs.get('mode', 'general');
  setMode(mode in MODES ? mode : 'general');
  rippleStatus = createRippleStatus({
    button: $('ripple-status'), panel: $('ripple-panel'), getTarget: () => lab.target(), getSession: () => lab.sessionLine(),
    onChange: (ok, detail, first) => {
      if (!ok) setStatus(`Ripple does not answer: ${detail}`, 'error');
      else if (!first) setStatus('Ripple answers again', 'ok');
    },
  });
  els.preset.addEventListener('change', () => rippleStatus.refresh());
  $('preview-reload').addEventListener('click', () => { if (state.previewPath) showPreview(); });
  updatePrimary();
  const remembered = prefs.get('active', '');
  const first = state.files.find((f) => f.path === remembered) || state.files.find((f) => /readme/i.test(f.path)) || state.files[0];
  if (first) await openFile(first.path);
  document.body.dataset.ready = '1';
}

boot().catch((error) => {
  setStatus(errorText(error), 'error');
  document.body.dataset.ready = 'error';
});
