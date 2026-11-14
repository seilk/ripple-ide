// Ripple lab: profiles that change how the IDE talks to Ripple, applied to the
// next request with no restart, and a benchmark to see what each change did.

import { compare, percentile, runBenchmark } from './bench.js';
import { errorText, h, prefs } from './ui.js';

const MAX_RUNS_KEPT = 12;
const MAX_SAMPLES = 200;

/** Settings of one profile. An empty chat value means "leave it to the server". */
const FIELDS = [
  { section: 'Inline suggestions', key: 'debounce', label: 'Pause before asking', unit: 'ms', min: 0, max: 2000, step: 5, value: 0 },
  { key: 'prefix', label: 'Context before the cursor', unit: 'chars', min: 200, max: 40000, step: 100, value: 6000 },
  { key: 'suffix', label: 'Context after the cursor', unit: 'chars', min: 0, max: 16000, step: 100, value: 1500 },
  { key: 'tokens', label: 'Max tokens', min: 1, max: 1024, step: 1, value: 192 },
  { key: 'lines', label: 'Max lines shown', min: 1, max: 40, step: 1, value: 10 },
  { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.05, value: 0 },
  { key: 'reason', label: 'Let Ripple reason before a suggestion (slow)', type: 'bool', value: false },
  { key: 'instruction', label: 'Extra instruction', type: 'text', value: '' },
  { section: 'Chat', key: 'chatTemperature', label: 'Temperature', min: 0, max: 2, step: 0.05, value: '' },
  { key: 'chatTopP', label: 'Top p', min: 0, max: 1, step: 0.05, value: '' },
  { key: 'chatTokens', label: 'Max tokens', min: 1, max: 8192, step: 1, value: '' },
  { key: 'chatInstruction', label: 'Extra instruction', type: 'text', value: '' },
  { section: 'Every request', key: 'extraBody', label: 'Extra request body, as JSON', type: 'json', value: '' },
];
const DEFAULTS = Object.fromEntries(FIELDS.map((field) => [field.key, field.value]));

const number = (value) => (value === '' || value == null ? undefined : Number(value));

function parseExtraBody(text) {
  if (!String(text).trim()) return { value: {}, error: '' };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { value: {}, error: 'Must be a JSON object' };
    return { value, error: '' };
  } catch (error) {
    return { value: {}, error: errorText(error) };
  }
}

/**
 * @param {{
 *   pane: HTMLElement, benchPanel: HTMLElement, select: HTMLSelectElement,
 *   presets: Array<{id: string, label: string, model: string, base_url: string, ready: boolean}>,
 *   defaultPreset: string, customEndpoints: boolean,
 *   onStatus: (text: string, kind?: string) => void,
 * }} deps
 */
export function createLab({ pane, benchPanel, select, presets, defaultPreset, customEndpoints, onStatus }) {
  /** @type {Array<any>} */
  let profiles = presets.map((preset) => ({ id: preset.id, name: preset.label, kind: 'preset', preset: preset.id, locked: true, values: { ...DEFAULTS } }));
  try {
    const saved = JSON.parse(prefs.get('profiles', '[]'));
    for (const item of saved) {
      const existing = profiles.find((profile) => profile.id === item.id);
      if (existing) existing.values = { ...DEFAULTS, ...item.values };
      else if (item.id && item.name) profiles.push({ ...item, locked: false, values: { ...DEFAULTS, ...item.values } });
    }
  } catch { /* start from the presets */ }
  let activeId = prefs.get('profile', defaultPreset);
  if (!profiles.some((profile) => profile.id === activeId)) activeId = defaultPreset;

  /** @type {Array<any>} */
  let runs = [];
  let baselineAt = 0;
  /** @type {AbortController|null} */
  let benching = null;
  const session = { shown: 0, accepted: 0, suggestMs: /** @type {number[]} */ ([]), ttft: /** @type {number[]} */ ([]), tokps: /** @type {number[]} */ ([]) };

  const active = () => profiles.find((profile) => profile.id === activeId) || profiles[0];
  const save = () => {
    prefs.set('profiles', JSON.stringify(profiles.map(({ locked, ...rest }) => rest)));
    prefs.set('profile', activeId);
  };

  // ---------------------------------------------------------------- what requests use

  const api = {
    name: () => active().name,
    target() {
      const profile = active();
      return profile.kind === 'custom'
        ? { endpoint: { base_url: profile.base_url || '', model: profile.model || '' } }
        : { preset: profile.preset };
    },
    completeOptions() {
      const v = active().values;
      return {
        prefix_chars: number(v.prefix), suffix_chars: number(v.suffix), max_lines: number(v.lines),
        max_tokens: number(v.tokens), temperature: number(v.temperature),
        system_extra: v.instruction || undefined, reason: v.reason === true, extra_body: parseExtraBody(v.extraBody).value,
      };
    },
    chatOptions() {
      const v = active().values;
      return {
        temperature: number(v.chatTemperature), top_p: number(v.chatTopP), max_tokens: number(v.chatTokens),
        extra_body: parseExtraBody(v.extraBody).value,
      };
    },
    chatInstruction: () => active().values.chatInstruction || '',
    debounceMs: () => number(active().values.debounce) ?? DEFAULTS.debounce,
    noteSuggestion(ms) { session.shown += 1; push(session.suggestMs, ms); renderSession(); },
    noteAccepted() { session.accepted += 1; renderSession(); },
    noteChat({ ttft, tokps }) { push(session.ttft, ttft); push(session.tokps, tokps); renderSession(); },
    runBenchmark: () => bench(),
    sessionLine: () => sessionLine.textContent,
    isBenching: () => benching !== null,
  };

  function push(list, value) {
    list.push(value);
    if (list.length > MAX_SAMPLES) list.shift();
  }

  // ---------------------------------------------------------------- profile pane

  function renderSelect() {
    select.replaceChildren(...profiles.map((profile) => {
      const preset = presets.find((item) => item.id === profile.preset);
      const missingKey = profile.kind === 'preset' && preset && !preset.ready;
      return h('option', { value: profile.id }, missingKey ? `${profile.name} (no key)` : profile.name);
    }));
    select.value = activeId;
  }

  function setActive(id) {
    activeId = id;
    save();
    renderSelect();
    renderPane();
  }

  function duplicate() {
    const source = active();
    const copy = { ...source, id: `p${Date.now().toString(36)}`, name: `${source.name} copy`, locked: false, values: { ...source.values } };
    profiles = [...profiles, copy];
    setActive(copy.id);
  }

  function remove() {
    if (active().locked) return;
    profiles = profiles.filter((profile) => profile.id !== activeId);
    setActive(defaultPreset);
  }

  function fieldRow(field, profile) {
    const id = `lab-${field.key}`;
    const set = (value) => { profile.values = { ...profile.values, [field.key]: value }; save(); };
    if (field.type === 'bool') {
      return h('label', { class: 'lab-field lab-wide lab-check', for: id },
        h('input', { id, type: 'checkbox', checked: profile.values[field.key] === true, onchange: (event) => set(event.target.checked) }),
        h('span', {}, field.label));
    }
    if (field.type === 'text' || field.type === 'json') {
      const note = h('span', { class: 'lab-error' }, field.type === 'json' ? parseExtraBody(profile.values[field.key]).error : '');
      return h('label', { class: 'lab-field lab-wide', for: id }, h('span', {}, field.label),
        h('textarea', {
          id, rows: field.type === 'json' ? 3 : 2, spellcheck: 'false',
          placeholder: field.type === 'json' ? '{"top_k": 20}' : '',
          oninput: (event) => { set(event.target.value); if (field.type === 'json') note.textContent = parseExtraBody(event.target.value).error; },
        }, profile.values[field.key]), note);
    }
    return h('label', { class: 'lab-field', for: id }, h('span', {}, field.label),
      h('span', { class: 'lab-input' },
        h('input', {
          id, type: 'number', min: field.min, max: field.max, step: field.step, value: profile.values[field.key],
          placeholder: field.value === '' ? 'server default' : '',
          oninput: (event) => set(event.target.value),
        }), field.unit ? h('span', { class: 'lab-unit' }, field.unit) : null));
  }

  function endpointRows(profile) {
    const preset = presets.find((item) => item.id === profile.preset);
    if (profile.locked) {
      return [h('p', { class: 'lab-fixed mono' }, preset.base_url === 'mock://' ? 'offline mock, no model' : `${preset.base_url}  ${preset.model}`)];
    }
    const update = (patch) => { Object.assign(profile, patch); save(); renderPane(); };
    const choice = h('select', { id: 'lab-endpoint', 'aria-label': 'Endpoint', onchange: (event) => {
      const value = event.target.value;
      update(value === 'custom' ? { kind: 'custom', base_url: profile.base_url || 'http://127.0.0.1:8000/v1', model: profile.model || 'ricursiveAI/Ripple-65B-Preview' }
        : { kind: 'preset', preset: value });
    } }, presets.map((item) => h('option', { value: item.id, selected: profile.kind === 'preset' && profile.preset === item.id }, item.label)),
    h('option', { value: 'custom', selected: profile.kind === 'custom', disabled: !customEndpoints }, customEndpoints ? 'Custom URL' : 'Custom URL (off on this server)'));
    const rows = [h('label', { class: 'lab-field lab-wide', for: 'lab-endpoint' }, h('span', {}, 'Endpoint'), choice)];
    if (profile.kind === 'custom') {
      rows.push(
        h('label', { class: 'lab-field lab-wide', for: 'lab-url' }, h('span', {}, 'Base URL, on localhost or a private address'),
          h('input', { id: 'lab-url', type: 'text', spellcheck: 'false', value: profile.base_url, oninput: (event) => { profile.base_url = event.target.value; save(); } })),
        h('label', { class: 'lab-field lab-wide', for: 'lab-model' }, h('span', {}, 'Model name'),
          h('input', { id: 'lab-model', type: 'text', spellcheck: 'false', value: profile.model, oninput: (event) => { profile.model = event.target.value; save(); } })));
    }
    return rows;
  }

  const sessionLine = h('p', { class: 'lab-session mono' });
  function renderSession() {
    const rate = session.shown ? ` (${Math.round((session.accepted / session.shown) * 100)} %)` : '';
    const parts = [`Suggestions: ${session.shown} shown, ${session.accepted} accepted${rate}`];
    if (session.suggestMs.length) parts.push(`median ${percentile(session.suggestMs, 0.5)} ms`);
    if (session.ttft.length) parts.push(`chat first token ${percentile(session.ttft, 0.5)} ms, ${percentile(session.tokps, 0.5)} tok/s`);
    sessionLine.textContent = parts.join(', ');
  }

  function renderPane() {
    const profile = active();
    const sections = [];
    let current = null;
    for (const field of FIELDS) {
      if (field.section) { current = h('section', { class: 'lab-section' }, h('h3', {}, field.section)); sections.push(current); }
      current.append(fieldRow(field, profile));
    }
    pane.replaceChildren(
      h('header', { class: 'pane-head' }, h('b', {}, 'Ripple lab'), h('span', {}, 'Changes apply to the next request')),
      h('div', { class: 'lab-body' },
        h('section', { class: 'lab-section' },
          h('div', { class: 'lab-profile' },
            h('input', {
              id: 'lab-name', type: 'text', 'aria-label': 'Profile name', value: profile.name, disabled: profile.locked,
              oninput: (event) => { profile.name = event.target.value || 'Unnamed'; save(); renderSelect(); },
            }),
            h('button', { id: 'lab-duplicate', class: 'quiet', type: 'button', onclick: duplicate }, 'Duplicate'),
            h('button', { id: 'lab-delete', class: 'quiet', type: 'button', disabled: profile.locked, onclick: remove }, 'Delete')),
          endpointRows(profile)),
        sections,
        h('section', { class: 'lab-section' }, h('h3', {}, 'This session'), sessionLine)));
    renderSession();
  }

  // ---------------------------------------------------------------- benchmark

  const signedNumber = (n) => (n < 0 ? `−${Math.abs(n)}` : `+${n}`);

  function cell(value, change, unit = '') {
    return h('td', {}, value == null ? '–' : `${value}${unit}`,
      change ? h('span', { class: 'delta', 'data-dir': change.good ? 'down' : 'up' }, signedNumber(Math.round(change.diff))) : null);
  }

  function renderBench(progress = '') {
    const base = runs.find((run) => run.at === baselineAt);
    const latest = runs[0];
    benchPanel.replaceChildren(
      h('div', { class: 'bench-bar' },
        h('button', { id: 'bench-run', class: 'button', type: 'button', onclick: () => (benching ? benching.abort() : bench()) }, benching ? 'Stop' : 'Run benchmark'),
        h('span', { id: 'bench-progress', class: 'mono' }, progress || (runs.length ? `Changes are against the ${new Date(baselineAt).toLocaleTimeString([], { hour12: false })} run` : '14 suggestion cases and 2 chat prompts, one request at a time'))),
      runs.length ? h('table', { class: 'bench-table' },
        h('thead', {}, h('tr', {}, ['Profile', 'Suggestions passed', 'Median', '95th', 'First token', 'Tokens/s', 'Errors', ''].map((title) => h('th', {}, title)))),
        h('tbody', {}, runs.map((run) => {
          const change = run.at === baselineAt ? {} : compare(run.summary, base?.summary);
          return h('tr', { 'data-baseline': run.at === baselineAt }, h('td', {}, run.profile),
            cell(`${run.summary.passed}/${run.summary.total}`, change.passed),
            cell(run.summary.p50, change.p50, ' ms'), cell(run.summary.p95, change.p95, ' ms'),
            cell(run.summary.ttft, change.ttft, ' ms'), cell(run.summary.tokps, change.tokps),
            h('td', {}, run.summary.errors || ''),
            h('td', {}, run.at === baselineAt ? h('span', { class: 'mono' }, 'baseline')
              : h('button', { class: 'quiet', type: 'button', onclick: () => { baselineAt = run.at; renderBench(); } }, 'Set as baseline')));
        }))) : null,
      latest ? h('details', { class: 'bench-cases' }, h('summary', {}, `Cases of the latest run (${latest.profile})`),
        h('ul', {}, latest.completions.map((item) => h('li', { 'data-pass': item.pass },
          h('span', { class: 'mono' }, item.pass ? 'pass' : item.error ? 'error' : 'fail'), h('span', { class: 'mono' }, item.id),
          h('span', { class: 'mono' }, `${item.ms} ms`), h('span', { class: 'bench-got' }, item.error || item.got.split('\n')[0] || '(empty)'))))) : null);
  }

  async function bench() {
    if (benching) return;
    benching = new AbortController();
    const profile = api.name();
    renderBench('Starting');
    try {
      const result = await runBenchmark({
        target: api.target(), completeOptions: api.completeOptions(), chatOptions: api.chatOptions(), signal: benching.signal,
        onProgress: (done, total) => { const el = benchPanel.querySelector('#bench-progress'); if (el) el.textContent = `${done} of ${total} requests`; },
      });
      const run = { at: Date.now(), profile, ...result };
      runs = [run, ...runs].slice(0, MAX_RUNS_KEPT);
      if (!runs.some((item) => item.at === baselineAt)) baselineAt = runs[runs.length - 1].at;
      onStatus(`Benchmark: ${run.summary.passed}/${run.summary.total} passed, median ${run.summary.p50 ?? '–'} ms`, 'ok');
    } catch (error) {
      onStatus(benching.signal.aborted ? 'Benchmark stopped' : `Benchmark failed: ${errorText(error)}`, benching.signal.aborted ? '' : 'error');
    } finally {
      benching = null;
      renderBench();
    }
  }

  select.addEventListener('change', () => setActive(select.value));
  renderSelect();
  renderPane();
  renderBench();
  return api;
}
