import { throwIfInterrupted } from '../cancellation.js';
import { cloudflareModelPath, validateCloudflareAccountId, type CloudflareConfiguration } from '../config.js';
import { redactSensitiveText, sanitizeTraceValue } from '../logging/trace.js';
import type { AgentState } from '../types.js';
import { isRecord, NATIVE_EVALUATION_QUESTIONS, normalizeAssessment, servedModel, type ProviderEvaluation } from './contract.js';
import { EvaluationError, EvaluationHttpError, retryAfterMs } from './errors.js';
import { boundedResponse } from './transport.js';

function invalidResponse(stage: 'json' | 'answers' = 'answers'): never {
  throw new EvaluationError('invalid_response', 'Cloudflare returned invalid evaluation data.', { stage, category: 'shape' });
}

/** JSON.parse alone silently replaces duplicate question names and probabilities. */
function parseUniqueJson(text: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { invalidResponse('json'); }
  const objects: Array<Set<string> | null> = [];
  // Consume complete strings so brackets inside values cannot affect nesting.
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
      if (!keys || keys.has(key)) invalidResponse('json');
      keys.add(key);
    }
  }
  return parsed;
}

/** Cloudflare internal codes are not HTTP status codes. Never classify text. */
function cloudflareErrorStatus(body: unknown): number | undefined {
  if (!isRecord(body) || !Array.isArray(body.errors) || !isRecord(body.errors[0])) return undefined;
  switch (body.errors[0].code) {
    case 5007: case 3042: return 404;
    case 5018: case 5016: case 3023: case 3041: case 5035: return 403;
    case 3007: case 3008: return 408;
    case 3036: case 3040: return 429;
    default: return undefined;
  }
}

export async function evaluateCloudflare(
  state: AgentState,
  configuration: CloudflareConfiguration,
  signal: AbortSignal,
): Promise<ProviderEvaluation> {
  throwIfInterrupted(signal);
  validateCloudflareAccountId(configuration.accountId);
  const modelPath = cloudflareModelPath(configuration.model);
  const response = await boundedResponse(await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${configuration.accountId}/ai/run/${modelPath}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${configuration.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: configuration.model, state, questions: NATIVE_EVALUATION_QUESTIONS }),
      signal,
      redirect: 'error',
    },
  ), signal);
  let body: unknown;
  try { body = parseUniqueJson(await response.text()); } catch (error) {
    if (!response.ok) throw new EvaluationHttpError(response.status, retryAfterMs(response.headers.get('retry-after')));
    throw error;
  }
  if (!response.ok) {
    // Workers AI documents "no such model" as HTTP 400 with code 5007.
    const status = response.status === 400 && cloudflareErrorStatus(body) === 404 ? 404 : response.status;
    throw new EvaluationHttpError(status, retryAfterMs(response.headers.get('retry-after')));
  }
  if (isRecord(body) && body.success === false) {
    throw new EvaluationHttpError(cloudflareErrorStatus(body) ?? 400, retryAfterMs(response.headers.get('retry-after')));
  }
  if (!isRecord(body) || body.success !== true || !Array.isArray(body.errors) || body.errors.length !== 0 ||
    !isRecord(body.result) || !isRecord(body.result.answers) ||
    body.result.error !== undefined || body.result.refusal !== undefined) invalidResponse();
  const answers = body.result.answers;
  const names = Object.keys(NATIVE_EVALUATION_QUESTIONS);
  if (Object.keys(answers).length !== names.length || names.some((name) => !Object.hasOwn(answers, name))) invalidResponse();
  const nextAction = answers.nextAction;
  return {
    assessment: normalizeAssessment(answers, isRecord(nextAction) ? nextAction.confidence : undefined, true),
    rawAnswers: sanitizeTraceValue(answers),
    servedModel: redactSensitiveText(servedModel(body.result.model)),
  };
}
