// One small dialog for three jobs: go to file, search in files, run a command.

import { debounce, h } from './ui.js';

const MAX_ROWS = 40;
const SEARCH_DELAY_MS = 200;
const PLACEHOLDER = { files: 'Go to file', text: 'Search in files', commands: 'Run a command' };

/** Subsequence match; a lower score is a better match, -1 is no match. */
export function fuzzyScore(query, text) {
  let from = 0;
  let total = 0;
  for (const ch of query) {
    const at = text.indexOf(ch, from);
    if (at === -1) return -1;
    total += at - from;
    from = at + 1;
  }
  return total + text.length / 100;
}

/**
 * @typedef {{label: string, detail?: string, hint?: string, run: () => void}} PaletteItem
 * @param {{
 *   dialog: HTMLDialogElement, input: HTMLInputElement, list: HTMLElement,
 *   getFiles: () => PaletteItem[],
 *   getCommands: () => PaletteItem[],
 *   search: (query: string) => Promise<PaletteItem[]>,
 * }} deps
 */
export function createPalette({ dialog, input, list, getFiles, getCommands, search }) {
  /** @type {'files'|'text'|'commands'} */
  let mode = 'files';
  /** @type {PaletteItem[]} */
  let rows = [];
  let active = 0;
  let ticket = 0;

  function paint() {
    list.replaceChildren(...rows.map((row, index) => h('li', {}, h('button', {
      class: 'palette-row', type: 'button', 'aria-selected': String(index === active), onclick: () => pick(index),
    }, h('span', { class: mode === 'commands' ? '' : 'mono' }, row.label),
    h('span', { class: 'palette-text' }, row.detail || ''),
    row.hint ? h('kbd', {}, row.hint) : null))));
    if (!rows.length && input.value.trim()) list.append(h('li', { class: 'palette-none' }, 'No matches'));
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function pick(index) {
    const row = rows[index];
    if (!row) return;
    dialog.close();
    row.run();
  }

  const searchText = debounce(async (query) => {
    const mine = ++ticket;
    try {
      const hits = query.length >= 2 ? await search(query) : [];
      if (mine !== ticket) return;
      rows = hits.slice(0, MAX_ROWS);
    } catch {
      rows = [];
    }
    active = 0;
    paint();
  }, SEARCH_DELAY_MS);

  function update() {
    const query = input.value.trim();
    if (mode === 'text') {
      if (query.length < 2) { ticket += 1; rows = []; paint(); } // clear old rows at once
      searchText(query);
      return;
    }
    const needle = query.toLowerCase();
    const items = mode === 'files' ? getFiles() : getCommands();
    rows = items
      .map((item, order) => ({ item, order, rank: needle ? fuzzyScore(needle, item.label.toLowerCase()) : 0 }))
      .filter((row) => row.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .slice(0, MAX_ROWS)
      .map((row) => row.item);
    active = 0;
    paint();
  }

  input.addEventListener('input', update);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length) active = (active + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      paint();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(active);
    }
  });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });

  return {
    /** @param {'files'|'text'|'commands'} next @param {string} [query] text to start with */
    open(next, query = '') {
      mode = next;
      input.value = query;
      input.placeholder = PLACEHOLDER[mode];
      rows = [];
      if (!dialog.open) dialog.showModal();
      update();
      input.focus();
    },
  };
}
