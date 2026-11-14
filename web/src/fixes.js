// Quick fixes on findings. A finding from the PTX becomes an action on the
// source line: a direct edit when the fix is mechanical, or a brief for Ripple.

const LINT_OWNER = 'kernel-lint';
export const FIX_WITH_RIPPLE = 'ripple.fixFinding';

// A float literal with no suffix: 0.5, 1., .25, 2e-3. Not 0.5f, not v1.5, not a.b
const DOUBLE_LITERAL_RE = /(?<![\w.])(?:\d+\.\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?|\d+[eE][-+]?\d+)(?![\w.])/g;

/**
 * Double literals on one source line, outside the trailing comment.
 * @param {string} line
 * @returns {Array<{text: string, column: number}>} column is 1-based, after the literal
 */
export function doubleLiterals(line) {
  const comment = line.indexOf('//');
  const code = comment === -1 ? line : line.slice(0, comment);
  return [...code.matchAll(DOUBLE_LITERAL_RE)].map((match) => ({
    text: match[0], column: match.index + match[0].length + 1,
  }));
}

/**
 * @param {{monaco: any, askRipple: (prompt: string) => void}} deps
 */
export function registerQuickFixes({ monaco, askRipple }) {
  monaco.editor.registerCommand(FIX_WITH_RIPPLE, (_accessor, prompt) => askRipple(prompt));

  monaco.languages.registerCodeActionProvider('cuda', {
    provideCodeActions(model, _range, context) {
      const actions = [];
      const markers = context.markers.filter((marker) => marker.owner === LINT_OWNER);
      const seen = new Set();
      for (const marker of markers) {
        const lineNumber = marker.startLineNumber;
        const key = `${marker.source}:${lineNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const line = model.getLineContent(lineNumber);

        if (marker.source === 'fp64') {
          const literals = doubleLiterals(line);
          if (literals.length) {
            actions.push({
              title: `Add the f suffix to ${literals.map((l) => l.text).join(', ')}`,
              kind: 'quickfix',
              diagnostics: [marker],
              isPreferred: true,
              edit: {
                edits: literals.map((literal) => ({
                  resource: model.uri,
                  versionId: model.getVersionId(),
                  textEdit: { range: new monaco.Range(lineNumber, literal.column, lineNumber, literal.column), text: 'f' },
                })),
              },
            });
          }
        }
        const path = model.uri.path.replace(/^\//, '');
        actions.push({
          title: `Ask Ripple to fix ${marker.source} on line ${lineNumber}`,
          kind: 'quickfix',
          diagnostics: [marker],
          command: {
            id: FIX_WITH_RIPPLE,
            title: 'Ask Ripple',
            arguments: [`Fix the ${marker.source} finding on line ${lineNumber} of ${path}:\n${line.trim()}\n`
              + `Finding: ${marker.message}\nMake the smallest edit, then compile and compare with the baseline.`],
          },
        });
      }
      return { actions, dispose() {} };
    },
  }, { providedCodeActionKinds: ['quickfix'] });
}
