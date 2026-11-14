// Quick open (file names) and search in files, in one small dialog.

import { debounce, h } from './ui.js';

const MAX_ROWS = 40;
const SEARCH_DELAY_MS = 200;

/** Subsequence match; a lower score is a better match. */
function score(query, text) {
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
 * @param {{
 *   dialog: HTMLDialogElement, input: HTMLInputElement, list: HTMLElement,
 *   getFiles: () => Array<{path: string}>,
 *   search: (query: string) => Promise<Array<{path: string, line: number, text: string}>>,
 *   onPick: (path: string, line?: number) => void,
 * }} deps
 */
export function createPalette({ dialog, input, list, getFiles, search, onPick }) {
  /** @type {'files'|'text'} */
  let mode = 'files';
  /** @type {Array<{path: string, line?: number, text?: string}>} */
  let rows = [];
  let active = 0;
  let ticket = 0;

  function paint() {
    list.replaceChildren(...rows.map((row, index) => h('li', {}, h('button', {
      class: 'palette-row', type: 'button', 'aria-selected': String(index === active),
      onclick: () => pick(index),
    }, h('span', { class: 'mono' }, row.line ? `${row.path}:${row.line}` : row.path),
    row.text ? h('span', { class: 'palette-text' }, row.text) : null))));
    if (!rows.length && input.value.trim()) list.append(h('li', { class: 'palette-none' }, 'No matches'));
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function pick(index) {
    const row = rows[index];
    if (!row) return;
    dialog.close();
    onPick(row.path, row.line);
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
    rows = getFiles()
      .map((file) => ({ path: file.path, rank: needle ? score(needle, file.path.toLowerCase()) : 0 }))
      .filter((row) => row.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path))
      .slice(0, MAX_ROWS);
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
    /** @param {'files'|'text'} next */
    open(next) {
      mode = next;
      input.value = '';
      input.placeholder = mode === 'files' ? 'Go to file' : 'Search in files';
      rows = [];
      if (!dialog.open) dialog.showModal();
      update();
      input.focus();
    },
  };
}
