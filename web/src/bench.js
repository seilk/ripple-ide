// Benchmark runner for the lab: accuracy and latency of inline suggestions,
// and streaming speed of chat, for one Ripple profile.

import { streamChat } from './api.js';
import { CHAT_CASES, COMPLETION_CASES } from './bench-cases.js';

const CHAT_MAX_TOKENS = 160;

/** @param {number[]} values @param {number} fraction 0..1 @returns {number|null} */
export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

/**
 * @param {Array<{pass: boolean, ms: number, error?: string}>} completions
 * @param {Array<{ttft: number|null, tokps: number|null, error?: string}>} chats
 */
export function summarize(completions, chats) {
  const answered = completions.filter((c) => !c.error);
  const speeds = chats.filter((c) => !c.error);
  return {
    total: completions.length,
    passed: completions.filter((c) => c.pass).length,
    errors: completions.filter((c) => c.error).length + chats.filter((c) => c.error).length,
    p50: percentile(answered.map((c) => c.ms), 0.5),
    p95: percentile(answered.map((c) => c.ms), 0.95),
    ttft: percentile(speeds.map((c) => c.ttft).filter((v) => v != null), 0.5),
    tokps: percentile(speeds.map((c) => c.tokps).filter((v) => v != null), 0.5),
  };
}

/**
 * Change of one summary against a baseline summary, with the direction that is good.
 * @returns {Record<string, {diff: number, good: boolean}>}
 */
export function compare(now, base) {
  const higherIsBetter = { passed: true, tokps: true, p50: false, p95: false, ttft: false };
  const out = {};
  for (const [key, better] of Object.entries(higherIsBetter)) {
    if (now[key] == null || base?.[key] == null || now[key] === base[key]) continue;
    const diff = now[key] - base[key];
    out[key] = { diff, good: better ? diff > 0 : diff < 0 };
  }
  return out;
}

async function completionCase(test, target, options, signal) {
  const started = performance.now();
  try {
    const response = await fetch('/api/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ ...target, options, language: test.language, path: test.path, prefix: test.prefix, suffix: test.suffix }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return { id: test.id, ms: Math.round(performance.now() - started), got: body.completion, pass: new RegExp(test.accept).test(body.completion) };
  } catch (error) {
    if (signal.aborted) throw error;
    return { id: test.id, ms: Math.round(performance.now() - started), got: '', pass: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function chatCase(test, target, options, signal) {
  const started = performance.now();
  let first = 0; let chunks = 0; let usage = null;
  try {
    await streamChat({ ...target, options: { ...options, max_tokens: CHAT_MAX_TOKENS }, messages: [{ role: 'user', content: test.prompt }] }, (event) => {
      if (event.usage) usage = event.usage;
      const delta = event.choices?.[0]?.delta;
      if (delta && (delta.content || delta.reasoning || delta.reasoning_content || delta.tool_calls)) { first = first || performance.now(); chunks += 1; }
    }, signal);
    if (!first) return { id: test.id, ttft: null, tokps: null, error: 'no tokens came back' };
    const seconds = Math.max((performance.now() - first) / 1000, 0.001);
    return { id: test.id, ttft: Math.round(first - started), tokps: Math.round((usage?.completion_tokens ?? chunks) / seconds) };
  } catch (error) {
    if (signal.aborted) throw error;
    return { id: test.id, ttft: null, tokps: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Run every case, one request at a time, so numbers are per request and not per batch.
 * @param {{target: object, completeOptions: object, chatOptions: object, signal: AbortSignal,
 *          onProgress: (done: number, total: number) => void}} run
 */
export async function runBenchmark({ target, completeOptions, chatOptions, signal, onProgress }) {
  const total = COMPLETION_CASES.length + CHAT_CASES.length;
  const completions = [];
  const chats = [];
  for (const test of COMPLETION_CASES) {
    completions.push(await completionCase(test, target, completeOptions, signal));
    onProgress(completions.length, total);
  }
  for (const test of CHAT_CASES) {
    chats.push(await chatCase(test, target, chatOptions, signal));
    onProgress(completions.length + chats.length, total);
  }
  return { summary: summarize(completions, chats), completions, chats };
}
