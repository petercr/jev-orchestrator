import type { AgentState } from '../types.js';
import type { EvaluationConfiguration } from '../config.js';
import { redactSensitiveText, sanitizeTraceValue } from '../logging/trace.js';
import { NATIVE_EVALUATION_QUESTIONS, isRecord, normalizeAssessment, servedModel, type ProviderEvaluation } from './contract.js';
import { EvaluationError, EvaluationHttpError, retryAfterMs } from './errors.js';
import { boundedResponse, parseEvaluationJson } from './transport.js';

export const NATIVE_EVALUATION_ENDPOINTS = {
  openrouter: 'https://openrouter.ai/api/alpha/decisions',
  typesafe: 'https://api.typesafe.ai/v1/systemone',
} as const;

export const NATIVE_JEV_ENDPOINTS = NATIVE_EVALUATION_ENDPOINTS;

export { NATIVE_EVALUATION_QUESTIONS } from './contract.js';

function errorStatus(body: unknown): number | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  const code = body.error.code;
  if (typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599) return code;
  const metadata = isRecord(body.error.metadata) ? body.error.metadata : {};
  const kind = body.error.error_type ?? body.error.type ?? metadata.error_type ?? code;
  switch (kind) {
    case 'invalid_api_key': case 'authentication_error': return 401;
    case 'permission_error': case 'insufficient_permissions': return 403;
    case 'insufficient_credits': case 'billing_error': return 402;
    case 'model_not_found': case 'model_unavailable': return 404;
    case 'rate_limit_exceeded': return 429;
    case 'server': case 'overloaded_error': return 503;
    default: return undefined;
  }
}

export async function evaluateNative(
  state: AgentState,
  configuration: EvaluationConfiguration & { provider: 'openrouter' | 'typesafe' },
  signal: AbortSignal,
): Promise<ProviderEvaluation> {
  const response = await boundedResponse(await fetch(NATIVE_EVALUATION_ENDPOINTS[configuration.provider], {
    method: 'POST',
    headers: { Authorization: `Bearer ${configuration.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: configuration.model, state, questions: NATIVE_EVALUATION_QUESTIONS }),
    signal,
    redirect: 'error',
  }), signal);
  let body: unknown;
  try {
    body = parseEvaluationJson(await response.text());
  } catch {
    if (!response.ok) throw new EvaluationHttpError(response.status, retryAfterMs(response.headers.get('retry-after')));
    throw new EvaluationError('invalid_response', 'Decision provider returned invalid JSON evaluation data.', { stage: 'json', category: 'shape' });
  }
  if (!response.ok || (isRecord(body) && body.error !== undefined)) {
    throw new EvaluationHttpError(response.ok ? errorStatus(body) ?? 400 : response.status, retryAfterMs(response.headers.get('retry-after')));
  }
  if (!isRecord(body) || body.refusal !== undefined || !isRecord(body.answers)) {
    throw new EvaluationError('invalid_response', 'Decision provider returned invalid evaluation data.', { stage: 'answers', category: 'shape' });
  }
  const nextAction = body.answers.nextAction;
  return {
    assessment: normalizeAssessment(body.answers, isRecord(nextAction) ? nextAction.confidence : undefined, true),
    rawAnswers: sanitizeTraceValue(body.answers),
    servedModel: redactSensitiveText(servedModel(body.model)),
  };
}
