// Benchmark cases for the lab. A completion case passes when the suggestion
// matches `accept`. That is a pattern check, not a judgement of code quality:
// it tells you when a runtime change breaks answers, and how latency moves.

/** @type {Array<{id: string, language: string, path: string, prefix: string, suffix: string, accept: string}>} */
export const COMPLETION_CASES = [
  { id: 'py-main-guard', language: 'python', path: 'app.py',
    prefix: 'def main():\n    print("hi")\n\n\nif __name__ == ', suffix: '\n', accept: '^["\']__main__["\']:' },
  { id: 'py-numpy-alias', language: 'python', path: 'stats.py',
    prefix: 'import math\nimport num', suffix: '\n\nvalues = np.arange(10)\n', accept: '^py as np' },
  { id: 'py-return-mean', language: 'python', path: 'stats.py',
    prefix: 'def mean(values):\n    return ', suffix: '\n', accept: 'sum\\(values\\)\\s*/\\s*len\\(values\\)' },
  { id: 'py-list-comp', language: 'python', path: 'util.py',
    prefix: 'def squares(n):\n    return [', suffix: '\n', accept: '\\*\\*\\s*2|\\w\\s*\\*\\s*\\w' },
  { id: 'js-console', language: 'javascript', path: 'log.js',
    prefix: 'function report(total) {\n  console.', suffix: '\n}\n', accept: '^(log|info|error|warn)\\(' },
  { id: 'js-for-of', language: 'javascript', path: 'sum.js',
    prefix: 'function sum(items) {\n  let total = 0;\n  for (const ', suffix: '\n  return total;\n}\n', accept: '\\bof items\\)' },
  { id: 'js-arrow-map', language: 'javascript', path: 'names.js',
    prefix: 'const names = users.map((user) => ', suffix: ');\n', accept: 'user\\.\\w+' },
  { id: 'cuda-global-index', language: 'cuda', path: 'saxpy.cu',
    prefix: '__global__ void saxpy(float a, const float* x, float* y, int n) {\n  int i = ', suffix: '\n  if (i < n) y[i] = a * x[i] + y[i];\n}\n',
    accept: 'blockIdx\\.x\\s*\\*\\s*blockDim\\.x\\s*\\+\\s*threadIdx\\.x' },
  { id: 'cuda-float-suffix', language: 'cuda', path: 'scale.cu',
    prefix: '__global__ void scale(float* y, int n) {\n  int i = blockIdx.x * blockDim.x + threadIdx.x;\n  if (i < n) y[i] = y[i] * 0.5', suffix: '\n}\n', accept: '^f' },
  { id: 'cuda-syncthreads', language: 'cuda', path: 'reduce.cu',
    prefix: '  partial[threadIdx.x] = sum;\n  __sync', suffix: '\n  if (threadIdx.x == 0) {\n', accept: '^threads\\(\\)' },
  { id: 'triton-arange', language: 'triton', path: 'softmax.py',
    prefix: '@triton.jit\ndef kernel(x_ptr, n, BLOCK: tl.constexpr):\n    offsets = ', suffix: '\n    mask = offsets < n\n', accept: 'tl\\.arange\\(0,\\s*BLOCK\\)' },
  { id: 'ptx-load-global', language: 'ptx', path: 'k.ptx',
    prefix: '\tcvta.to.global.u64 \t%rd1, %rd0;\n\tld.', suffix: '\n\tret;\n', accept: '^global\\.' },
];

/** Short prompts for streaming speed: time to first token and tokens per second. */
export const CHAT_CASES = [
  { id: 'chat-reverse', prompt: 'Write a Python function that reverses a string. Reply with code only.' },
  { id: 'chat-explain', prompt: 'In two sentences: what does __syncthreads() do in CUDA?' },
];
