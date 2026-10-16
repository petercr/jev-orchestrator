import { EvaluationError } from './errors.js';
import { throwIfInterrupted } from '../cancellation.js';

export const MAX_EVALUATION_RESPONSE_BYTES = 64 * 1024;
export const MAX_JEV_RESPONSE_BYTES = MAX_EVALUATION_RESPONSE_BYTES;

/** Reject duplicate object keys before they can hide answers or probabilities. */
export function parseEvaluationJson(text: string): unknown {
  function invalid(): never {
    throw new EvaluationError('invalid_response', 'Decision provider returned invalid JSON evaluation data.', { stage: 'json', category: 'shape' });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { invalid(); }
  const objects: Array<Set<string> | null> = [];
  // Consume whole strings so brackets and escaped quotes in values are inert.
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]]/g)) {
    const token = match[0];
    if (token === '{') objects.push(new Set());
    else if (token === '[') objects.push(null);
    else if (token === '}' || token === ']') objects.pop();
    else {
      let next = match.index + token.length;
      while (/\s/.test(text[next] ?? '')) next += 1;
      if (text[next] !== ':') continue;
      const keys = objects.at(-1);
      const key: string = JSON.parse(token);
      if (!keys || keys.has(key)) invalid();
      keys.add(key);
    }
  }
  return parsed;
}

/** Enforce a byte cap while reading, including chunked and error responses. */
export async function boundedResponse(response: Response, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throwIfInterrupted(signal);
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const abort = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      throwIfInterrupted(signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_EVALUATION_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new EvaluationError('invalid_response', 'Decision response exceeded the bounded output limit.', { stage: 'transport', category: 'size' });
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  return new Response(Buffer.concat(chunks), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
