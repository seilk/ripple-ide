// Source <-> PTX line links, loop heat in the gutter and finding markers.

import { basename, buildLineLinks } from './ptx-analyze.js';

const LINT_OWNER = 'kernel-lint';
const COMPILER_OWNER = 'compiler';

function lineDecoration(monaco, line) {
  return {
    range: new monaco.Range(line, 1, line, 1),
    options: { isWholeLine: true, className: 'linked-line', linesDecorationsClassName: 'linked-mark' },
  };
}

/**
 * @param {{monaco: any, srcEditor: any, ptxEditor: any}} deps
 */
export function createLinker({ monaco, srcEditor, ptxEditor }) {
  let links = { srcToPtx: new Map(), ptxToSrc: new Map() };
  const srcMarks = srcEditor.createDecorationsCollection();
  const ptxMarks = ptxEditor.createDecorationsCollection();
  const heat = { src: srcEditor.createDecorationsCollection(), ptx: ptxEditor.createDecorationsCollection() };

  const showFromSource = (line) => {
    const ptxLines = links.srcToPtx.get(line) || [];
    srcMarks.set(ptxLines.length ? [lineDecoration(monaco, line)] : []);
    ptxMarks.set(ptxLines.map((n) => lineDecoration(monaco, n)));
    if (ptxLines.length) ptxEditor.revealLineInCenterIfOutsideViewport(ptxLines[0]);
  };
  const showFromPtx = (line) => {
    const srcLine = links.ptxToSrc.get(line);
    if (srcLine === undefined) { srcMarks.clear(); ptxMarks.clear(); return; }
    srcMarks.set([lineDecoration(monaco, srcLine)]);
    ptxMarks.set((links.srcToPtx.get(srcLine) || []).map((n) => lineDecoration(monaco, n)));
    srcEditor.revealLineInCenterIfOutsideViewport(srcLine);
  };

  srcEditor.onDidChangeCursorPosition((event) => {
    if (srcEditor.hasTextFocus()) showFromSource(event.position.lineNumber);
  });
  ptxEditor.onDidChangeCursorPosition((event) => {
    if (ptxEditor.hasTextFocus()) showFromPtx(event.position.lineNumber);
  });

  /** Gutter strips for loop bodies and squiggles for findings, on the editor that shows the PTX. */
  function decoratePtx(editor, collection, analysis) {
    const model = editor.getModel();
    if (!model) return;
    const lastLine = model.getLineCount();
    collection.set(analysis.heat.filter((item) => item.line <= lastLine).map((item) => ({
      range: new monaco.Range(item.line, 1, item.line, 1),
      options: { linesDecorationsClassName: item.depth >= 2 ? 'loop-2' : 'loop-1' },
    })));
    monaco.editor.setModelMarkers(model, LINT_OWNER, analysis.lints
      .filter((lint) => lint.line && lint.line <= lastLine)
      .map((lint) => ({
        startLineNumber: lint.line, endLineNumber: lint.line,
        startColumn: model.getLineFirstNonWhitespaceColumn(lint.line) || 1,
        endColumn: model.getLineMaxColumn(lint.line),
        severity: lint.severity === 'warn' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
        message: lint.message, source: lint.code,
      })));
  }

  function clearModelMarkers() {
    for (const editor of [srcEditor, ptxEditor]) {
      const model = editor.getModel();
      if (!model) continue;
      monaco.editor.setModelMarkers(model, LINT_OWNER, []);
      monaco.editor.setModelMarkers(model, COMPILER_OWNER, []);
    }
  }

  return {
    clear() {
      links = { srcToPtx: new Map(), ptxToSrc: new Map() };
      srcMarks.clear(); ptxMarks.clear(); heat.src.clear(); heat.ptx.clear();
      clearModelMarkers();
    },

    /** The source editor holds a .cu/.py file and the PTX editor holds its PTX. */
    linkCompiled(analysis, sourceName) {
      links = buildLineLinks(analysis, sourceName);
      heat.src.clear();
      decoratePtx(ptxEditor, heat.ptx, analysis);
      const model = srcEditor.getModel();
      const want = basename(sourceName);
      const seen = new Set();
      monaco.editor.setModelMarkers(model, LINT_OWNER, analysis.lints
        .filter((lint) => lint.src && basename(lint.src.file) === want && lint.src.line <= model.getLineCount())
        .filter((lint) => !seen.has(`${lint.code}:${lint.src.line}`) && seen.add(`${lint.code}:${lint.src.line}`))
        .map((lint) => ({
          startLineNumber: lint.src.line, endLineNumber: lint.src.line,
          startColumn: model.getLineFirstNonWhitespaceColumn(lint.src.line) || 1,
          endColumn: model.getLineMaxColumn(lint.src.line),
          severity: lint.severity === 'warn' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
          message: `${lint.message} (PTX line ${lint.line})`, source: lint.code,
        })));
      showFromSource(srcEditor.getPosition()?.lineNumber || 1);
    },

    /** The source editor itself holds PTX text. */
    decorateSourceAsPtx(analysis) {
      links = { srcToPtx: new Map(), ptxToSrc: new Map() };
      srcMarks.clear(); ptxMarks.clear(); heat.ptx.clear();
      decoratePtx(srcEditor, heat.src, analysis);
    },

    /** Compiler errors and warnings on the source file. */
    showDiagnostics(diagnostics, sourceName) {
      const model = srcEditor.getModel();
      if (!model) return;
      const want = basename(sourceName);
      monaco.editor.setModelMarkers(model, COMPILER_OWNER, diagnostics
        .filter((d) => d.file === want && d.line >= 1 && d.line <= model.getLineCount())
        .map((d) => ({
          startLineNumber: d.line, endLineNumber: d.line,
          startColumn: d.col || 1, endColumn: model.getLineMaxColumn(d.line),
          severity: d.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
          message: d.message, source: 'compiler',
        })));
    },

    /** Linked source line of a PTX line, if any. */
    sourceLineOf: (ptxLine) => links.ptxToSrc.get(ptxLine),
    showFromPtx,
  };
}
