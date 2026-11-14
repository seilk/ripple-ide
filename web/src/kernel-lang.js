// Kernel language support: a CUDA dialect of Monaco's C++ grammar, and hover
// notes that tie each side of the listing to the other (threadIdx <-> %tid).

const CUDA_QUALIFIERS = ['__global__', '__device__', '__host__', '__shared__', '__constant__', '__restrict__',
  '__forceinline__', '__noinline__'];
const CUDA_BUILTIN_RE = /\b(?:threadIdx|blockIdx|blockDim|gridDim|warpSize)\b/;
const CUDA_CALL_RE = /\b(?:__sync(?:threads|warp)|__shfl(?:_up|_down|_xor)?_sync|__popc|__clz|__ffs|__ballot_sync|atomic(?:Add|Sub|Min|Max|Exch|CAS|And|Or|Xor))\b/;

const CUDA_NOTES = {
  __global__: ['Kernel entry point', 'Called from the host, runs once per thread of the launch grid. In PTX this is an `.entry` function.'],
  __device__: ['Device function', 'Callable from kernels only. Usually inlined; when it is not, the PTX has a `.func` and a `call`.'],
  __shared__: ['Shared memory', 'One copy per block, visible to all its threads. PTX state space `.shared`.'],
  __constant__: ['Constant memory', 'Read-only data set by the host. PTX state space `.const`.'],
  __restrict__: ['No aliasing', 'Promises that pointers do not overlap, so loads can stay in registers across stores.'],
  threadIdx: ['Thread index in its block', 'Components x, y, z. PTX special register `%tid`.'],
  blockIdx: ['Block index in the grid', 'Components x, y, z. PTX special register `%ctaid`.'],
  blockDim: ['Threads per block', 'Components x, y, z. PTX special register `%ntid`.'],
  gridDim: ['Blocks in the grid', 'Components x, y, z. PTX special register `%nctaid`.'],
  warpSize: ['Threads per warp', '32 on current hardware.'],
  __syncthreads: ['Block barrier', 'Waits until every thread of the block arrives. PTX `bar.sync 0`.'],
  __syncwarp: ['Warp barrier', 'Memory ordering point for the threads in the mask. It does not make diverged threads reconverge.'],
  atomicAdd: ['Atomic add', 'Read-modify-write on one address. PTX `atom.<space>.add`.'],
};

const TRITON_NOTES = {
  'triton.jit': ['Triton kernel', 'Compiles the function for the GPU on first call. One program instance handles one block of elements.'],
  'tl.program_id': ['Program index', 'Index of this program instance along one launch axis, like a block index.'],
  'tl.arange': ['Offsets vector', 'A compile-time-sized range. The size must be a power of two.'],
  'tl.load': ['Vector load', 'Reads a block of elements. `mask` guards out-of-range lanes and `other` gives their value.'],
  'tl.store': ['Vector store', 'Writes a block of elements. `mask` guards out-of-range lanes.'],
  'tl.constexpr': ['Compile-time value', 'A parameter fixed at compile time. Each distinct value compiles a new kernel.'],
  'tl.sum': ['Reduction', 'Adds along an axis inside one program instance.'],
  'tl.max': ['Reduction', 'Maximum along an axis inside one program instance.'],
  'tl.exp': ['Elementwise exp', 'Becomes a call or an approximation sequence in the PTX.'],
};

const PTX_OPCODES = {
  ld: ['Load', '`ld.<space>.<type> d, [a]` reads memory. The state space says which memory: global, shared, local, param or const.'],
  st: ['Store', '`st.<space>.<type> [a], s` writes memory.'],
  ldu: ['Load, uniform', 'A load whose address is the same for all threads of the warp.'],
  mov: ['Move', 'Copies a register, a constant, a special register or an address.'],
  add: ['Add', 'Integer or float addition, by the type suffix.'],
  sub: ['Subtract', 'Integer or float subtraction, by the type suffix.'],
  mul: ['Multiply', '`mul.lo` and `mul.hi` keep one half of the product; `mul.wide` gives a 64-bit product of 32-bit inputs.'],
  mad: ['Multiply-add, integer', 'd = a * b + c. `mad.wide` widens like `mul.wide`.'],
  fma: ['Fused multiply-add, float', 'd = a * b + c with one rounding.'],
  div: ['Divide', 'Integer division is slow on a GPU, and 64-bit division is much slower. Float forms: `.rn`, `.approx`, `.full`.'],
  rem: ['Remainder', 'Integer remainder. As slow as division.'],
  cvt: ['Convert', 'Changes type or width. `cvt.f64.f32` widens to double; `.rn`, `.rz`, `.rm`, `.rp` pick the rounding.'],
  cvta: ['Convert address', '`cvta.to.global` turns a generic address into a state-space address.'],
  setp: ['Compare to predicate', '`setp.lt.s32 p, a, b` writes a predicate register.'],
  selp: ['Select', 'd = p ? a : b, without a branch.'],
  slct: ['Select on sign', 'd = (c >= 0) ? a : b.'],
  bra: ['Branch', '`@%p bra L` branches when the predicate is true. `.uni` promises that the whole warp goes the same way.'],
  brx: ['Indexed branch', 'Jumps through a label table.'],
  call: ['Call', 'A function that was not inlined. `.uni` promises a uniform call across the warp.'],
  ret: ['Return', 'Ends the function.'],
  exit: ['Exit', 'Ends the thread.'],
  trap: ['Trap', 'Aborts the kernel.'],
  bar: ['Barrier', '`bar.sync 0` waits for every thread of the block. This is `__syncthreads()`.'],
  membar: ['Memory barrier', 'Orders this thread\'s memory operations as seen by others.'],
  atom: ['Atomic', '`atom.<space>.<op>.<type>` is an atomic read-modify-write on one address.'],
  and: ['Bitwise and', ''], or: ['Bitwise or', ''], xor: ['Bitwise xor', ''], not: ['Bitwise not', ''],
  shl: ['Shift left', ''], shr: ['Shift right', 'Arithmetic for signed types, logical for unsigned.'],
  shf: ['Funnel shift', 'Shifts a 64-bit value made of two 32-bit registers.'],
  lop3: ['Three-input logic', 'Any boolean function of three inputs, from a lookup table.'],
  popc: ['Population count', ''], clz: ['Count leading zeros', ''], bfind: ['Find highest set bit', ''],
  brev: ['Bit reverse', ''], bfe: ['Bit field extract', ''], bfi: ['Bit field insert', ''],
  min: ['Minimum', ''], max: ['Maximum', ''], abs: ['Absolute value', ''], neg: ['Negate', ''],
  sqrt: ['Square root', '`.rn` is IEEE; `.approx` is faster and less exact.'],
  rsqrt: ['Reciprocal square root', 'Approximate.'], rcp: ['Reciprocal', '`.rn` or `.approx`.'],
  sin: ['Sine', 'Approximate.'], cos: ['Cosine', 'Approximate.'], lg2: ['Log base 2', 'Approximate.'], ex2: ['2 to the power', 'Approximate.'],
  mul24: ['24-bit multiply', ''], mad24: ['24-bit multiply-add', ''],
  prefetch: ['Prefetch', 'Hints that an address will be read.'],
  nop: ['No operation', ''],
};

const PTX_REGISTERS = {
  '%tid': ['Thread index in its block', '`threadIdx` in CUDA.'],
  '%ntid': ['Threads per block', '`blockDim` in CUDA.'],
  '%ctaid': ['Block index in the grid', '`blockIdx` in CUDA.'],
  '%nctaid': ['Blocks in the grid', '`gridDim` in CUDA.'],
  '%laneid': ['Lane in the warp', '0 to 31.'],
  '%warpid': ['Warp index in the block', ''],
  '%smid': ['SM index', 'Which streaming multiprocessor runs this thread.'],
  '%clock': ['Cycle counter, 32 bit', ''], '%clock64': ['Cycle counter, 64 bit', ''],
  '%SP': ['Stack pointer', 'Base of this thread\'s local memory. Its presence means the function uses a stack frame.'],
  '%SPL': ['Stack pointer, local', 'Address of `__local_depot` in the `.local` state space.'],
};

const PTX_DIRECTIVES = {
  '.entry': ['Kernel entry point', 'A `__global__` function.'],
  '.func': ['Device function', 'A function that was not inlined, or an external one.'],
  '.reg': ['Virtual registers', '`%r<10>` declares r0 to r9. ptxas maps them to physical registers; `ptxas -v` gives that count.'],
  '.loc': ['Source position', 'File index, line and column of the instructions that follow.'],
  '.param': ['Parameter', 'A kernel or function argument.'],
  '.global': ['Global memory', 'Device memory, visible to every thread.'],
  '.shared': ['Shared memory', 'One copy per block.'],
  '.local': ['Thread-local memory', 'Per-thread stack: arrays and spilled values. Loads and stores here are memory traffic.'],
  '.const': ['Constant memory', 'Read-only.'],
  '.target': ['Target architecture', 'The lowest SM version this module needs.'],
  '.version': ['PTX language version', ''],
  '.f64': ['Double-precision float', 'Much slower than f32 on most GPUs. Often an accident from a literal without the f suffix.'],
  '.pred': ['Predicate register', 'One bit, set by `setp`, used by `@%p` guards and `selp`.'],
};

function markdown(title, body, tail) {
  return { contents: [{ value: `**${title}**${body ? `\n\n${body}` : ''}${tail ? `\n\n${tail}` : ''}` }] };
}

/** The dotted token under the cursor, like `ld.global.f32`, `%tid.x` or `.loc`. */
function tokenAt(model, position, pattern) {
  const line = model.getLineContent(position.lineNumber);
  for (const match of line.matchAll(pattern)) {
    const start = match.index + 1;
    const end = start + match[0].length;
    if (position.column >= start && position.column <= end) return { text: match[0], start, end };
  }
  return null;
}

function ptxHover(monaco) {
  return {
    provideHover(model, position) {
      const token = tokenAt(model, position, /[%.]?[A-Za-z_][\w.]*/g);
      if (!token) return null;
      const range = new monaco.Range(position.lineNumber, token.start, position.lineNumber, token.end);
      const parts = token.text.split('.');
      let note = null;
      if (token.text.startsWith('%')) note = PTX_REGISTERS[parts[0]];
      else if (token.text.startsWith('.')) note = PTX_DIRECTIVES[`.${parts[1]}`];
      else {
        note = PTX_OPCODES[parts[0]];
        const extra = parts.includes('f64') ? PTX_DIRECTIVES['.f64'][1]
          : parts.includes('local') ? PTX_DIRECTIVES['.local'][1] : '';
        if (note) return { range, ...markdown(`${note[0]} — \`${token.text}\``, note[1], extra) };
      }
      return note ? { range, ...markdown(note[0], note[1]) } : null;
    },
  };
}

function nameHover(monaco, pattern, notes) {
  return {
    provideHover(model, position) {
      const token = tokenAt(model, position, pattern);
      const note = token && notes[token.text];
      if (!note) return null;
      return { range: new monaco.Range(position.lineNumber, token.start, position.lineNumber, token.end), ...markdown(note[0], note[1]) };
    },
  };
}

function loadCpp() {
  return new Promise((resolve, reject) => {
    /** @type {any} */ (window).require(['vs/basic-languages/cpp/cpp'], resolve, reject);
  });
}

/**
 * Registers the `cuda` language and the hover notes.
 * @param {any} monaco
 */
export async function registerKernelLanguages(monaco) {
  monaco.languages.register({ id: 'cuda', extensions: ['.cu', '.cuh'], aliases: ['CUDA'] });
  try {
    const cpp = await loadCpp();
    monaco.languages.setLanguageConfiguration('cuda', cpp.conf);
    monaco.languages.setMonarchTokensProvider('cuda', {
      ...cpp.language,
      tokenPostfix: '.cuda',
      keywords: [...cpp.language.keywords, ...CUDA_QUALIFIERS],
      tokenizer: {
        ...cpp.language.tokenizer,
        root: [[CUDA_BUILTIN_RE, 'builtin'], [CUDA_CALL_RE, 'builtin'], ...cpp.language.tokenizer.root],
      },
    });
  } catch {
    monaco.languages.setMonarchTokensProvider('cuda', { tokenizer: { root: [[/\/\/.*$/, 'comment']] } }); // plain text fallback
  }
  monaco.languages.registerHoverProvider('ptx', ptxHover(monaco));
  monaco.languages.registerHoverProvider('cuda', nameHover(monaco, /[A-Za-z_]\w*/g, CUDA_NOTES));
  monaco.languages.registerHoverProvider('python', nameHover(monaco, /[A-Za-z_]\w*\.[A-Za-z_]\w*/g, TRITON_NOTES));
}
