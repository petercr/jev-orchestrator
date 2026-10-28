import { StringDecoder } from 'node:string_decoder';
import { parseEvaluationJson } from '../ai/transport.js';
import { MAX_PROCESS_OUTPUT_BYTES } from '../process.js';
import { normalizeWorkerUsage, type WorkerUsage } from './usage.js';

export const MAX_WORKER_EVENT_BYTES = 64 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Consume bounded JSONL frames independently of the retained process-output prefix. */
export function createWorkerOutput(agent: 'codex' | 'claude') {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let dropping = false;
  let streamed = false;
  let structured = false;
  let message = '';
  let usage: WorkerUsage | undefined;
  let usageReports = 0;
  const setMessage = (value: unknown): void => {
    if (typeof value === 'string') message = Buffer.from(value).subarray(0, MAX_PROCESS_OUTPUT_BYTES).toString('utf8');
  };
  const line = (text: string): void => {
    let event: unknown;
    try { event = parseEvaluationJson(text); } catch { return; }
    if (!record(event)) return;
    structured = true;
    if (agent === 'codex') {
      if (event.type === 'item.completed' && record(event.item) && event.item.type === 'agent_message') setMessage(event.item.text);
      if (event.type === 'error') setMessage(event.message);
      if (event.type === 'turn.failed' && record(event.error)) setMessage(event.error.message);
      if (event.type === 'turn.completed') {
        usageReports += 1;
        usage = normalizeWorkerUsage(agent, event.usage);
      }
    } else if (event.type === 'result') {
      setMessage(event.result);
      if (typeof event.result !== 'string' && Array.isArray(event.errors)) {
        setMessage(event.errors.filter((error): error is string => typeof error === 'string').join('\n'));
      }
      usageReports += 1;
      usage = normalizeWorkerUsage(agent, event.usage);
    } else if (event.type === 'assistant' && record(event.message) && Array.isArray(event.message.content)) {
      setMessage(event.message.content.filter((part) => record(part) && part.type === 'text' && typeof part.text === 'string')
        .map((part: Record<string, unknown>) => part.text).join('\n'));
    }
  };
  const consume = (text: string): void => {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline < 0 ? text.length : newline;
      const part = text.slice(start, end);
      if (!dropping) {
        if (Buffer.byteLength(pending) + Buffer.byteLength(part) > MAX_WORKER_EVENT_BYTES) {
          pending = '';
          dropping = true;
        } else pending += part;
      }
      if (newline < 0) break;
      if (!dropping && pending.trim()) line(pending);
      pending = '';
      dropping = false;
      start = newline + 1;
    }
  };
  return {
    write(chunk: Buffer): void {
      streamed = true;
      consume(decoder.write(chunk));
    },
    finish(fallback: string): { stdout: string; usage?: WorkerUsage } {
      // Injected process runners may return output without invoking the observer.
      if (!streamed) consume(fallback);
      consume(decoder.end());
      if (!dropping && pending.trim()) line(pending);
      // Never forward raw JSON tool events, reasoning, or provider metadata as worker evidence.
      const stdout = structured || fallback.trimStart().startsWith('{') ? message : fallback;
      return { stdout, ...(usageReports === 1 && usage ? { usage } : {}) };
    },
  };
}
