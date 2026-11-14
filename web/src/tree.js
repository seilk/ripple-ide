// Workspace file tree: folders that fold, one row per file or folder, delete on hover.

import { extOf, h, prefs } from './ui.js';

const INDENT_PX = 12;

/** @param {Array<{path: string}>} files */
function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push({ name: parts[parts.length - 1], path: file.path });
  }
  return root;
}

/**
 * @param {{
 *   list: HTMLElement,
 *   getActive: () => string|null,
 *   onOpen: (path: string) => void,
 *   onDelete: (path: string) => void,
 *   onDeleteFolder: (path: string, fileCount: number) => void,
 * }} deps
 */
export function createTree({ list, getActive, onOpen, onDelete, onDeleteFolder }) {
  let collapsed;
  try { collapsed = new Set(JSON.parse(prefs.get('collapsed', '[]'))); } catch { collapsed = new Set(); }
  /** @type {Array<{path: string}>} */
  let files = [];

  function rows(node, depth, prefix) {
    const out = [];
    for (const name of [...node.dirs.keys()].sort()) {
      const path = `${prefix}${name}`;
      const open = !collapsed.has(path);
      const inside = files.filter((file) => file.path.startsWith(`${path}/`)).length;
      out.push(h('li', { class: 'file-row' }, h('button', {
        class: 'file folder', type: 'button', 'aria-expanded': String(open), style: `--depth:${depth}`,
        onclick: () => {
          if (open) collapsed.add(path); else collapsed.delete(path);
          prefs.set('collapsed', JSON.stringify([...collapsed]));
          render(files);
        },
      }, h('span', { class: 'ext' }, open ? '▾' : '▸'), h('span', { class: 'name' }, name)),
      h('button', { class: 'file-delete', type: 'button', 'aria-label': `Delete folder ${path}`, title: 'Delete folder', onclick: () => onDeleteFolder(path, inside) }, '×')));
      if (open) out.push(...rows(node.dirs.get(name), depth + 1, `${path}/`));
    }
    for (const file of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(h('li', { class: 'file-row' },
        h('button', {
          class: 'file', type: 'button', title: file.path, style: `--depth:${depth}`,
          'aria-current': file.path === getActive() ? 'true' : null, onclick: () => onOpen(file.path),
        }, h('span', { class: 'ext' }, extOf(file.path).slice(0, 4)), h('span', { class: 'name' }, file.name)),
        h('button', { class: 'file-delete', type: 'button', 'aria-label': `Delete ${file.path}`, title: 'Delete file', onclick: () => onDelete(file.path) }, '×')));
    }
    return out;
  }

  function render(next) {
    files = next;
    list.style.setProperty('--indent', `${INDENT_PX}px`);
    list.replaceChildren(...rows(buildTree(files), 0, ''));
  }

  return { render, refresh: () => render(files) };
}
