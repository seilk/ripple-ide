// Inline suggestions (ghost text). The editor asks after a short pause in
// typing; Tab accepts, Escape dismisses, Cmd/Ctrl+Right accepts one word.

const DEBOUNCE_MS = 220;
const CACHE_SIZE = 40;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   monaco: any,
 *   getPreset: () => string,
 *   isEnabled: () => boolean,
 *   getLanguage: (model: any) => string,
 *   getFindings: (model: any) => string[],
 *   onState: (state: {phase: 'idle'|'asking'|'shown'|'none'|'error', source?: string, ms?: number, message?: string}) => void,
 * }} deps
 */
export function registerInlineSuggestions({ monaco, getPreset, isEnabled, getLanguage, getFindings, onState }) {
  /** @type {Map<string, {completion: string, source: string, ms: number}>} */
  const cache = new Map();

  async function ask(model, position, token) {
    const prefix = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column));
    const end = model.getFullModelRange();
    const suffix = model.getValueInRange(new monaco.Range(position.lineNumber, position.column, end.endLineNumber, end.endColumn));
    const preset = getPreset();
    const key = `${preset}\u0000${model.getLanguageId()}\u0000${prefix.slice(-2000)}\u0000${suffix.slice(0, 200)}`;
    if (cache.has(key)) return cache.get(key);

    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    onState({ phase: 'asking' });
    const response = await fetch('/api/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        preset, prefix, suffix, path: model.uri.path.replace(/^\//, ''),
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
      await sleep(DEBOUNCE_MS); // a new keystroke cancels this request before it leaves
      if (token.isCancellationRequested) return { items: [] };
      try {
        const answer = await ask(model, position, token);
        if (token.isCancellationRequested) return { items: [] };
        if (!answer.completion) { onState({ phase: 'none', source: answer.source }); return { items: [] }; }
        onState({ phase: 'shown', source: answer.source, ms: answer.ms });
        return {
          items: [{
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
