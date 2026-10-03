import type { AgentState } from '../types.js';
import type { JevConfiguration } from '../config.js';
import { redactSensitiveText, sanitizeTraceValue } from '../logging/trace.js';
import { EVALUATION_QUESTIONS, isRecord, normalizeAssessment, servedModel, type ProviderEvaluation } from './contract.js';
import { JevEvaluationError, JevHttpError, retryAfterMs } from './errors.js';
import { boundedResponse } from './transport.js';

export const NATIVE_JEV_ENDPOINTS = {
  openrouter: 'https://openrouter.ai/api/alpha/decisions',
  typesafe: 'https://api.typesafe.ai/v1/systemone',
} as const;

export const NATIVE_EVALUATION_QUESTIONS = {
  ...EVALUATION_QUESTIONS,
  taskComplete: { ...EVALUATION_QUESTIONS.taskComplete, type: 'noul' },
  needsMoreInformation: { ...EVALUATION_QUESTIONS.needsMoreInformation, type: 'noul' },
  needsTesting: { ...EVALUATION_QUESTIONS.needsTesting, type: 'noul' },
  stuck: { ...EVALUATION_QUESTIONS.stuck, type: 'noul' },
} as const;

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
  configuration: JevConfiguration & { provider: 'openrouter' | 'typesafe' },
  signal: AbortSignal,
): Promise<ProviderEvaluation> {
  const response = await boundedResponse(await fetch(NATIVE_JEV_ENDPOINTS[configuration.provider], {
    method: 'POST',
    headers: { Authorization: `Bearer ${configuration.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: configuration.model, state, questions: NATIVE_EVALUATION_QUESTIONS }),
    signal,
    redirect: 'error',
  }), signal);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (!response.ok) throw new JevHttpError(response.status, retryAfterMs(response.headers.get('retry-after')));
    throw new JevEvaluationError('invalid_response', 'Jev returned invalid JSON evaluation data.');
  }
  const status = errorStatus(body);
  if (!response.ok || (isRecord(body) && body.error !== undefined)) {
    throw new JevHttpError(status ?? (response.ok ? 400 : response.status), retryAfterMs(response.headers.get('retry-after')));
  }
  if (!isRecord(body) || !isRecord(body.answers)) {
    throw new JevEvaluationError('invalid_response', 'Jev returned invalid evaluation data.');
  }
  const nextAction = body.answers.nextAction;
  return {
    assessment: normalizeAssessment(body.answers, isRecord(nextAction) ? nextAction.confidence : undefined, true),
    rawAnswers: sanitizeTraceValue(body.answers),
    servedModel: redactSensitiveText(servedModel(body.model)),
  };
}
