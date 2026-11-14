// PTX reader: functions, instruction mix, memory traffic, loops, source lines
// and kernel findings. Pure functions, so the same file runs in node tests.

const STATE_SPACES = ['global', 'shared', 'local', 'param', 'const'];
const TYPE_BYTES = { b8: 1, u8: 1, s8: 1, b16: 2, u16: 2, s16: 2, f16: 2, b32: 4, u32: 4, s32: 4, f32: 4,
  b64: 8, u64: 8, s64: 8, f64: 8, b128: 16 };
const FLOAT_TYPES = new Set(['f16', 'f32', 'f64', 'bf16', 'f16x2']);
const INT_TYPES = new Set(['s8', 'u8', 's16', 'u16', 's32', 'u32', 's64', 'u64']);
const MAX_LINTS_PER_CODE = 40;
const SEXT_LINT_MIN = 4;
const MAX_CONTINUATION_LINES = 16;

export const CATEGORIES = ['memory', 'float', 'integer', 'logic', 'compare', 'convert', 'move', 'control', 'sync', 'other'];

const BASE_CATEGORY = {
  ld: 'memory', st: 'memory', ldu: 'memory', atom: 'memory', prefetch: 'memory', prefetchu: 'memory',
  bra: 'control', brx: 'control', call: 'control', ret: 'control', exit: 'control', trap: 'control',
  setp: 'compare', set: 'compare', selp: 'compare', slct: 'compare', testp: 'compare',
  cvt: 'convert', cvta: 'convert', mov: 'move',
  and: 'logic', or: 'logic', xor: 'logic', not: 'logic', cnot: 'logic', lop3: 'logic', shl: 'logic',
  shr: 'logic', shf: 'logic', popc: 'logic', clz: 'logic', bfind: 'logic', brev: 'logic', bfe: 'logic', bfi: 'logic',
  bar: 'sync', barrier: 'sync', membar: 'sync',
  fma: 'float', sqrt: 'float', rsqrt: 'float', rcp: 'float', sin: 'float', cos: 'float', lg2: 'float',
  ex2: 'float', tanh: 'float', copysign: 'float',
  add: 'integer', sub: 'integer', mul: 'integer', mad: 'integer', div: 'integer', rem: 'integer',
  abs: 'integer', neg: 'integer', min: 'integer', max: 'integer', mul24: 'integer', mad24: 'integer',
  sad: 'integer', addc: 'integer', subc: 'integer', madc: 'integer', dp4a: 'integer', dp2a: 'integer',
};

const HEADER_RE = /^(?:\.(?:visible|weak|extern)\s+)*\.(entry|func)\s+(?:\([^)]*\)\s*)?([\w$.]+)/;
const INSTR_RE = /^(@!?%[\w.]+\s+)?([a-z][\w.]*)/;
const LABEL_RE = /^([\w$.]+):$/;
const LOC_RE = /^\.loc\s+(\d+)\s+(\d+)\s+(\d+)(.*)$/;
const DATA_RE = /^\.(global|shared|const|local)\s+(?:\.align\s+\d+\s+)?\.(\w+)\s+([\w$.]+)(?:\[(\d*)\])?/;

function stripComment(line) {
  const cut = line.indexOf('//');
  return (cut === -1 ? line : line.slice(0, cut)).trim();
}

export function basename(path) {
  return String(path || '').split(/[\\/]/).pop();
}

/** `_Z6rowsumPKfPfi` -> `rowsum`, `_ZN3foo3barEv` -> `foo::bar`. Other names stay as they are. */
export function demangle(name) {
  const match = /^_ZN?K?/.exec(name);
  if (!match) return name;
  const parts = [];
  let rest = name.slice(match[0].length);
  for (;;) {
    const len = /^(\d+)/.exec(rest);
    if (!len) break;
    const size = Number(len[1]);
    parts.push(rest.slice(len[1].length, len[1].length + size));
    rest = rest.slice(len[1].length + size);
    if (!match[0].includes('N')) break;
  }
  return parts.length ? parts.join('::') : name;
}

function newFunction(name, kind, line) {
  return {
    name, pretty: demangle(name), kind, startLine: line, endLine: line, params: 0,
    regs: {}, regTotal: 0, localDepotBytes: 0, depotLine: null, sharedBytes: 0,
    instructions: 0, mix: Object.fromEntries(CATEGORIES.map((c) => [c, 0])), opcodes: {},
    loads: {}, stores: {}, fp64Ops: 0, intDivs: 0, calls: [], barSync: 0, atomics: 0, branches: 0,
    loops: [], maxLoopDepth: 0,
    _instr: [], _labels: new Map(), _branches: [],
  };
}

function categoryOf(base, parts) {
  const category = BASE_CATEGORY[base] || 'other';
  if (category === 'integer' && parts.some((p) => FLOAT_TYPES.has(p))) return 'float';
  return category;
}

function parseLoc(code, raw) {
  const match = LOC_RE.exec(code);
  if (!match) return null;
  const loc = { file: Number(match[1]), fileName: null, line: Number(match[2]) };
  const inlinedAt = /inlined_at\s+(\d+)\s+(\d+)/.exec(match[4]);
  if (inlinedAt) return { file: Number(inlinedAt[1]), fileName: null, line: Number(inlinedAt[2]) };
  const chain = [...raw.matchAll(/@\[\s*([^\s\]]+?):(\d+):\d+/g)]; // LLVM comment: innermost ... outermost
  if (chain.length) {
    const outer = chain[chain.length - 1];
    return { file: null, fileName: outer[1], line: Number(outer[2]) };
  }
  return loc;
}

function parseRegs(code, fn) {
  const match = /^\.reg\s+\.(\w+)\s+(.+?);?$/.exec(code);
  if (!match) return;
  for (const item of match[2].split(',')) {
    const range = /<(\d+)>/.exec(item);
    const count = range ? Number(range[1]) : 1;
    fn.regs[match[1]] = (fn.regs[match[1]] || 0) + count;
    fn.regTotal += count;
  }
}

function parseInstruction(code, lineNo, loc, fn) {
  const match = INSTR_RE.exec(code);
  if (!match) return;
  const op = match[2].replace(/\.$/, '');
  const parts = op.split('.');
  const base = parts[0];
  const instr = { line: lineNo, op, base, parts, loc, depth: 0 };
  fn._instr.push(instr);
  fn.instructions += 1;
  fn.mix[categoryOf(base, parts)] += 1;
  fn.opcodes[op] = (fn.opcodes[op] || 0) + 1;

  if (base === 'ld' || base === 'ldu' || base === 'st') {
    const space = parts.find((p) => STATE_SPACES.includes(p)) || 'generic';
    const table = base === 'st' ? fn.stores : fn.loads;
    table[space] = (table[space] || 0) + 1;
    instr.space = space;
  }
  if (parts.includes('f64')) fn.fp64Ops += 1;
  if ((base === 'div' || base === 'rem') && parts.some((p) => INT_TYPES.has(p))) fn.intDivs += 1;
  if (base === 'atom') fn.atomics += 1;
  if (base === 'bar' || base === 'barrier') fn.barSync += 1;
  if (base === 'bra') {
    fn.branches += 1;
    const target = /bra(?:\.uni)?\s+([\w$.]+)/.exec(code);
    if (target) fn._branches.push({ line: lineNo, target: target[1] });
  }
  if (base === 'call') {
    const callee = /call(?:\.uni)?\s+(?:\([^)]*\)\s*,\s*)?([\w$.]+)/.exec(code);
    if (callee) { fn.calls.push(callee[1]); instr.callee = callee[1]; }
  }
}

function findLoops(fn) {
  const byHeader = new Map();
  for (const branch of fn._branches) {
    const header = fn._labels.get(branch.target);
    if (header !== undefined && header < branch.line) {
      byHeader.set(header, Math.max(byHeader.get(header) || 0, branch.line));
    }
  }
  fn.loops = [...byHeader].map(([start, end]) => ({ start, end })).sort((a, b) => a.start - b.start);
  for (const instr of fn._instr) {
    instr.depth = fn.loops.filter((loop) => instr.line >= loop.start && instr.line <= loop.end).length;
    fn.maxLoopDepth = Math.max(fn.maxLoopDepth, instr.depth);
  }
}

function lintFunction(fn, lints) {
  const counts = {};
  const add = (code, severity, instr, message) => {
    counts[code] = (counts[code] || 0) + 1;
    if (counts[code] > MAX_LINTS_PER_CODE) return;
    lints.push({ code, severity, fn: fn.name, line: instr.line, src: instr.loc, hot: instr.depth > 0, message });
  };
  const sext = [];

  for (const instr of fn._instr) {
    const { base, parts, op } = instr;
    if (parts.includes('f64')) {
      add('fp64', 'warn', instr, `Double-precision op \`${op}\`. Look for a literal without the f suffix or a double math call.`);
    }
    if ((base === 'div' || base === 'rem') && parts.some((p) => INT_TYPES.has(p))) {
      const wide = parts.some((p) => p.endsWith('64'));
      add('int-div', wide || instr.depth > 0 ? 'warn' : 'info', instr,
        `Integer \`${op}\`${instr.depth > 0 ? ' in a loop' : ''}. Use a shift, a mask or a reciprocal when the divisor is known.`);
    }
    if (base === 'div' && parts.some((p) => FLOAT_TYPES.has(p)) && instr.depth > 0) {
      add('fp-div-hot', 'info', instr, `Float \`${op}\` in a loop. Multiply by a reciprocal if the divisor does not change.`);
    }
    if (instr.space === 'local' && instr.depth > 0) {
      add('local-mem', 'warn', instr, `\`${op}\` in a loop: thread-local memory traffic (stack array or spill).`);
    }
    if (base === 'call' && instr.callee) {
      add('call', 'info', instr, `Call to \`${instr.callee}\` was not inlined.`);
    }
    if (op === 'cvt.s64.s32') sext.push(instr);
  }

  if (fn.localDepotBytes > 0) {
    const traffic = (fn.loads.local || 0) + (fn.stores.local || 0);
    lints.push({
      code: 'local-mem', severity: 'info', fn: fn.name, line: fn.depotLine, src: null, hot: false,
      message: `${fn.localDepotBytes} B of thread-local memory, ${traffic} ld/st.local. Check that this stack array is needed.`,
    });
  }
  if (sext.length >= SEXT_LINT_MIN) {
    add('sext-index', 'info', sext[0],
      `${sext.length} signed 32-to-64-bit index extensions. An unsigned or 64-bit induction variable removes them.`);
  }
}

function resolveLocs(result) {
  for (const fn of result.functions) {
    for (const instr of fn._instr) {
      const loc = instr.loc;
      if (!loc || !loc.line) { instr.loc = null; continue; }
      const file = loc.fileName || result.files[loc.file] || null;
      instr.loc = file ? { file, line: loc.line } : null;
    }
  }
}

export function analyzePtx(text) {
  const result = {
    version: null, target: null, addressSize: null, generator: null,
    files: {}, data: [], functions: [], lints: [], lineMap: [], heat: [],
  };
  const lines = String(text || '').split('\n');
  let fn = null;
  let state = 'top';
  let depth = 0;
  let loc = null;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const lineNo = i + 1;
    const code = stripComment(raw);
    if (!result.generator) {
      const generator = /Generated by (.+)$/.exec(raw);
      if (generator) result.generator = generator[1].trim();
    }
    if (!code) continue;

    if (state === 'top') {
      let match;
      if ((match = /^\.version\s+([\d.]+)/.exec(code))) result.version = match[1];
      else if ((match = /^\.target\s+([\w, ]+)/.exec(code))) result.target = match[1].trim();
      else if ((match = /^\.address_size\s+(\d+)/.exec(code))) result.addressSize = Number(match[1]);
      else if ((match = /^\.file\s+(\d+)\s+"([^"]*)"/.exec(code))) result.files[Number(match[1])] = match[2];
      else if ((match = DATA_RE.exec(code))) {
        const count = match[4] === undefined ? 1 : Number(match[4] || 0);
        result.data.push({ space: match[1], name: match[3], bytes: (TYPE_BYTES[match[2]] || 0) * count, line: lineNo });
      } else if ((match = HEADER_RE.exec(code))) {
        fn = newFunction(match[2], match[1], lineNo);
        state = 'header';
        loc = null;
        if (code.endsWith(';')) { fn = null; state = 'top'; }
      }
      continue;
    }

    if (state === 'header') {
      if (/^\.param\b/.test(code)) fn.params += 1;
      if (code === ';' || code.endsWith(');')) { fn = null; state = 'top'; continue; } // prototype only
      if (code.startsWith('{')) { state = 'body'; depth = 1; }
      continue;
    }

    // body
    if (code.startsWith('{')) { depth += 1; continue; }
    if (code.startsWith('}')) {
      depth -= 1;
      if (depth === 0) {
        fn.endLine = lineNo;
        result.functions.push(fn);
        fn = null;
        state = 'top';
      }
      continue;
    }
    const label = LABEL_RE.exec(code);
    if (label) { fn._labels.set(label[1], lineNo); continue; }
    if (code.startsWith('.')) {
      const data = DATA_RE.exec(code);
      if (/^\.loc\s/.test(code)) loc = parseLoc(code, raw) || loc;
      else if (code.startsWith('.reg')) parseRegs(code, fn);
      else if (data && data[1] === 'local') {
        const bytes = (TYPE_BYTES[data[2]] || 0) * (data[4] === undefined ? 1 : Number(data[4] || 0));
        fn.localDepotBytes += bytes;
        fn.depotLine = fn.depotLine || lineNo;
      } else if (data) { // a static __shared__ array is declared inside the function body
        const bytes = (TYPE_BYTES[data[2]] || 0) * (data[4] === undefined ? 1 : Number(data[4] || 0));
        result.data.push({ space: data[1], name: data[3], bytes, line: lineNo, fn: fn.name });
        if (data[1] === 'shared') fn.sharedBytes += bytes;
      }
      continue;
    }
    let full = code;
    for (let extra = 0; !full.endsWith(';') && extra < MAX_CONTINUATION_LINES && i + 1 < lines.length; extra += 1) {
      i += 1; // an instruction may span lines (nvcc writes call arguments this way)
      full += ` ${stripComment(lines[i])}`;
    }
    parseInstruction(full, lineNo, loc, fn);
  }

  resolveLocs(result);
  for (const func of result.functions) {
    findLoops(func);
    lintFunction(func, result.lints);
    for (const instr of func._instr) {
      if (instr.loc) result.lineMap.push({ ptxLine: instr.line, file: instr.loc.file, srcLine: instr.loc.line });
      if (instr.depth > 0) result.heat.push({ line: instr.line, depth: instr.depth });
    }
    delete func._instr; delete func._labels; delete func._branches;
  }
  result.lints.sort((a, b) => a.line - b.line);
  return result;
}

/** Line links between one source file and the PTX. */
export function buildLineLinks(analysis, sourceName) {
  const want = basename(sourceName);
  const srcToPtx = new Map();
  const ptxToSrc = new Map();
  for (const entry of analysis.lineMap) {
    if (basename(entry.file) !== want) continue;
    ptxToSrc.set(entry.ptxLine, entry.srcLine);
    if (!srcToPtx.has(entry.srcLine)) srcToPtx.set(entry.srcLine, []);
    srcToPtx.get(entry.srcLine).push(entry.ptxLine);
  }
  return { srcToPtx, ptxToSrc };
}

/** Compact report for the model: numbers and findings, no PTX text. */
export function summarize(analysis, sourceName, ptxasFunctions = []) {
  const want = basename(sourceName);
  const registers = new Map(ptxasFunctions.map((f) => [f.function, f]));
  return {
    target: analysis.target,
    functions: analysis.functions.map((fn) => ({
      name: fn.pretty, symbol: fn.name, kind: fn.kind, instructions: fn.instructions,
      loops: fn.loops.length, loads: fn.loads, stores: fn.stores, fp64_ops: fn.fp64Ops,
      local_memory_bytes: fn.localDepotBytes, calls: fn.calls,
      registers: registers.get(fn.name)?.registers ?? null,
      spill_bytes: registers.has(fn.name)
        ? registers.get(fn.name).spill_stores + registers.get(fn.name).spill_loads : null,
    })),
    lints: analysis.lints.map((lint) => ({
      code: lint.code, severity: lint.severity, function: demangle(lint.fn), in_loop: lint.hot,
      ptx_line: lint.line,
      source_line: lint.src && basename(lint.src.file) === want ? lint.src.line : null,
      message: lint.message,
    })),
  };
}
