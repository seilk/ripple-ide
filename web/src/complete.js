// Inline suggestions (ghost text). The editor asks after a short pause in
// typing; Tab accepts, Escape dismisses, Cmd/Ctrl+Right accepts one word.
//
// Two things keep it quick beyond the model's own speed:
//   - Typing through: while the typed characters match the suggestion on screen, the
//     rest of that suggestion is shown again at once, with no request.
//   - No pause right after an accept, so the next suggestion starts immediately.

const CACHE_SIZE = 40;
const ACCEPTED_COMMAND = 'ripple.suggestionAccepted';
const AFTER_ACCEPT_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   monaco: any,
 *   getRequest: () => {target: object, options: object, debounceMs: number},
 *   onAccepted: () => void,
 *   isEnabled: () => boolean,
 *   getLanguage: (model: any) => string,
 *   getFindings: (model: any) => string[],
 *   onState: (state: {phase: 'idle'|'asking'|'shown'|'none'|'error', source?: string, ms?: number, message?: string}) => void,
 * }} deps
 */
export function registerInlineSuggestions({ monaco, getRequest, onAccepted, isEnabled, getLanguage, getFindings, onState }) {
  let acceptedAt = -Infinity;
  /** @type {{uri: string, line: number, typed: string, completion: string}|null} the suggestion on screen */
  let shown = null;
  monaco.editor.registerCommand(ACCEPTED_COMMAND, () => { acceptedAt = performance.now(); shown = null; onAccepted(); });

  const item = (position, text) => ({
    items: [{
      command: { id: ACCEPTED_COMMAND, title: 'Suggestion accepted' },
      insertText: text,
      range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
    }],
  });

  /** The rest of the suggestion on screen, when the user typed its first characters. */
  function typedThrough(model, position) {
    const typed = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
    if (!shown || shown.uri !== model.uri.toString() || shown.line !== position.lineNumber) return null;
    if (typed.length <= shown.typed.length || !typed.startsWith(shown.typed)) return null;
    const extra = typed.slice(shown.typed.length);
    return shown.completion.startsWith(extra) && shown.completion.length > extra.length
      ? shown.completion.slice(extra.length) : null;
  }
  /** @type {Map<string, {completion: string, source: string, ms: number}>} */
  const cache = new Map();

  async function ask(model, position, token, request) {
    const prefix = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column));
    const end = model.getFullModelRange();
    const suffix = model.getValueInRange(new monaco.Range(position.lineNumber, position.column, end.endLineNumber, end.endColumn));
    const { target, options } = request;
    const key = `${JSON.stringify([target, options])}\u0000${model.getLanguageId()}\u0000${prefix.slice(-2000)}\u0000${suffix.slice(0, 200)}`;
    if (cache.has(key)) return cache.get(key);

    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    onState({ phase: 'asking' });
    const response = await fetch('/api/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        ...target, options, prefix, suffix, path: model.uri.path.replace(/^\//, ''),
        language: getLanguage(model), findings: getFindings(model),
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    cache.set(key, body);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    return body;
  }

  const provider = {
    async provideInlineCompletions(model, position, _context, token) {
      if (!isEnabled() || !model.uri.path || model.uri.scheme !== 'file') return { items: [] };
      const kept = typedThrough(model, position);
      if (kept) { onState({ phase: 'shown', source: 'kept', ms: 0 }); return item(position, kept); }
      const request = getRequest();
      const pause = performance.now() - acceptedAt < AFTER_ACCEPT_MS ? 0 : request.debounceMs;
      await sleep(pause); // a new keystroke cancels this request before it leaves
      if (token.isCancellationRequested) return { items: [] };
      try {
        const started = performance.now();
        const answer = await ask(model, position, token, request);
        if (token.isCancellationRequested) return { items: [] };
        if (!answer.completion) { shown = null; onState({ phase: 'none', source: answer.source }); return { items: [] }; }
        shown = {
          uri: model.uri.toString(), line: position.lineNumber,
          typed: model.getLineContent(position.lineNumber).slice(0, position.column - 1), completion: answer.completion,
        };
        onState({ phase: 'shown', source: answer.source, ms: Math.round(performance.now() - started) });
        return item(position, answer.completion);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          onState({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
        }
        return { items: [] };
      }
    },
    freeInlineCompletions() {},
  };

  monaco.languages.registerInlineCompletionsProvider('*', provider);
  return { clearCache: () => cache.clear() };
}
