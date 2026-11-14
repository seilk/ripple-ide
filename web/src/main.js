// Ripple Kernel IDE: wires the workspace, the editors, the compile action,
// the kernel report and the Ripple panel together.

import { createAgent } from './agent.js';
import { api } from './api.js';
import { createDiffEditor, createEditor, languageFor, loadMonaco } from './editor.js';
import { createLinker } from './link.js';
import { analyzePtx, summarize } from './ptx-analyze.js';
import { renderReport } from './report.js';
import { $, debounce, errorText, h, kindOf, prefs } from './ui.js';

const LIVE_ANALYSIS_MS = 250;
const MAX_DIAGNOSTICS_FOR_MODEL = 20;
const COMPILE_LABEL = { cuda: 'Compile to PTX', ptx: 'Check PTX', triton: 'Run for PTX', text: 'Compile to PTX' };
const EXT_LABEL = { cuda: 'cu', ptx: 'ptx', triton: 'py', text: '' };

const state = {
  /** @type {Array<{path: string, size: number}>} */ files: [],
  /** @type {Map<string, {model: any, savedVersion: number}>} */ open: new Map(),
  /** @type {string|null} */ active: null,
  /** @type {Map<string, {res: any, analysis: any}>} */ results: new Map(),
  /** @type {any} */ toolchain: null,
};

const els = {
  toolchain: $('toolchain'), arch: /** @type {HTMLSelectElement} */ ($('arch')),
  flags: /** @type {HTMLInputElement} */ ($('flags')), compile: /** @type {HTMLButtonElement} */ ($('compile')),
  compileLabel: $('compile-label'), preset: /** @type {HTMLSelectElement} */ ($('preset')),
  root: $('root'), fileList: $('file-list'), tabs: $('tabs'), split: $('split'),
  ptxMeta: $('ptx-meta'), ptxEmpty: $('ptx-empty'), report: $('report'), log: $('log'),
  tabReport: $('tab-report'), tabLog: $('tab-log'), status: $('status'),
  diffDialog: /** @type {HTMLDialogElement} */ ($('diff-dialog')), diffPath: $('diff-path'),
};

let monaco; let srcEditor; let ptxEditor; let ptxModel; let linker; let diffEditor;

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.dataset.kind = kind;
}

// ------------------------------------------------------------------ workspace

function renderFiles() {
  els.fileList.replaceChildren(...state.files.map((file) => {
    const kind = kindOf(file.path);
    return h('li', {}, h('button', {
      class: 'file', type: 'button', title: file.path, 'aria-current': file.path === state.active ? 'true' : null,
      onclick: () => openFile(file.path).catch((error) => setStatus(errorText(error), 'error')),
    }, h('span', { class: 'ext' }, EXT_LABEL[kind]),
    h('span', { class: 'name' }, file.path)));
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
  els.root.textContent = listing.root;
  renderFiles();
}

async function ensureOpen(path) {
  const existing = state.open.get(path);
  if (existing) return existing;
  const file = await api.read(path);
  const model = monaco.editor.createModel(file.content, languageFor(path), monaco.Uri.parse(`file:///${path}`));
  const entry = { model, savedVersion: model.getAlternativeVersionId() };
  model.onDidChangeContent(() => { renderTabs(); if (path === state.active && kindOf(path) === 'ptx') livePtx(); });
  state.open.set(path, entry);
  return entry;
}

async function openFile(path) {
  await ensureOpen(path);
  setActive(path);
}

function closeFile(path) {
  const entry = state.open.get(path);
  if (!entry) return;
  if (isDirty(path) && !window.confirm(`${path} has unsaved changes. Close it anyway?`)) return;
  state.open.delete(path);
  state.results.delete(path);
  if (state.active === path) {
    const next = [...state.open.keys()].pop() || null;
    if (next) setActive(next); else { state.active = null; srcEditor.setModel(null); linker.clear(); renderTabs(); renderFiles(); showResult(); }
  } else renderTabs();
  entry.model.dispose();
}

async function saveActive() {
  const path = state.active;
  const entry = path && state.open.get(path);
  if (!entry) return;
  try {
    await api.write(path, entry.model.getValue());
    entry.savedVersion = entry.model.getAlternativeVersionId();
    renderTabs();
    setStatus(`Saved ${path}`, 'ok');
  } catch (error) {
    setStatus(`Save failed: ${errorText(error)}`, 'error');
  }
}

function setActive(path) {
  state.active = path;
  setStatus('');
  linker.clear();
  srcEditor.setModel(state.open.get(path).model);
  prefs.set('active', path);
  renderTabs();
  renderFiles();
  updateCompileButton();
  showResult();
  srcEditor.focus();
}

// ------------------------------------------------------------------ results

function updateCompileButton() {
  const kind = state.active ? kindOf(state.active) : 'text';
  const tc = state.toolchain;
  els.compileLabel.textContent = COMPILE_LABEL[kind];
  let reason = '';
  if (!state.active || kind === 'text') reason = 'Open a .cu, .ptx or Triton .py file';
  else if (kind === 'cuda' && tc && !tc.cuda_frontend) reason = 'No nvcc and no clang with the NVPTX target on the runner';
  else if (kind === 'triton' && tc && !tc.triton) reason = 'Triton is not installed on the runner';
  els.compile.disabled = Boolean(reason);
  els.compile.title = reason || 'Compile the active file (Cmd/Ctrl+Enter)';
}

function showLog(res) {
  els.log.textContent = res
    ? [`# frontend (${res.backend}) exit ${res.frontend.rc ?? 'n/a'}`, res.frontend.log || '(no output)',
      `\n# ptxas ${res.ptxas.available ? `exit ${res.ptxas.rc}` : 'not available'}`, res.ptxas.log || ''].join('\n')
    : '';
}

function jump({ ptxLine, srcLine }) {
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
    if (!ptxLine) { srcEditor.setPosition({ lineNumber: line, column: 1 }); srcEditor.focus(); }
  }
}

/** Show whatever is known about the active file: compile result, live PTX analysis or the empty state. */
function showResult() {
  const path = state.active;
  const kind = path ? kindOf(path) : 'text';
  const stored = path ? state.results.get(path) : null;
  els.split.toggleAttribute('data-single', kind === 'ptx' || kind === 'text');

  if (kind === 'ptx') {
    const analysis = analyzePtx(state.open.get(path).model.getValue());
    linker.decorateSourceAsPtx(analysis);
    renderReport(els.report, { analysis, res: stored?.res ?? null, sourceName: path, onJump: jump });
    showLog(stored?.res ?? null);
    return;
  }
  const ptx = stored?.res?.ptx || '';
  ptxModel.setValue(ptx);
  els.ptxEmpty.hidden = Boolean(ptx);
  els.ptxMeta.textContent = stored?.analysis
    ? `${stored.analysis.target || ''}, ${ptx.split('\n').length} lines, ${stored.res.backend}` : '';
  if (stored?.analysis) linker.linkCompiled(stored.analysis, path);
  if (stored?.res) linker.showDiagnostics(stored.res.diagnostics, path);
  renderReport(els.report, { analysis: stored?.analysis ?? null, res: stored?.res ?? null, sourceName: path || '', onJump: jump });
  showLog(stored?.res ?? null);
}

const livePtx = debounce(() => { if (state.active && kindOf(state.active) === 'ptx') showResult(); }, LIVE_ANALYSIS_MS);

// ------------------------------------------------------------------ compile

async function compile(path, { allowRun = false } = {}) {
  const entry = await ensureOpen(path);
  const res = await api.compile({
    path, content: entry.model.getValue(), arch: els.arch.value, flags: els.flags.value.trim(), allow_run: allowRun,
  });
  const text = kindOf(path) === 'ptx' ? entry.model.getValue() : res.ptx;
  const analysis = text ? analyzePtx(text) : null;
  state.results.set(path, { res, analysis });
  if (path === state.active) showResult();
  return { res, analysis };
}

async function compileActive() {
  const path = state.active;
  if (!path || els.compile.disabled) return;
  els.compile.disabled = true;
  setStatus(`Compiling ${path}`);
  try {
    const { res, analysis } = await compile(path, { allowRun: true });
    const findings = analysis ? analysis.lints.length : 0;
    setStatus(res.ok ? `${findings} findings, ${res.seconds.toFixed(2)} s` : 'Compile failed',
      res.ok ? 'ok' : 'error');
    if (!res.ok && !res.diagnostics.length) selectDock('log');
  } catch (error) {
    setStatus(errorText(error), 'error');
  } finally {
    updateCompileButton();
  }
}

function selectDock(which) {
  const log = which === 'log';
  els.tabReport.setAttribute('aria-selected', String(!log));
  els.tabLog.setAttribute('aria-selected', String(log));
  els.report.hidden = log;
  els.log.hidden = !log;
}

// ------------------------------------------------------------------ toolchain and presets

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
  updateCompileButton();
}

async function loadPresets() {
  const { presets, default: fallback } = await api.presets();
  els.preset.replaceChildren(...presets.map((p) => h('option', { value: p.id, title: p.note }, p.ready ? p.label : `${p.label} (no key)`)));
  const wanted = prefs.get('preset', fallback);
  els.preset.value = presets.some((p) => p.id === wanted) ? wanted : fallback;
  els.preset.addEventListener('change', () => prefs.set('preset', els.preset.value));
}

// ------------------------------------------------------------------ Ripple tools

function askForWrite(path, before, after) {
  return new Promise((resolve) => {
    const original = monaco.editor.createModel(before, languageFor(path));
    const modified = monaco.editor.createModel(after, languageFor(path));
    els.diffPath.textContent = path;
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

const rippleTools = {
  list_files: async () => { await refreshFiles(); return state.files; },
  read_file: async ({ path }) => (await ensureOpenForTool(path)).model.getValue(),
  compile_kernel: async ({ path }) => {
    if (kindOf(path) === 'triton') return { error: 'Triton files run Python on the runner. Ask the user to press Run.' };
    const { res, analysis } = await compile(path);
    return {
      ok: res.ok, backend: res.backend, arch: res.arch, notes: res.notes,
      diagnostics: res.diagnostics.slice(0, MAX_DIAGNOSTICS_FOR_MODEL),
      ...(analysis ? summarize(analysis, path, res.ptxas.functions) : { functions: [], lints: [] }),
    };
  },
  write_file: async ({ path, content }) => {
    if (typeof content !== 'string') throw new Error('content must be a string');
    const known = state.files.some((file) => file.path === path);
    const before = known ? (await ensureOpenForTool(path)).model.getValue() : '';
    if (!(await askForWrite(path, before, content))) return { rejected: true, message: 'The user rejected this change.' };
    await api.write(path, content);
    if (!known) await refreshFiles();
    const entry = await ensureOpen(path);
    if (entry.model.getValue() !== content) {
      entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text: content }], () => null);
    }
    entry.savedVersion = entry.model.getAlternativeVersionId();
    state.results.delete(path);
    setActive(path);
    if (kindOf(path) === 'cuda') compile(path).catch((error) => setStatus(errorText(error), 'error')); // keep the report current
    return { written: path, bytes: content.length };
  },
};

async function ensureOpenForTool(path) {
  if (typeof path !== 'string' || !path) throw new Error('path is required');
  const entry = await ensureOpen(path);
  renderTabs();
  return entry;
}

function systemPrompt() {
  const tc = state.toolchain || {};
  return [
    'You are Ripple, working inside Ripple Kernel IDE, a workbench for CUDA, Triton and PTX GPU kernels.',
    'Work like a kernel engineer: read the kernel, compile it, read the report, then act. After every edit, '
      + 'compile again and compare the numbers. Do not claim a speedup that the report does not show.',
    'The report counts instructions, loops, memory traffic by state space, double-precision ops, thread-local '
      + 'memory and (with ptxas) physical registers and spills. It does not measure run time.',
    'write_file replaces the whole file and the user reviews a diff. Keep edits small and explain each one in one line.',
    `Active file: ${state.active || '(none)'}`,
    `Toolchain: frontend=${tc.cuda_frontend || 'none'}, ptxas=${tc.ptxas ? 'yes' : 'no'}, arch=${els.arch.value}, runner=${tc.runner || 'local'}`,
    tc.cuda_frontend === 'clang-nvptx' ? 'The PTX is a clang NVPTX preview, not nvcc output. Say so when it matters.' : '',
  ].filter(Boolean).join('\n');
}

// ------------------------------------------------------------------ boot

async function boot() {
  monaco = await loadMonaco();
  srcEditor = createEditor(monaco, $('src-editor'));
  ptxModel = monaco.editor.createModel('', 'ptx');
  ptxEditor = createEditor(monaco, $('ptx-editor'), { model: ptxModel, readOnly: true, lineNumbersMinChars: 4 });
  diffEditor = createDiffEditor(monaco, $('diff-editor'));
  linker = createLinker({ monaco, srcEditor, ptxEditor });

  srcEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActive);
  srcEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, compileActive);
  ptxEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, compileActive);
  els.compile.addEventListener('click', compileActive);
  els.toolchain.addEventListener('click', () => refreshToolchain(true));
  els.tabReport.addEventListener('click', () => selectDock('report'));
  els.tabLog.addEventListener('click', () => selectDock('log'));
  els.arch.value = prefs.get('arch', els.arch.value);
  els.flags.value = prefs.get('flags', '');
  els.arch.addEventListener('change', () => prefs.set('arch', els.arch.value));
  els.flags.addEventListener('change', () => prefs.set('flags', els.flags.value));
  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason?.name === 'Canceled') event.preventDefault(); // Monaco cancels a pending diff when its models go away
  });
  window.addEventListener('beforeunload', (event) => {
    if ([...state.open.keys()].some(isDirty)) event.preventDefault();
  });

  createAgent({
    els: {
      chat: $('chat'), form: /** @type {HTMLFormElement} */ ($('composer')),
      prompt: /** @type {HTMLTextAreaElement} */ ($('prompt')), send: /** @type {HTMLButtonElement} */ ($('send')),
      quick: $('quick'), ctx: $('ctx'), perf: $('perf'),
    },
    getPreset: () => els.preset.value,
    systemPrompt,
    tools: rippleTools,
  });

  renderReport(els.report, { analysis: null, res: null, sourceName: '', onJump: jump });
  await Promise.all([refreshFiles(), refreshToolchain(), loadPresets()]);
  const remembered = prefs.get('active', '');
  const first = state.files.find((f) => f.path === remembered) || state.files.find((f) => kindOf(f.path) === 'cuda') || state.files[0];
  if (first) await openFile(first.path);
  document.body.dataset.ready = '1';
}

boot().catch((error) => {
  setStatus(errorText(error), 'error');
  document.body.dataset.ready = 'error';
});
