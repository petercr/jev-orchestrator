import { EvaluationError } from './errors.js';
import { throwIfInterrupted } from '../cancellation.js';

export const MAX_EVALUATION_RESPONSE_BYTES = 64 * 1024;
export const MAX_JEV_RESPONSE_BYTES = MAX_EVALUATION_RESPONSE_BYTES;

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
