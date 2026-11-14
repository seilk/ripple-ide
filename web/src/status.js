// Ripple status: is the endpoint of the active profile answering, and how busy
// is the server behind it. A short line in the top bar, details in a panel.

import { api } from './api.js';
import { errorText, h } from './ui.js';

const POLL_MS = 5000;

const gb = (mib) => (mib / 1024).toFixed(0);
const percent = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)} %` : null);
const count = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));

/**
 * Rows of the panel from one status answer. `before` is the answer of the poll before it.
 * @returns {Array<[string, string]>}
 */
export function statusRows(status, before) {
  const rows = [];
  const m = status.metrics || {};
  rows.push(['Endpoint', status.detail || '']);
  if (status.served_as && status.served_as !== status.model) rows.push(['Model', status.served_as]);
  if (status.max_model_len) rows.push(['Context', `${count(status.max_model_len)} tokens`]);
  if (m.running !== undefined) rows.push(['Requests', `${m.running} running, ${m.waiting ?? 0} waiting`]);
  const made = before?.metrics?.generation_tokens !== undefined && m.generation_tokens !== undefined
    ? m.generation_tokens - before.metrics.generation_tokens : 0;
  const seconds = before?.at && status.at ? status.at - before.at : 0;
  if (m.generation_tokens !== undefined) {
    rows.push(['Generated', `${count(m.generation_tokens)} tokens in ${count(m.requests_done ?? 0)} requests${made > 0 && seconds > 0 ? `, ${Math.round(made / seconds)} tok/s now` : ''}`]);
  }
  const cached = percent(m.prompt_tokens_cached ?? m.prefix_cache_hits ?? 0, m.prompt_tokens ?? m.prefix_cache_queries ?? 0);
  if (cached) rows.push(['Prompt cache', `${cached} of prompt tokens reused`]);
  if (m.kv_cache_usage !== undefined) rows.push(['KV cache', `${(m.kv_cache_usage * 100).toFixed(1)} % in use`]);
  if (m.spec_drafts > 0) {
    rows.push(['Speculative decoding', `${(1 + m.spec_accepted_tokens / m.spec_drafts).toFixed(2)} tokens per step, ${percent(m.spec_accepted_tokens, m.spec_draft_tokens)} of draft tokens kept`]);
  }
  for (const gpu of status.gpus || []) {
    rows.push([`GPU on ${status.runner || 'runner'}`, `${gpu.name}, ${gb(gpu.memory_used_mib)} of ${gb(gpu.memory_total_mib)} GB, ${Math.round(gpu.utilization)} % busy, ${Math.round(gpu.power_w)} W`]);
  }
  return rows;
}

/** @param {any} status @returns {string} */
export function statusLine(status) {
  if (!status.ok) return 'Ripple does not answer';
  const m = status.metrics || {};
  if (m.running > 0) return `Ripple busy, ${m.running} running${m.waiting > 0 ? `, ${m.waiting} waiting` : ''}`;
  return 'Ripple ready';
}

/**
 * @param {{button: HTMLElement, panel: HTMLElement, getTarget: () => object, getSession: () => string,
 *          onChange: (ok: boolean, detail: string) => void}} deps
 */
export function createRippleStatus({ button, panel, getTarget, getSession, onChange }) {
  let before = null;
  let last = null;
  let known = null;

  function paint() {
    if (!last) return;
    button.dataset.state = last.ok ? (last.metrics?.running > 0 ? 'busy' : 'ok') : 'down';
    button.lastElementChild.textContent = statusLine(last);
    button.title = last.detail || '';
    if (panel.hidden) return;
    const rows = last.ok ? statusRows(last, before) : [['Endpoint', last.detail || 'no answer']];
    rows.push(['This session', getSession()]);
    panel.replaceChildren(h('dl', {}, rows.map(([name, value]) => h('div', {}, h('dt', {}, name), h('dd', {}, value)))));
  }

  async function poll() {
    try {
      const status = await api.rippleStatus({ ...getTarget(), gpus: !panel.hidden });
      before = last && last.at ? last : before;
      last = status;
    } catch (error) {
      last = { ok: false, detail: errorText(error) };
    }
    if (known !== last.ok) { onChange(last.ok, last.detail || '', known === null); known = last.ok; }
    paint();
  }

  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) { paint(); poll(); } // show what is known at once, then fetch the GPU numbers
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !panel.hidden) { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('pointerdown', (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); }
  });
  setInterval(poll, POLL_MS);
  poll();
  return { refresh: () => { before = null; last = null; return poll(); } };
}
