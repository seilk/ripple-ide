// Inline suggestions (ghost text). The editor asks after a short pause in
// typing; Tab accepts, Escape dismisses, Cmd/Ctrl+Right accepts one word.

const CACHE_SIZE = 40;
const ACCEPTED_COMMAND = 'ripple.suggestionAccepted';

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
  monaco.editor.registerCommand(ACCEPTED_COMMAND, () => onAccepted());
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
      const request = getRequest();
      await sleep(request.debounceMs); // a new keystroke cancels this request before it leaves
      if (token.isCancellationRequested) return { items: [] };
      try {
        const started = performance.now();
        const answer = await ask(model, position, token, request);
        if (token.isCancellationRequested) return { items: [] };
        if (!answer.completion) { onState({ phase: 'none', source: answer.source }); return { items: [] }; }
        onState({ phase: 'shown', source: answer.source, ms: Math.round(performance.now() - started) });
        return {
          items: [{
            command: { id: ACCEPTED_COMMAND, title: 'Suggestion accepted' },
            insertText: answer.completion,
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
          }],
        };
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
