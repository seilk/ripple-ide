// Kernel report: one ledger row per function. The large figure is the ptxas
// register count, because that is the number a kernel author checks first.

import { delta, signed, snapshot } from './baseline.js';
import { CATEGORIES, basename } from './ptx-analyze.js';
import { h } from './ui.js';

const MAX_LINTS_SHOWN = 24;
const SPACES = ['global', 'shared', 'local', 'param', 'const', 'generic'];
const LEAD_CATEGORY = 'memory'; // memory traffic decides most kernels, so it carries the accent
const NEUTRAL_STEPS = ['#a1a1a6', '#85858b', '#6c6c71', '#57575b', '#454548', '#38383b', '#2e2e30', '#262628', '#202022'];

/** A change against the baseline. Lower is better for every tracked number. */
function change(n) {
  return n ? h('span', { class: 'delta', 'data-dir': n < 0 ? 'down' : 'up', title: 'Change against the baseline compile' }, signed(n)) : null;
}

function figure(fn, ptxas, changes) {
  const stats = ptxas.get(fn.name);
  if (!stats) {
    return h('div', { class: 'figure' },
      h('div', { class: 'figure-num', 'data-empty': true }, '–'),
      h('div', { class: 'figure-label' }, 'Registers'),
      h('div', { class: 'figure-sub' }, 'needs ptxas'));
  }
  const spill = stats.spill_stores + stats.spill_loads;
  return h('div', { class: 'figure' },
    h('div', { class: 'figure-num' }, stats.registers, change(changes.registers)),
    h('div', { class: 'figure-label' }, 'Registers'),
    h('div', { class: 'figure-sub', 'data-bad': spill > 0 }, `${spill} B spill, ${stats.stack_frame} B stack`));
}

function metric(label, value, flagged, changed) {
  return h('div', { 'data-metric': label }, h('dt', {}, label),
    h('dd', {}, h('span', { 'data-flag': flagged || null }, value), change(changed)));
}

function metrics(fn, changes) {
  return h('dl', { class: 'metrics' },
    metric('Instructions', fn.instructions, false, changes.instructions),
    metric('Loops', fn.loops.length),
    metric('Virtual registers', fn.regTotal),
    metric('fp64 ops', fn.fp64Ops, fn.fp64Ops > 0, changes.fp64Ops),
    metric('Local bytes', fn.localDepotBytes, fn.localDepotBytes > 0, changes.localDepotBytes),
    metric('Shared bytes', fn.sharedBytes));
}

function traffic(fn) {
  const used = CATEGORIES.filter((category) => fn.mix[category] > 0);
  const others = used.filter((category) => category !== LEAD_CATEGORY).sort((a, b) => fn.mix[b] - fn.mix[a]);
  const ordered = used.includes(LEAD_CATEGORY) ? [LEAD_CATEGORY, ...others] : others;
  const step = (category) => NEUTRAL_STEPS[Math.min(others.indexOf(category), NEUTRAL_STEPS.length - 1)];
  const bar = h('div', { class: 'mix', role: 'img', 'aria-label': `Instruction mix: ${ordered.map((c) => `${c} ${fn.mix[c]}`).join(', ')}` },
    ordered.map((category) => h('i', {
      'data-lead': category === LEAD_CATEGORY,
      style: `flex-grow:${fn.mix[category]}${category === LEAD_CATEGORY ? '' : `;--step:${step(category)}`}`,
      title: `${category} ${fn.mix[category]}`,
    })));
  const legend = h('div', { class: 'legend' },
    ordered.map((category) => h('span', { 'data-lead': category === LEAD_CATEGORY }, `${category} ${fn.mix[category]}`)));
  const spaces = SPACES.filter((space) => fn.loads[space] || fn.stores[space]);
  const cell = (n) => h('td', { 'data-zero': !n }, n || 0);
  const table = h('table', { class: 'mem' },
    h('thead', {}, h('tr', {}, h('th', {}, ''), spaces.map((space) => h('th', {}, space)))),
    h('tbody', {},
      h('tr', {}, h('th', {}, 'ld'), spaces.map((space) => cell(fn.loads[space]))),
      h('tr', {}, h('th', {}, 'st'), spaces.map((space) => cell(fn.stores[space])))));
  return h('div', { class: 'traffic' }, bar, legend, table);
}

function lintRow(lint, sourceName, onJump) {
  const srcLine = lint.src && basename(lint.src.file) === basename(sourceName) ? lint.src.line : null;
  return h('button', {
    class: 'lint', type: 'button', 'data-severity': lint.severity, 'data-code': lint.code, 'data-hot': lint.hot,
    title: lint.message.replaceAll('`', ''), onclick: () => onJump({ ptxLine: lint.line, srcLine }),
  },
  h('span', { class: 'dot' }),
  h('span', { class: 'code' }, lint.code),
  h('span', {}, `ptx ${lint.line}`),
  h('span', {}, srcLine ? `src ${srcLine}` : ''),
  h('span', { class: 'loop' }, lint.hot ? 'in loop' : ''),
  h('span', { class: 'msg' }, lint.message.replaceAll('`', '').replace(/\.$/, '')));
}

const lintRank = (lint) => (lint.hot ? 0 : 2) + (lint.severity === 'warn' ? 0 : 1);

function functionRow(fn, lints, ptxas, sourceName, onJump, changes) {
  const mine = lints.filter((lint) => lint.fn === fn.name);
  const shown = [...mine].sort((a, b) => lintRank(a) - lintRank(b) || a.line - b.line).slice(0, MAX_LINTS_SHOWN);
  return h('article', { class: 'fn', 'data-fn': fn.pretty },
    h('header', { class: 'fn-title' },
      h('h3', {}, h('button', { type: 'button', title: 'Go to this function in the PTX', onclick: () => onJump({ ptxLine: fn.startLine, srcLine: null }) }, fn.pretty)),
      h('span', { class: 'mono' }, `${fn.kind} ${fn.name}`)),
    figure(fn, ptxas, changes), metrics(fn, changes), traffic(fn),
    mine.length
      ? h('div', { class: 'lints' },
        shown.map((lint) => lintRow(lint, sourceName, onJump)),
        mine.length > shown.length && h('div', { class: 'lint-more' }, `${mine.length - shown.length} more findings`))
      : h('div', { class: 'clean' }, 'No findings'));
}

/**
 * @param {HTMLElement} root
 * @param {{analysis: any, res: any, sourceName: string, stale?: boolean,
 *   baseline?: {at: Date, fns: Record<string, any>}|null, onSetBaseline?: () => void,
 *   onJump: (target: {ptxLine?: number, srcLine?: number|null}) => void}} view
 */
export function renderReport(root, { analysis, res, sourceName, onJump, baseline = null, stale = false, onSetBaseline }) {
  const out = [];
  if (res) {
    out.push(h('div', { class: 'report-head' },
      h('span', { class: 'backend', 'data-backend': res.backend }, res.backend),
      h('span', {}, `runner ${res.runner}`),
      analysis?.target && h('span', {}, `target ${analysis.target}`),
      analysis?.version && h('span', {}, `PTX ${analysis.version}`),
      h('span', {}, `${res.seconds.toFixed(2)} s`)));
    if (stale) out.push(h('p', { class: 'note', 'data-stale': true }, 'The last compile failed. The PTX and the numbers below are from the last good compile.'));
    const notes = res.notes || [];
    if (notes.length) {
      out.push(h('details', { class: 'notes' },
        h('summary', {}, notes.length === 1 ? '1 note on this toolchain' : `${notes.length} notes on this toolchain`),
        notes.map((note) => h('p', { class: 'note' }, note))));
    }
    for (const diag of res.diagnostics || []) {
      out.push(h('button', {
        class: 'diag', type: 'button', 'data-severity': diag.severity,
        onclick: () => onJump({ srcLine: diag.file === basename(sourceName) ? diag.line : null }),
      }, h('span', {}, diag.severity), h('span', {}, `line ${diag.line}`), h('span', {}, diag.message)));
    }
  }
  if (analysis?.functions.length) {
    const ptxas = new Map((res?.ptxas?.functions || []).map((f) => [f.function, f]));
    const now = snapshot(analysis, res?.ptxas?.functions || []);
    if (baseline && onSetBaseline) {
      out.push(h('div', { class: 'baseline' },
        h('span', {}, `Changes are against the ${baseline.at.toLocaleTimeString([], { hour12: false })} compile`),
        h('button', { class: 'quiet', type: 'button', onclick: onSetBaseline }, 'Set baseline here')));
    }
    for (const fn of analysis.functions) {
      out.push(functionRow(fn, analysis.lints, ptxas, sourceName, onJump, delta(baseline?.fns[fn.name], now[fn.name])));
    }
  } else if (!res) {
    out.push(h('p', { class: 'report-empty' }, 'No report yet'));
  } else if (!res.diagnostics?.length) {
    out.push(h('p', { class: 'report-empty' }, 'The PTX has no functions. The compiler log has the details.'));
  }
  root.replaceChildren(...out);
}
