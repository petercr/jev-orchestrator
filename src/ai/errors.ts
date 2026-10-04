import { APICallError, InvalidResponseDataError, JSONParseError, NoSuchModelError, RetryError, TypeValidationError } from 'ai';
import { JEV_PROVIDERS } from '../config.js';
import { ACTIONS, type JevProvider } from '../types.js';

export const JEV_EVALUATION_TIMEOUT_MS = 10_000;
export const JEV_EVALUATION_MAX_RETRIES = 1;

export type JevEvaluationErrorCode =
  | 'timeout'
  | 'authentication'
  | 'authorization'
  | 'billing'
  | 'rate_limit'
  | 'model_unavailable'
  | 'invalid_response'
  | 'service_unavailable'
  | 'request_failed';

export type EvaluationDiagnostic = {
  stage: 'transport' | 'json' | 'answers' | 'next_action' | 'distribution' | 'confidence' | 'metadata' | 'model';
  category: 'request' | 'shape' | 'value' | 'sum' | 'choice' | 'missing_action' | 'unknown_action' | 'size';
  field?: 'taskComplete' | 'needsMoreInformation' | 'needsTesting' | 'stuck';
  probabilitySum?: number;
};

export type EvaluationFailure = EvaluationDiagnostic & { code: JevEvaluationErrorCode };

export class JevEvaluationError extends Error {
  constructor(
    readonly code: JevEvaluationErrorCode,
    message: string,
    readonly diagnostic: EvaluationDiagnostic = { stage: 'transport', category: 'request' },
  ) {
    super(message);
    this.name = 'JevEvaluationError';
  }
}

/** Never forward exception messages, causes, response bodies, or headers. */
export function evaluationFailure(error: unknown): EvaluationFailure {
  if (error instanceof JevEvaluationError) {
    // Select fields explicitly; even a malformed injected exception cannot
    // introduce provider-controlled strings into failure diagnostics.
    const codes: JevEvaluationErrorCode[] = ['timeout', 'authentication', 'authorization', 'billing', 'rate_limit', 'model_unavailable', 'invalid_response', 'service_unavailable', 'request_failed'];
    const stages: EvaluationDiagnostic['stage'][] = ['transport', 'json', 'answers', 'next_action', 'distribution', 'confidence', 'metadata', 'model'];
    const categories: EvaluationDiagnostic['category'][] = ['request', 'shape', 'value', 'sum', 'choice', 'missing_action', 'unknown_action', 'size'];
    const fields: NonNullable<EvaluationDiagnostic['field']>[] = ['taskComplete', 'needsMoreInformation', 'needsTesting', 'stuck'];
    const probabilitySum = error.diagnostic?.probabilitySum;
    return {
      code: codes.includes(error.code) ? error.code : 'request_failed',
      stage: stages.includes(error.diagnostic?.stage) ? error.diagnostic.stage : 'transport',
      category: categories.includes(error.diagnostic?.category) ? error.diagnostic.category : 'request',
      ...(error.diagnostic?.field && fields.includes(error.diagnostic.field) ? { field: error.diagnostic.field } : {}),
      ...(error.code === 'invalid_response' && error.diagnostic?.stage === 'distribution' &&
        error.diagnostic.category === 'sum' && typeof probabilitySum === 'number' &&
        Number.isFinite(probabilitySum) && probabilitySum >= 0 && probabilitySum <= ACTIONS.length
        ? { probabilitySum } : {}),
    };
  }
  return { code: 'request_failed', stage: 'transport', category: 'request' };
}

/** Only status and allowlisted classifications survive the transport boundary. */
export class JevHttpError extends Error {
  constructor(readonly statusCode: number, readonly retryAfterMs = 250) {
    super('Jev provider request failed.');
  }
}

export function retryAfterMs(value: string | null | undefined): number {
  if (!value) return 250;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(250, Math.min(delay, 60_000)) : 250;
}

export function evaluationRetryDelay(error: unknown): number {
  const failure = lastError(error);
  if (failure instanceof JevHttpError) return failure.retryAfterMs;
  return APICallError.isInstance(failure) ? retryAfterMs(failure.responseHeaders?.['retry-after']) : 250;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function lastError(error: unknown): unknown {
  let current = RetryError.isInstance(error) ? error.lastError : error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof JevEvaluationError || InvalidResponseDataError.isInstance(current) ||
      JSONParseError.isInstance(current) || TypeValidationError.isInstance(current)) return current;
    // SDKs wrap local parsing/fetch errors. Keep the HTTP status authoritative
    // for actual HTTP failures and only unwrap successful-response/local errors.
    const status = statusCode(current);
    if (APICallError.isInstance(current) && status !== undefined && status >= 400) return current;
    if (!isRecord(current) || current.cause === undefined) break;
    current = current.cause;
  }
  return current;
}

function statusCode(error: unknown): number | undefined {
  if (APICallError.isInstance(error)) return error.statusCode;
  if (!isRecord(error)) return undefined;
  return typeof error.statusCode === 'number' ? error.statusCode : undefined;
}

export function normalizeJevEvaluationError(error: unknown, provider: JevProvider = 'vercel'): JevEvaluationError {
  const failure = lastError(error);
  if (failure instanceof JevEvaluationError) return failure;
  const label = provider === 'vercel' ? 'Gateway' : provider === 'openrouter' ? 'OpenRouter' : 'TypeSafe';
  const settings = JEV_PROVIDERS[provider];
  const credential = [settings.credential, ...settings.credentialAliases].join(' or ');
  if ((RetryError.isInstance(error) && error.reason === 'abort') ||
    (failure instanceof Error && ['AbortError', 'TimeoutError'].includes(failure.name))) {
    return new JevEvaluationError('timeout', `Jev evaluation timed out after ${JEV_EVALUATION_TIMEOUT_MS / 1000} seconds.`);
  }
  if (InvalidResponseDataError.isInstance(failure) || JSONParseError.isInstance(failure) || TypeValidationError.isInstance(failure)) {
    return new JevEvaluationError('invalid_response', 'Jev returned invalid evaluation data.', {
      stage: JSONParseError.isInstance(failure) ? 'json' : 'answers', category: 'shape',
    });
  }
  const status = statusCode(failure);
  if (NoSuchModelError.isInstance(failure) || status === 404) {
    return new JevEvaluationError('model_unavailable', `The configured Jev model is unavailable. Check ROUTER_MODEL and ${label} access.`);
  }
  switch (status) {
    case 401:
      return new JevEvaluationError('authentication', `Jev ${label} rejected the credential. Check ${credential}.`);
    case 403:
      return new JevEvaluationError('authorization', `Jev ${label} denied access. Check account permissions and model/plan eligibility; a valid key and credit balance do not guarantee model access.`);
    case 402:
      return new JevEvaluationError('billing', `Jev ${label} billing prevented evaluation. Check account credits and billing limits.`);
    case 408:
    case 504:
      return new JevEvaluationError('timeout', `Jev ${label} request timed out. Try the evaluation again later.`);
    case 429:
      return new JevEvaluationError('rate_limit', `Jev ${label} rate limit reached. Wait before retrying the evaluation.`);
    default:
      return status !== undefined && status >= 500
        ? new JevEvaluationError('service_unavailable', `Jev ${label} is temporarily unavailable. Try the evaluation again later.`)
        : new JevEvaluationError('request_failed', 'Jev evaluation failed. Check provider configuration and try again later.');
  }
}

export function isTransientEvaluationError(error: unknown): boolean {
  const failure = lastError(error);
  const status = statusCode(failure);
  return status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599) ||
    (status === undefined && (failure instanceof TypeError || (APICallError.isInstance(failure) && failure.isRetryable)));
}
