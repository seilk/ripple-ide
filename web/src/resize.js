// Draggable dividers. Each divider drives one CSS custom property on :root.
// Drag to resize, double-click to reset, arrow keys for small steps.

import { prefs } from './ui.js';

const KEY_STEP = 16;

/**
 * @typedef {{
 *   id: string,              element id of the divider
 *   variable: string,        CSS custom property, e.g. '--dock-h'
 *   axis: 'x'|'y',
 *   direction: 1|-1,         +1 when dragging right/down makes the pane larger
 *   measure: () => number,   current size of the pane in px
 *   min: number,
 *   max: () => number,
 * }} Divider
 */

/** @param {Divider[]} dividers */
export function setupDividers(dividers) {
  const root = document.documentElement;

  for (const divider of dividers) {
    const handle = document.getElementById(divider.id);
    if (!handle) continue;
    const key = `size:${divider.variable}`;

    const apply = (pixels, persist) => {
      const clamped = Math.round(Math.min(Math.max(pixels, divider.min), Math.max(divider.max(), divider.min)));
      root.style.setProperty(divider.variable, `${clamped}px`);
      if (persist) prefs.set(key, `${clamped}px`);
    };

    const saved = prefs.get(key, '');
    if (/^\d+px$/.test(saved)) root.style.setProperty(divider.variable, saved);

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startPointer = divider.axis === 'x' ? event.clientX : event.clientY;
      const startSize = divider.measure();
      handle.setPointerCapture(event.pointerId);
      document.body.dataset.resizing = divider.axis;
      const move = (moveEvent) => {
        const pointer = divider.axis === 'x' ? moveEvent.clientX : moveEvent.clientY;
        apply(startSize + (pointer - startPointer) * divider.direction, false);
      };
      const stop = () => {
        handle.removeEventListener('pointermove', move);
        delete document.body.dataset.resizing;
        apply(divider.measure(), true);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', stop, { once: true });
      handle.addEventListener('pointercancel', stop, { once: true });
    });

    handle.addEventListener('dblclick', () => {
      root.style.removeProperty(divider.variable); // back to the stylesheet value
      prefs.set(key, '');
    });

    handle.addEventListener('keydown', (event) => {
      const forward = divider.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      const back = divider.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      if (event.key !== forward && event.key !== back) return;
      event.preventDefault();
      apply(divider.measure() + (event.key === forward ? KEY_STEP : -KEY_STEP) * divider.direction, true);
    });
  }
}
