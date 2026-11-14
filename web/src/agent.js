// Ripple panel: chat loop with tools. The model plans, the IDE runs the tools,
// and a run or a compile report is the model's way to check its own work.

import { streamChat } from './api.js';
import { wireMessages } from './ripple-tools.js';
import { errorText, h, prefs } from './ui.js';

const MAX_TURNS = 12;
const MAX_TOOL_RESULT_CHARS = 60_000;
const CONTEXT_TOKENS = 1_048_576;
const MAX_CHATS = 20;
const MAX_STORED_CHARS = 1_500_000;
const TITLE_CHARS = 36;

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List the files in the workspace.',
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
      name: 'search_files',
      description: 'Search the text of all workspace files (plain text, case-insensitive). Returns path, line and text.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Text to find, at least 2 characters' } },
        required: ['query'], additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_file',
      description: 'Run a .py, .js, .mjs or .sh workspace file and return its exit code and output. The user must allow each run.',
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
      name: 'edit_file',
      description: 'Replace one exact piece of text in a workspace file. old_text must occur exactly once; include '
        + 'enough lines to make it unique. The user sees a diff and can reject it. Prefer this over write_file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path' },
          old_text: { type: 'string', description: 'Exact text to replace, copied from the file' },
          new_text: { type: 'string', description: 'Text that takes its place' },
        },
        required: ['path', 'old_text', 'new_text'], additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a file, or replace the full content of one. The user sees a diff and can reject it. For a change to an existing file use edit_file.',
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
 *         quick: HTMLElement, ctx: HTMLElement, perf: HTMLElement,
 *         chatSelect: HTMLSelectElement, chatNew: HTMLElement, chatDelete: HTMLElement},
 *   getRequest: () => {target: object, options: object},
 *   onPerf?: (perf: {ttft: number, tokps: number}) => void,
 *   systemPrompt: () => string,
 *   contextNote: () => string,
 *   tools: Record<string, (args: any) => Promise<unknown>>,
 * }} deps
 */
export function createAgent({ els, getRequest, onPerf, systemPrompt, contextNote, tools }) {
  /** @type {Array<{id: string, title: string, history: Array<any>}>} chats, newest first */
  let chats = [];
  try {
    chats = JSON.parse(prefs.get('chats', '[]')).filter((chat) => chat && chat.id && Array.isArray(chat.history));
  } catch { chats = []; }
  const fresh = () => ({ id: `c${Date.now().toString(36)}`, title: 'New chat', history: [] });
  if (!chats.length) chats = [fresh()];
  let current = chats[0];
  /** @type {AbortController|null} */
  let running = null;

  /** Keep the chats for the next visit. The oldest ones go first when they get too large. */
  function persist() {
    let kept = chats.slice(0, MAX_CHATS);
    let text = JSON.stringify(kept);
    while (text.length > MAX_STORED_CHARS && kept.length > 1) { kept = kept.slice(0, -1); text = JSON.stringify(kept); }
    prefs.set('chats', text);
  }

  function renderChatList() {
    els.chatSelect.replaceChildren(...chats.map((chat) => h('option', { value: chat.id }, chat.title)));
    els.chatSelect.value = current.id;
  }

  const scroll = () => { els.chat.scrollTop = els.chat.scrollHeight; };
  const append = (node) => { els.chat.querySelector('.chat-empty')?.remove(); els.chat.append(node); scroll(); return node; };

  function showEmpty() {
    els.chat.replaceChildren(h('div', { class: 'chat-empty' },
      h('b', {}, 'Ask about the open file'),
      h('span', {}, 'Ripple reads, searches, runs and compiles with tools. Edits arrive as diffs for you to accept')));
  }

  const toolState = (content) => {
    try {
      const result = JSON.parse(content);
      if (result && typeof result === 'object' && result.rejected) return ['rejected', 'Rejected'];
      if (result && typeof result === 'object' && result.error) return ['error', 'Failed'];
    } catch { /* plain text result */ }
    return ['ok', 'Done'];
  };

  /** Draw a stored chat again: the same blocks the live stream made. */
  function renderChat() {
    els.ctx.textContent = '';
    if (!current.history.length) { showEmpty(); return; }
    const results = new Map(current.history.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content]));
    const nodes = [];
    let block = null;
    for (const message of current.history) {
      if (message.role === 'user') {
        nodes.push(h('div', { class: 'msg msg-user' }, message.content));
        block = h('div', { class: 'msg msg-ripple' });
        nodes.push(block);
      } else if (message.role === 'assistant' && block) {
        if (message.reasoning_content) block.append(h('details', { class: 'think' }, h('summary', {}, 'Reasoning'), h('p', {}, message.reasoning_content)));
        if (message.content) block.append(h('div', { class: 'say' }, message.content));
        for (const call of message.tool_calls || []) {
          const [state, label] = results.has(call.id) ? toolState(results.get(call.id)) : ['error', 'No result'];
          block.append(h('div', { class: 'tool', 'data-state': state }, h('b', {}, call.function.name),
            h('span', { class: 'arg' }, call.function.arguments.slice(0, 80)), h('span', { class: 'state' }, label)));
        }
      }
    }
    els.chat.replaceChildren(...nodes);
    scroll();
  }

  function openChat(chat) {
    if (running) return;
    current = chat;
    renderChatList();
    renderChat();
    els.prompt.focus();
  }

  function newChat() {
    if (running) return;
    if (!current.history.length) { openChat(current); return; } // the open chat is still empty
    const chat = fresh();
    chats = [chat, ...chats];
    persist();
    openChat(chat);
  }

  function deleteChat() {
    if (running) return;
    chats = chats.filter((chat) => chat !== current);
    if (!chats.length) chats = [fresh()];
    persist();
    openChat(chats[0]);
  }

  function setBusy(busy) {
    els.chatSelect.disabled = busy;
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

    const message = { content: '', reasoning: '', toolCalls: /** @type {any[]} */ ([]) };
    const started = performance.now();
    let firstAt = 0;
    let chunks = 0;
    let usage = null;

    const { target, options } = getRequest();
    await streamChat({ ...target, options, messages: wireMessages(systemPrompt(), current.history), tools: TOOLS },
      (event) => {
        if (event.usage) usage = event.usage;
        const delta = event.choices?.[0]?.delta;
        if (!delta) return;
        const reasoning = delta.reasoning ?? delta.reasoning_content;
        if (reasoning || delta.content || delta.tool_calls) { firstAt = firstAt || performance.now(); chunks += 1; }
        if (reasoning) { message.reasoning += reasoning; think.hidden = false; thinkText.append(reasoning); }
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
      const perf = { ttft: Math.round(firstAt - started), tokps: Math.round(tokens / seconds) };
      els.perf.textContent = `first token ${perf.ttft} ms, ${perf.tokps} tok/s`;
      els.perf.dataset.live = '1';
      onPerf?.(perf);
    }
    if (usage?.prompt_tokens != null) els.ctx.textContent = `${formatTokens(usage.prompt_tokens)} of ${formatTokens(CONTEXT_TOKENS)} tokens`;
    if (!message.content) say.remove();

    const calls = message.toolCalls.filter(Boolean);
    // Ripple's chat template puts reasoning_content back in front of the answer, so a
    // tool-call chain keeps the reasoning that led to each call.
    const reasoning = message.reasoning ? { reasoning_content: message.reasoning } : {};
    return calls.length
      ? { role: 'assistant', content: message.content || null, ...reasoning, tool_calls: calls }
      : { role: 'assistant', content: message.content, ...reasoning };
  }

  async function send(text) {
    if (running || !text.trim()) return;
    const chat = current; // the answer belongs to the chat it was asked in
    const history = chat.history;
    append(h('div', { class: 'msg msg-user' }, text));
    if (!history.length) {
      chat.title = text.trim().replace(/\s+/g, ' ').slice(0, TITLE_CHARS) || 'New chat';
      chats = [chat, ...chats.filter((item) => item !== chat)];
      renderChatList();
    }
    // The context note is fixed when the message is sent. See wireMessages.
    history.push({ role: 'user', content: text, context: contextNote() });
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
      persist();
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
  /** @param {string[]} labels one-click prompts for the kind of file that is open */
  const setQuick = (labels) => {
    els.quick.replaceChildren(...labels.map((label) => h('button', { type: 'button', onclick: () => send(label) }, label)));
  };
  els.chatSelect.addEventListener('change', () => openChat(chats.find((chat) => chat.id === els.chatSelect.value) || current));
  els.chatNew.addEventListener('click', newChat);
  els.chatDelete.addEventListener('click', deleteChat);
  renderChatList();
  renderChat();

  /** Put text in the prompt box without sending it. */
  const prefill = (text) => { els.prompt.value = text; els.prompt.focus(); els.prompt.setSelectionRange(text.length, text.length); };

  return { send, prefill, setQuick, newChat, isRunning: () => running !== null };
}
