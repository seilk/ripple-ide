// Ripple status: is the endpoint of the active profile answering, and how busy
// is the server behind it. A short line in the top bar, details in a panel.
//
// The panel moves only when the server does: rings leave the mark while tokens
// are generated, a bar graph shows tokens per second, and meters slide to new
// values. The rows are built once and keep their size, so nothing jumps.

import { api } from './api.js';
import { errorText, h } from './ui.js';

const POLL_CLOSED_MS = 5000;
const POLL_OPEN_MS = 1000;
const SPARK_BARS = 40;
const POLL_RETRY_MS = 1000;
const MISSES_BEFORE_DOWN = 2; // one late answer is not a server that is down
const SPARK_FLOOR = 50; // tok/s that fills the graph when the server is slower than this

const count = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const share = (part, whole) => (whole > 0 ? part / whole : null);

/** @param {any} status @returns {string} */
export function statusLine(status) {
  if (!status.ok) return 'Ripple does not answer';
  if (status.slow) return 'Ripple busy, slow to answer';
  const m = status.metrics || {};
  if (m.running > 0) return `Ripple busy, ${m.running} running${m.waiting > 0 ? `, ${m.waiting} waiting` : ''}`;
  return 'Ripple ready';
}

/**
 * What the panel shows for one status answer. `before` is the answer of the poll before it.
 * Each row has text and, where it is a share of something, a fill from 0 to 1.
 * @returns {{busy: boolean, tokps: number, rows: Record<string, {text: string, fill?: number|null}>}}
 */
export function statusView(status, before) {
  const m = status.metrics || {};
  const made = before?.metrics?.generation_tokens !== undefined && m.generation_tokens !== undefined
    ? Math.max(0, m.generation_tokens - before.metrics.generation_tokens) : 0;
  const seconds = before?.at && status.at ? status.at - before.at : 0;
  const tokps = seconds > 0 ? Math.round(made / seconds) : 0;
  const cached = share(m.prompt_tokens_cached ?? m.prefix_cache_hits ?? 0, m.prompt_tokens ?? m.prefix_cache_queries ?? 0);
  const kept = share(m.spec_accepted_tokens ?? 0, m.spec_draft_tokens ?? 0);
  const none = { text: '–', fill: null };
  return {
    busy: Boolean(status.ok) && (Boolean(status.slow) || m.running > 0 || tokps > 0),
    tokps,
    rows: {
      endpoint: { text: status.detail || 'no answer' },
      throughput: { text: m.generation_tokens === undefined ? '–' : tokps > 0 ? `${tokps} tok/s` : 'idle' },
      requests: m.running === undefined ? none : { text: `${m.running} running, ${m.waiting ?? 0} waiting` },
      cache: cached === null ? none : { text: `${Math.round(cached * 100)} % of prompt tokens reused`, fill: cached },
      draft: m.spec_drafts > 0
        ? { text: `${(1 + m.spec_accepted_tokens / m.spec_drafts).toFixed(2)} tokens per step, ${Math.round((kept ?? 0) * 100)} % kept`, fill: kept }
        : none,
      kv: m.kv_cache_usage === undefined ? none : { text: `${(m.kv_cache_usage * 100).toFixed(1)} % in use`, fill: m.kv_cache_usage },
      generated: m.generation_tokens === undefined ? none
        : { text: `${count(m.generation_tokens)} tokens in ${count(m.requests_done ?? 0)} requests` },
    },
  };
}

/**
 * What to show after one more poll. A first missed poll keeps what was shown; the second in a
 * row reads as down. With nothing shown yet, a miss is shown at once.
 * @param {{shown: any, misses: number}} state @param {any} status
 * @returns {{shown: any, misses: number}}
 */
export function afterPoll(state, status) {
  if (status.ok) return { shown: status, misses: 0 };
  const misses = state.misses + 1;
  const keep = state.shown?.ok && misses < MISSES_BEFORE_DOWN;
  return { shown: keep ? state.shown : status, misses };
}

const ROWS = [
  ['requests', 'Requests'], ['cache', 'Prompt cache'], ['draft', 'Draft model'], ['kv', 'KV cache'], ['generated', 'Generated'],
];

/** Build the panel once. Later polls change text and transforms only. */
function buildPanel(panel) {
  const text = {};
  const fill = {};
  const row = (key, label) => {
    text[key] = h('span', { class: 'status-value' });
    fill[key] = h('i', {});
    return h('div', { class: 'status-row', 'data-row': key },
      h('dt', {}, label), h('dd', {}, text[key], h('span', { class: 'meter', 'aria-hidden': 'true' }, fill[key])));
  };
  const mark = h('span', { class: 'ripple-mark', 'aria-hidden': 'true' }, h('i', {}), h('i', {}), h('i', {}));
  const line = h('b', { class: 'status-line' }, 'Checking Ripple');
  const endpoint = h('span', { class: 'status-endpoint' });
  const bars = Array.from({ length: SPARK_BARS }, () => h('i', {}));
  const throughput = h('span', { class: 'status-value' });
  const session = h('span', { class: 'status-value' });
  panel.replaceChildren(
    h('div', { class: 'status-head' }, mark, h('div', {}, line, endpoint)),
    h('div', { class: 'status-spark' },
      h('div', { class: 'spark', role: 'img', 'aria-label': 'Tokens per second, last 40 seconds' }, bars),
      h('div', { class: 'status-spark-label' }, h('span', {}, 'Tokens per second'), throughput)),
    h('dl', {}, ROWS.map(([key, label]) => row(key, label)),
      h('div', { class: 'status-row' }, h('dt', {}, 'This session'), h('dd', {}, session))));
  text.throughput = throughput;
  return { mark, line, endpoint, bars, text, fill, session };
}

/**
 * @param {{button: HTMLElement, panel: HTMLElement, getTarget: () => object, getSession: () => string,
 *          onChange: (ok: boolean, detail: string, first: boolean) => void}} deps
 */
export function createRippleStatus({ button, panel, getTarget, getSession, onChange }) {
  const ui = buildPanel(panel);
  /** @type {number[]} tokens per second of the last polls, newest last */
  let history = new Array(SPARK_BARS).fill(0);
  let before = null;
  let last = null;
  let known = null;
  let misses = 0;
  let timer = 0;

  function paint() {
    if (!last) return;
    const view = statusView(last, before);
    button.dataset.state = last.ok ? (view.busy ? 'busy' : 'ok') : 'down';
    button.lastElementChild.textContent = statusLine(last);
    button.title = last.detail || '';
    if (panel.hidden) return;
    ui.mark.toggleAttribute('data-busy', view.busy);
    ui.mark.dataset.state = last.ok ? 'ok' : 'down';
    ui.line.textContent = statusLine(last);
    ui.endpoint.textContent = view.rows.endpoint.text;
    ui.session.textContent = getSession();
    const top = Math.max(SPARK_FLOOR, ...history);
    ui.bars.forEach((bar, index) => {
      bar.style.transform = `scaleY(${Math.max(0.03, history[index] / top).toFixed(3)})`;
      bar.toggleAttribute('data-on', history[index] > 0);
    });
    for (const [key, value] of Object.entries(view.rows)) {
      if (ui.text[key]) ui.text[key].textContent = value.text;
      if (ui.fill[key]) {
        ui.fill[key].parentElement.hidden = value.fill == null;
        ui.fill[key].style.transform = `scaleX(${Math.min(1, Math.max(0, value.fill ?? 0)).toFixed(3)})`;
      }
    }
  }

  async function poll() {
    clearTimeout(timer);
    let status;
    try {
      status = await api.rippleStatus(getTarget());
    } catch (error) {
      status = { ok: false, detail: errorText(error) };
    }
    const next = afterPoll({ shown: last, misses }, status);
    misses = next.misses;
    if (next.shown === status) {
      before = last && last.at ? last : before;
      last = status;
      if (status.at && before?.at) history = [...history.slice(1), statusView(status, before).tokps];
    }
    if (known !== last.ok) { onChange(last.ok, last.detail || '', known === null); known = last.ok; }
    paint();
    const wait = misses > 0 && last.ok ? POLL_RETRY_MS : panel.hidden ? POLL_CLOSED_MS : POLL_OPEN_MS;
    timer = setTimeout(poll, wait);
  }

  const close = () => { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) { paint(); poll(); } // show what is known at once, then follow the server every second
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !panel.hidden) close(); });
  document.addEventListener('pointerdown', (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) close();
  });
  poll();
  return {
    refresh: () => { before = null; last = null; misses = 0; history = new Array(SPARK_BARS).fill(0); return poll(); },
  };
}
