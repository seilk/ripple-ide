// Small DOM helpers. Text always goes in as text nodes, never as HTML.

/**
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs]
 * @param {...(Node|string|number|null|false|Array<Node|string>)} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** @param {string} id @returns {HTMLElement} */
export function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

/** @param {string} path @returns {string} lower-case extension without the dot, or '' */
export function extOf(path) {
  const name = path.split('/').pop() || '';
  return name.includes('.') ? name.split('.').pop().toLowerCase() : '';
}

/**
 * Kernel kind of a file, or null for an ordinary file. Kernel files get the
 * PTX pane, the kernel report and the kernel tools.
 * @param {string} path
 * @param {string} [text] file content, needed to tell a Triton or CUDA file from plain Python or C++
 * @returns {'cuda'|'ptx'|'triton'|null}
 */
export function kernelKind(path, text = '') {
  const ext = extOf(path);
  if (ext === 'cu' || ext === 'cuh') return 'cuda';
  if (ext === 'ptx') return 'ptx';
  if (['c', 'cc', 'cpp'].includes(ext) && /\b__(?:global|device)__\b/.test(text)) return 'cuda';
  if (ext === 'py' && /^\s*(?:import|from)\s+triton\b|@triton\.jit/m.test(text)) return 'triton';
  return null;
}

/** @param {unknown} error @returns {string} */
export function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Preferences are a convenience; the IDE works when storage is blocked. */
export const prefs = {
  /** @param {string} key @param {string} fallback @returns {string} */
  get(key, fallback) {
    try { return localStorage.getItem(`ripple-ide:${key}`) ?? fallback; } catch { return fallback; }
  },
  /** @param {string} key @param {string} value */
  set(key, value) {
    try { localStorage.setItem(`ripple-ide:${key}`, value); } catch { /* storage blocked */ }
  },
};

/** @template {(...args: any[]) => void} F @param {F} fn @param {number} ms @returns {F} */
export function debounce(fn, ms) {
  let timer = 0;
  return /** @type {F} */ ((...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  });
}
