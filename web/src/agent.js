// Ripple panel: chat loop with kernel tools. The model plans, the IDE runs the
// tools, and the compile report is the model's way to check its own work.

import { streamChat } from './api.js';
import { errorText, h } from './ui.js';

const MAX_TURNS = 12;
const MAX_TOOL_RESULT_CHARS = 60_000;
const CONTEXT_TOKENS = 1_048_576;

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List the kernel files in the workspace.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read one workspace file. Unsaved editor content wins over the file on disk.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative path' } },
        required: ['path'], additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compile_kernel',
      description: 'Compile a .cu file to PTX (or check a .ptx file) and return the kernel report: per-function '
        + 'instruction counts, loops, memory traffic, ptxas registers when available, findings with PTX and source '
        + 'lines, and compiler diagnostics. Use it after every edit to check the result.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative path of a .cu or .ptx file' } },
        required: ['path'], additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Replace the full content of one workspace file. The user sees a diff and can reject it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path' },
          content: { type: 'string', description: 'Complete new file content' },
        },
        required: ['path', 'content'], additionalProperties: false,
      },
    },
  },
];

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * @param {{
 *   els: {chat: HTMLElement, form: HTMLFormElement, prompt: HTMLTextAreaElement, send: HTMLButtonElement,
 *         quick: HTMLElement, ctx: HTMLElement, perf: HTMLElement},
 *   getPreset: () => string,
 *   systemPrompt: () => string,
 *   tools: Record<string, (args: any) => Promise<unknown>>,
 * }} deps
 */
export function createAgent({ els, getPreset, systemPrompt, tools }) {
  /** @type {Array<object>} */
  const history = [];
  /** @type {AbortController|null} */
  let running = null;

  const scroll = () => { els.chat.scrollTop = els.chat.scrollHeight; };
  const append = (node) => { els.chat.querySelector('.chat-empty')?.remove(); els.chat.append(node); scroll(); return node; };

  function showEmpty() {
    els.chat.replaceChildren(h('div', { class: 'chat-empty' },
      h('b', {}, 'Ask about the open kernel'),
      h('span', {}, 'Ripple reads the file, compiles it and checks the report before it answers. Edits arrive as diffs for you to accept')));
  }

  function setBusy(busy) {
    els.send.textContent = busy ? 'Stop' : 'Send';
    els.send.dataset.busy = busy ? '1' : '';
    els.prompt.disabled = busy;
  }

  async function runTool(call, row) {
    const state = row.querySelector('.state');
    let args;
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      row.dataset.state = 'error'; state.textContent = 'Bad arguments';
      return JSON.stringify({ error: 'arguments were not valid JSON' });
    }
    const tool = tools[call.function.name];
    if (!tool) {
      row.dataset.state = 'error'; state.textContent = 'Unknown tool';
      return JSON.stringify({ error: `unknown tool ${call.function.name}` });
    }
    try {
      const result = await tool(args);
      const rejected = result && typeof result === 'object' && /** @type {any} */ (result).rejected;
      row.dataset.state = rejected ? 'rejected' : 'ok';
      state.textContent = rejected ? 'Rejected' : 'Done';
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated]` : text;
    } catch (error) {
      row.dataset.state = 'error'; state.textContent = 'Failed';
      return JSON.stringify({ error: errorText(error) });
    }
  }

  /** One model call. Returns the assistant message in API form. */
  async function modelTurn(block, signal) {
    const say = h('div', { class: 'say' });
    const thinkText = h('p', {});
    const think = h('details', { class: 'think', hidden: true }, h('summary', {}, 'Reasoning'), thinkText);
    block.append(think, say);

    const message = { content: '', toolCalls: /** @type {any[]} */ ([]) };
    const started = performance.now();
    let firstAt = 0;
    let chunks = 0;
    let usage = null;

    await streamChat({ preset: getPreset(), messages: [{ role: 'system', content: systemPrompt() }, ...history], tools: TOOLS },
      (event) => {
        if (event.usage) usage = event.usage;
        const delta = event.choices?.[0]?.delta;
        if (!delta) return;
        const reasoning = delta.reasoning ?? delta.reasoning_content;
        if (reasoning || delta.content || delta.tool_calls) { firstAt = firstAt || performance.now(); chunks += 1; }
        if (reasoning) { think.hidden = false; thinkText.append(reasoning); }
        if (delta.content) { message.content += delta.content; say.append(delta.content); }
        for (const part of delta.tool_calls || []) {
          const slot = (message.toolCalls[part.index ?? 0] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (part.id) slot.id = part.id;
          if (part.function?.name) slot.function.name += part.function.name;
          if (part.function?.arguments) slot.function.arguments += part.function.arguments;
        }
        scroll();
      }, signal);

    const ended = performance.now();
    if (firstAt) {
      const tokens = usage?.completion_tokens ?? chunks;
      const seconds = Math.max((ended - firstAt) / 1000, 0.001);
      els.perf.textContent = `first token ${Math.round(firstAt - started)} ms, ${(tokens / seconds).toFixed(0)} tok/s`;
      els.perf.dataset.live = '1';
    }
    if (usage?.prompt_tokens != null) els.ctx.textContent = `${formatTokens(usage.prompt_tokens)} of ${formatTokens(CONTEXT_TOKENS)} tokens`;
    if (!message.content) say.remove();

    const calls = message.toolCalls.filter(Boolean);
    return calls.length
      ? { role: 'assistant', content: message.content || null, tool_calls: calls }
      : { role: 'assistant', content: message.content };
  }

  async function send(text) {
    if (running || !text.trim()) return;
    append(h('div', { class: 'msg msg-user' }, text));
    history.push({ role: 'user', content: text });
    running = new AbortController();
    setBusy(true);
    const block = append(h('div', { class: 'msg msg-ripple' }));
    try {
      for (let turn = 0; turn < MAX_TURNS; turn += 1) {
        const assistant = await modelTurn(block, running.signal);
        history.push(assistant);
        if (!assistant.tool_calls) return;
        for (const call of assistant.tool_calls) {
          const row = h('div', { class: 'tool', 'data-state': 'run' },
            h('b', {}, call.function.name),
            h('span', { class: 'arg' }, call.function.arguments.slice(0, 80)),
            h('span', { class: 'state' }, 'Running'));
          block.append(row);
          scroll();
          const content = await runTool(call, row);
          history.push({ role: 'tool', tool_call_id: call.id, content });
        }
      }
      block.append(h('div', { class: 'msg-error' }, `Stopped after ${MAX_TURNS} tool rounds`));
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      block.append(h('div', { class: 'msg-error' }, aborted ? 'Stopped' : errorText(error)));
    } finally {
      running = null;
      setBusy(false);
      scroll();
      els.prompt.focus();
    }
  }

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (running) { running.abort(); return; }
    const text = els.prompt.value;
    els.prompt.value = '';
    send(text);
  });
  els.prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      els.form.requestSubmit();
    }
  });
  for (const label of ['Why is this kernel slow', 'Explain the hot loop', 'Add a header comment']) {
    els.quick.append(h('button', { type: 'button', onclick: () => send(label) }, label));
  }
  showEmpty();

  return { send, isRunning: () => running !== null };
}
