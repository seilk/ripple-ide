// Inline suggestions (ghost text). Tab accepts, Escape dismisses, Cmd/Ctrl+Right
// accepts one word.
//
// A request takes about 100 ms and a keystroke comes every 100 ms or so. If each
// keystroke threw the running request away and asked again, a suggestion would only
// appear after the typing stops. So:
//   - Ask at once, on the first keystroke. No pause by default.
//   - Keep the running request. Later keystrokes on the same line wait for it, and
//     when it answers, the characters typed since are taken off its front.
//   - Typing through: while the typed characters match the suggestion on screen, the
//     rest of it is shown again with no request at all.
//   - Only when the answer no longer fits what was typed, ask again from the cursor.

const CACHE_SIZE = 40;
const ACCEPTED_COMMAND = 'ripple.suggestionAccepted';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What is left of a suggestion made at `askedAt` once the line reads `typed`.
 * @param {string} askedAt line text up to the cursor when the suggestion was asked for
 * @param {string} completion the suggestion
 * @param {string} typed line text up to the cursor now
 * @returns {string|null} the rest to show, or null when the typing went another way
 */
export function remainder(askedAt, completion, typed) {
  if (!typed.startsWith(askedAt)) return null;
  const extra = typed.slice(askedAt.length);
  return completion.startsWith(extra) && completion.length > extra.length ? completion.slice(extra.length) : null;
}

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
  /** @type {Map<string, {completion: string, source: string}>} */
  const cache = new Map();
  /** @type {{uri: string, line: number, typed: string, completion: string}|null} the suggestion on screen */
  let shown = null;
  /** @type {{uri: string, line: number, typed: string, started: number, promise: Promise<any>}|null} the request on its way */
  let pending = null;
  monaco.editor.registerCommand(ACCEPTED_COMMAND, () => { shown = null; onAccepted(); });

  const item = (position, text) => ({
    items: [{
      command: { id: ACCEPTED_COMMAND, title: 'Suggestion accepted' },
      insertText: text,
      range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
    }],
  });
  const lineUpTo = (model, position) => model.getLineContent(position.lineNumber).slice(0, position.column - 1);

  /** Start one request. It is not tied to a keystroke, so later keystrokes can use its answer. */
  function ask(model, position, request) {
    const prefix = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column));
    const end = model.getFullModelRange();
    const suffix = model.getValueInRange(new monaco.Range(position.lineNumber, position.column, end.endLineNumber, end.endColumn));
    const { target, options } = request;
    const key = `${JSON.stringify([target, options])}\u0000${model.getLanguageId()}\u0000${prefix.slice(-2000)}\u0000${suffix.slice(0, 200)}`;
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    onState({ phase: 'asking' });
    return fetch('/api/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...target, options, prefix, suffix, path: model.uri.path.replace(/^\//, ''),
        language: getLanguage(model), findings: getFindings(model),
      }),
    }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      cache.set(key, body);
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
      return body;
    });
  }

  function show(model, position, askedAt, completion, source, ms) {
    const rest = remainder(askedAt, completion, lineUpTo(model, position));
    if (!rest) return null;
    shown = { uri: model.uri.toString(), line: position.lineNumber, typed: askedAt, completion };
    onState({ phase: 'shown', source, ms });
    return item(position, rest);
  }

  const provider = {
    async provideInlineCompletions(model, position, _context, token) {
      if (!isEnabled() || model.uri.scheme !== 'file') return { items: [] };
      const uri = model.uri.toString();
      const typed = lineUpTo(model, position);

      // 1. The suggestion on screen still fits: no request.
      if (shown && shown.uri === uri && shown.line === position.lineNumber && typed.length > shown.typed.length) {
        const rest = remainder(shown.typed, shown.completion, typed);
        if (rest) { onState({ phase: 'shown', source: 'kept', ms: 0 }); return item(position, rest); }
      }

      try {
        // 2. A request for an earlier point of this line is on its way: use its answer.
        const earlier = pending;
        if (earlier && earlier.uri === uri && earlier.line === position.lineNumber && typed.startsWith(earlier.typed)) {
          const answer = await earlier.promise.catch(() => null);
          if (token.isCancellationRequested) return { items: [] };
          const fits = answer?.completion && show(model, position, earlier.typed, answer.completion, answer.source, Math.round(performance.now() - earlier.started));
          if (fits) return fits;
        }

        // 3. Ask from here.
        const request = getRequest();
        if (request.debounceMs > 0) {
          await sleep(request.debounceMs);
          if (token.isCancellationRequested) return { items: [] };
        }
        const mine = { uri, line: position.lineNumber, typed, started: performance.now(), promise: ask(model, position, request) };
        pending = mine;
        const answer = await mine.promise.finally(() => { if (pending === mine) pending = null; });
        if (token.isCancellationRequested) return { items: [] }; // a later keystroke has taken this answer in step 2
        if (!answer.completion) { shown = null; onState({ phase: 'none', source: answer.source }); return { items: [] }; }
        return show(model, position, typed, answer.completion, answer.source, Math.round(performance.now() - mine.started)) || { items: [] };
      } catch (error) {
        onState({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
        return { items: [] };
      }
    },
    freeInlineCompletions() {},
  };

  monaco.languages.registerInlineCompletionsProvider('*', provider);
  return { clearCache: () => cache.clear() };
}
