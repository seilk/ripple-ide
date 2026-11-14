import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contextNote, systemPrompt, wireMessages } from '../web/src/ripple-tools.js';

const kernel = { active: 'kernels/saxpy.cu', kernel: 'cuda', toolchain: { cuda_frontend: 'nvcc', ptxas: true }, arch: 'sm_100' };

test('the system prompt does not change with the open file', () => {
  const prompt = systemPrompt({ canRun: true });
  assert.ok(!/Active file|GPU kernel|Toolchain/.test(prompt));
  assert.match(systemPrompt({ canRun: false }), /run_file is off/);
});

test('the context note says what is open, and adds kernel advice for kernels only', () => {
  assert.equal(contextNote({ active: 'hello.py', kernel: null, toolchain: null, arch: 'sm_100' }), 'Active file: hello.py');
  assert.equal(contextNote({ active: null, kernel: null, toolchain: null, arch: 'sm_100' }), 'Active file: (none)');
  assert.match(contextNote(kernel), /^Active file: kernels\/saxpy\.cu\n.*kernel engineer.*\nToolchain: frontend=nvcc, ptxas=yes, arch=sm_100/s);
});

test('a later request is the earlier one plus new messages, whatever file is open by then', () => {
  const system = systemPrompt({ canRun: true });
  const history = [{ role: 'user', content: 'add a tool', context: contextNote({ active: 'hello.py', kernel: null, toolchain: null, arch: 'sm_100' }) }];
  const first = wireMessages(system, history);
  // The agent wrote a file and the editor moved to it; then the user asks about a kernel.
  history.push({ role: 'assistant', content: 'done' }, { role: 'user', content: 'now this one', context: contextNote(kernel) });
  const second = wireMessages(system, history);

  assert.deepEqual(second.slice(0, first.length), first);
  assert.equal(first[1].content, '<ide_context>\nActive file: hello.py\n</ide_context>\nadd a tool');
  assert.ok(second[3].content.startsWith('<ide_context>\nActive file: kernels/saxpy.cu\n'));
  assert.ok(second.every((message) => !('context' in message)));
});

test('a chat stored before context notes existed is sent as it is', () => {
  const old = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
  assert.deepEqual(wireMessages('s', old).slice(1), old);
});
