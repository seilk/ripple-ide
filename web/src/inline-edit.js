// Inline edit (Cmd/Ctrl+K): describe a change, and Ripple rewrites the selected
// lines in place while the text streams in. One undo brings the old text back.

import { streamEdit } from './api.js';
import { errorText } from './ui.js';

const CONTEXT_CHARS = 3000;
const FLASH_MS = 1600;

/** The model sometimes wraps code in a fence; the editor wants the code only. */
export function stripFence(text) {
  let out = text;
  if (out.startsWith('```')) out = out.includes('\n') ? out.slice(out.indexOf('\n') + 1) : '';
  const close = out.lastIndexOf('\n```');
  if (close !== -1 && out.slice(close + 4).trim() === '') out = out.slice(0, close);
  return out.replace(/\n+$/, '');
}

/**
 * @param {{
 *   monaco: any, editor: any, bar: HTMLFormElement, input: HTMLInputElement,
 *   getRequest: () => {target: object, options: object},
 *   getFile: () => {path: string, language: string}|null,
 *   onStatus: (text: string, kind?: string) => void,
 *   onDone?: (info: {seconds: number, lines: number}) => void,
 * }} deps
 */
export function createInlineEdit({ monaco, editor, bar, input, getRequest, getFile, onStatus, onDone }) {
  /** @type {AbortController|null} */
  let running = null;
  /** @type {any} the lines the edit will replace */
  let target = null;
  const flash = editor.createDecorationsCollection();

  function open() {
    const model = editor.getModel();
    const selection = editor.getSelection();
    if (!model || !selection || !getFile() || running) return;
    // Whole lines, so indentation stays with the text that is rewritten.
    const endLine = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
      ? selection.endLineNumber - 1 : selection.endLineNumber;
    target = new monaco.Range(selection.startLineNumber, 1, endLine, model.getLineMaxColumn(endLine));
    flash.set([{ range: target, options: { isWholeLine: true, className: 'edit-target' } }]);
    bar.hidden = false;
    input.value = '';
    input.focus();
  }

  function close() {
    bar.hidden = true;
    if (!running) flash.clear();
    editor.focus();
  }

  async function run(instruction) {
    const model = editor.getModel();
    const file = getFile();
    if (!model || !file || !target || running) return;
    const selection = model.getValueInRange(target);
    if (!selection.trim()) { onStatus('Select the code to change first', 'error'); return; }
    const full = model.getFullModelRange();
    const before = model.getValueInRange(new monaco.Range(1, 1, target.startLineNumber, 1)).slice(-CONTEXT_CHARS);
    const after = model.getValueInRange(new monaco.Range(target.endLineNumber, target.endColumn, full.endLineNumber, full.endColumn)).slice(0, CONTEXT_CHARS);
    const { target: endpoint, options } = getRequest();

    running = new AbortController();
    bar.dataset.busy = '1';
    onStatus('Ripple is editing');
    const started = performance.now();
    let raw = '';
    let range = target;
    const startLine = target.startLineNumber;
    let firstAt = 0;
    editor.pushUndoStop();
    try {
      await streamEdit({ ...endpoint, options, path: file.path, language: file.language, before, selection, after, instruction }, (event) => {
        const delta = event.choices?.[0]?.delta?.content;
        if (!delta) return;
        firstAt = firstAt || performance.now();
        raw += delta;
        const text = stripFence(raw);
        if (!text) return;
        editor.executeEdits('ripple-edit', [{ range, text, forceMoveMarkers: true }]);
        const lines = text.split('\n');
        range = new monaco.Range(startLine, 1, startLine + lines.length - 1, lines[lines.length - 1].length + 1);
        flash.set([{ range, options: { isWholeLine: true, className: 'edit-live' } }]);
        editor.revealRangeInCenterIfOutsideViewport(new monaco.Range(range.endLineNumber, 1, range.endLineNumber, 1));
      }, running.signal);
      editor.pushUndoStop();
      const seconds = (performance.now() - started) / 1000;
      const lines = range.endLineNumber - startLine + 1;
      if (!raw) onStatus('Ripple sent no change', 'error');
      else {
        onStatus(`Edited ${lines} ${lines === 1 ? 'line' : 'lines'} in ${seconds.toFixed(2)} s, first text after ${Math.round(firstAt - started)} ms. Undo brings the old text back`, 'ok');
        onDone?.({ seconds, lines });
      }
    } catch (error) {
      editor.pushUndoStop();
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      onStatus(aborted ? 'Edit stopped. Undo brings the old text back' : `Edit failed: ${errorText(error)}`, aborted ? '' : 'error');
    } finally {
      running = null;
      delete bar.dataset.busy;
      bar.hidden = true;
      setTimeout(() => flash.clear(), FLASH_MS);
      editor.focus();
    }
  }

  bar.addEventListener('submit', (event) => {
    event.preventDefault();
    const instruction = input.value.trim();
    if (instruction) run(instruction);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (running) running.abort(); else close();
  });

  return { open, isRunning: () => running !== null };
}
