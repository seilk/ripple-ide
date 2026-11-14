// Monaco setup: loader, night-lab theme and the PTX language.

import { kindOf } from './ui.js';

const PTX_OPCODES = [
  'abs', 'add', 'addc', 'and', 'atom', 'bar', 'barrier', 'bfe', 'bfi', 'bfind', 'bra', 'brev', 'brkpt', 'brx',
  'call', 'clz', 'cnot', 'copysign', 'cos', 'cvt', 'cvta', 'div', 'dp2a', 'dp4a', 'ex2', 'exit', 'fma',
  'ld', 'ldu', 'lg2', 'lop3', 'mad', 'mad24', 'madc', 'max', 'membar', 'min', 'mov', 'mul', 'mul24', 'neg',
  'nop', 'not', 'or', 'pmevent', 'popc', 'prefetch', 'prefetchu', 'rcp', 'rem', 'ret', 'rsqrt', 'sad', 'selp',
  'set', 'setp', 'shf', 'shl', 'shr', 'sin', 'slct', 'sqrt', 'st', 'sub', 'subc', 'tanh', 'testp', 'tex',
  'tld4', 'trap', 'txq', 'xor',
];

const PTX_LANGUAGE = {
  defaultToken: '',
  tokenPostfix: '.ptx',
  opcodes: PTX_OPCODES,
  tokenizer: {
    root: [
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/^\s*[\w$.]+:/, 'label'],
      [/@!?%[\w.]+/, 'predicate'],
      [/\.(?:version|target|address_size|entry|func|visible|extern|weak|common|file|loc|pragma|reg|param|align|ptr|maxntid|reqntid|minnctapersm|maxnctapersm|noreturn|section)\b/, 'directive'],
      [/\.(?:global|shared|local|const)\b/, 'space'],
      [/\.(?:[busf](?:8|16|32|64)|b128|pred|f16x2|bf16)\b/, 'type'],
      [/%[\w.]+(?:<\d+>)?/, 'register'],
      [/\$[\w.]+|__local_depot\d*/, 'label'],
      [/"[^"]*"/, 'string'],
      [/0[xX][0-9a-fA-F]+|0[fFdD][0-9a-fA-F]+|-?\d+(?:\.\d+)?/, 'number'],
      [/[a-z][a-z0-9]*/, { cases: { '@opcodes': 'opcode', '@default': 'identifier' } }],
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
  },
};

const THEME = {
  base: 'vs-dark',
  inherit: true,
  // Toned syntax on graphite. In PTX the opcode leads and the state space
  // (.global/.shared/.local) is the one coloured part, because it says where memory goes.
  rules: [
    { token: '', foreground: 'ededed' },
    { token: 'comment', foreground: '6c6c71', fontStyle: '' },
    { token: 'opcode', foreground: 'ededed' },
    { token: 'directive', foreground: '85858b' },
    { token: 'space', foreground: '8fb3c9' },
    { token: 'type', foreground: 'a1a1a6' },
    { token: 'register', foreground: 'c9c9cd' },
    { token: 'predicate', foreground: 'c9b98a' },
    { token: 'label', foreground: '9bb89a' },
    { token: 'number', foreground: 'c9a08c' },
    { token: 'keyword', foreground: 'c9b98a' },
    { token: 'string', foreground: '9bb89a' },
    { token: 'identifier', foreground: 'ededed' },
    { token: 'delimiter', foreground: 'a1a1a6' },
  ],
  colors: {
    'editor.background': '#141415',
    'editor.foreground': '#ededed',
    'editorLineNumber.foreground': '#57575b',
    'editorLineNumber.activeForeground': '#a1a1a6',
    'editor.lineHighlightBackground': '#19191b',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#ededed24',
    'editor.inactiveSelectionBackground': '#ededed14',
    'editorCursor.foreground': '#ededed',
    'editorGutter.background': '#141415',
    'editorIndentGuide.background1': '#ededed0f',
    'editorWidget.background': '#19191b',
    'editorWidget.border': '#ededed29',
    'editorHoverWidget.background': '#19191b',
    'editorHoverWidget.border': '#ededed29',
    'scrollbarSlider.background': '#ededed14',
    'scrollbarSlider.hoverBackground': '#ededed24',
    'editorOverviewRuler.border': '#00000000',
    'editorBracketHighlight.foreground1': '#a1a1a6',
    'editorBracketHighlight.foreground2': '#a1a1a6',
    'editorBracketHighlight.foreground3': '#a1a1a6',
    'editorBracketHighlight.foreground4': '#a1a1a6',
    'editorBracketHighlight.foreground5': '#a1a1a6',
    'editorBracketHighlight.foreground6': '#a1a1a6',
    'editorBracketMatch.background': '#ededed14',
    'editorBracketMatch.border': '#00000000',
    'editorWarning.foreground': '#e8a33d',
    'editorInfo.foreground': '#85858b',
    'editorError.foreground': '#e5484d',
    'diffEditor.insertedTextBackground': '#4cc38a24',
    'diffEditor.removedTextBackground': '#e5484d24',
    'diffEditor.insertedLineBackground': '#4cc38a12',
    'diffEditor.removedLineBackground': '#e5484d12',
  },
};

const BASE_OPTIONS = {
  theme: 'ripple-night',
  fontFamily: '"IBM Plex Mono", "SF Mono", Menlo, monospace',
  fontSize: 13,
  lineHeight: 20,
  minimap: { enabled: false },
  automaticLayout: true,
  scrollBeyondLastLine: false,
  renderLineHighlight: 'line',
  lineDecorationsWidth: 12,
  padding: { top: 8 },
  bracketPairColorization: { enabled: false },
  guides: { indentation: false },
  tabSize: 2,
  stickyScroll: { enabled: false },
};

/** @returns {Promise<any>} the monaco namespace */
export function loadMonaco() {
  return new Promise((resolve, reject) => {
    const amd = /** @type {any} */ (window).require;
    if (!amd) { reject(new Error('Monaco loader is missing (web/vendor/monaco)')); return; }
    amd.config({ paths: { vs: 'vendor/monaco/vs' } });
    amd(['vs/editor/editor.main'], () => {
      const monaco = /** @type {any} */ (window).monaco;
      monaco.languages.register({ id: 'ptx', extensions: ['.ptx'] });
      monaco.languages.setMonarchTokensProvider('ptx', PTX_LANGUAGE);
      monaco.languages.setLanguageConfiguration('ptx', { comments: { lineComment: '//', blockComment: ['/*', '*/'] } });
      monaco.editor.defineTheme('ripple-night', THEME);
      document.fonts?.ready.then(() => monaco.editor.remeasureFonts());
      resolve(monaco);
    }, reject);
  });
}

/** @param {string} path @returns {string} Monaco language id */
export function languageFor(path) {
  return { cuda: 'cpp', ptx: 'ptx', triton: 'python', text: 'plaintext' }[kindOf(path)];
}

/** @param {any} monaco @param {HTMLElement} el @param {object} [extra] */
export function createEditor(monaco, el, extra = {}) {
  return monaco.editor.create(el, { ...BASE_OPTIONS, model: null, ...extra });
}

/** @param {any} monaco @param {HTMLElement} el */
export function createDiffEditor(monaco, el) {
  return monaco.editor.createDiffEditor(el, { ...BASE_OPTIONS, readOnly: true, renderSideBySide: true });
}
