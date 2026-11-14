// Calls to the local IDE server.

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function request(url, init) {
  let response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error('The IDE server does not answer. Is server.py running?');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.detail ? `: ${String(body.detail).slice(0, 300)}` : '';
    throw new Error(`${body.error || `HTTP ${response.status}`}${detail}`);
  }
  return body;
}

const json = (method, payload) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

export const api = {
  presets: () => request('/api/presets'),
  toolchain: (refresh = false) => request(`/api/toolchain${refresh ? '?refresh=1' : ''}`),
  files: () => request('/api/files'),
  read: (path) => request(`/api/file?path=${encodeURIComponent(path)}`),
  write: (path, content) => request('/api/file', json('PUT', { path, content })),
  remove: (path) => request(`/api/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  search: (query) => request(`/api/search?q=${encodeURIComponent(query)}`),
  compile: (payload) => request('/api/compile', json('POST', payload)),
};

/** Stream one chat completion. */
export const streamChat = (payload, onEvent, signal) => streamEvents('/api/chat', payload, onEvent, signal);

/** Stream the new text for a selected part of a file. */
export const streamEdit = (payload, onEvent, signal) => streamEvents('/api/edit', payload, onEvent, signal);

/** Run one workspace file and stream its output. */
export const streamRun = (path, onEvent, signal) => streamEvents('/api/run', { path }, onEvent, signal);

/**
 * POST and read a server-sent event stream. Calls `onEvent` for each JSON event.
 * @param {string} url
 * @param {object} payload
 * @param {(event: any) => void} onEvent
 * @param {AbortSignal} [signal]
 */
async function streamEvents(url, payload, onEvent, signal) {
  const response = await fetch(url, { ...json('POST', payload), signal });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    const detail = body.detail ? `: ${String(body.detail).slice(0, 300)}` : '';
    throw new Error(`${body.error || `HTTP ${response.status}`}${detail}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try { onEvent(JSON.parse(data)); } catch { /* keep-alive or partial line */ }
    }
  }
}
