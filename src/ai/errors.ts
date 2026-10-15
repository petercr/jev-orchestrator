import { APICallError, InvalidResponseDataError, JSONParseError, NoSuchModelError, RetryError, TypeValidationError } from 'ai';
import { EVALUATION_PROVIDERS } from '../config.js';
import { ACTIONS, type EvaluationProvider } from '../types.js';

export const EVALUATION_TIMEOUT_MS = 10_000;
export const EVALUATION_MAX_RETRIES = 1;

export type EvaluationErrorCode =
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

export type EvaluationFailure = EvaluationDiagnostic & { code: EvaluationErrorCode };

export class EvaluationError extends Error {
  constructor(
    readonly code: EvaluationErrorCode,
    message: string,
    readonly diagnostic: EvaluationDiagnostic = { stage: 'transport', category: 'request' },
  ) {
    super(message);
    this.name = 'EvaluationError';
  }
}

/** Never forward exception messages, causes, response bodies, or headers. */
export function evaluationFailure(error: unknown): EvaluationFailure {
  if (error instanceof EvaluationError) {
    // Select fields explicitly; even a malformed injected exception cannot
    // introduce provider-controlled strings into failure diagnostics.
    const codes: EvaluationErrorCode[] = ['timeout', 'authentication', 'authorization', 'billing', 'rate_limit', 'model_unavailable', 'invalid_response', 'service_unavailable', 'request_failed'];
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
export class EvaluationHttpError extends Error {
  constructor(readonly statusCode: number, readonly retryAfterMs = 250) {
    super('Decision provider request failed.');
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
  if (failure instanceof EvaluationHttpError) return failure.retryAfterMs;
  return APICallError.isInstance(failure) ? retryAfterMs(failure.responseHeaders?.['retry-after']) : 250;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function lastError(error: unknown): unknown {
  let current = RetryError.isInstance(error) ? error.lastError : error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof EvaluationError || InvalidResponseDataError.isInstance(current) ||
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

export function normalizeEvaluationError(error: unknown, provider: EvaluationProvider = 'vercel'): EvaluationError {
  const failure = lastError(error);
  if (failure instanceof EvaluationError) return failure;
  const label = provider === 'vercel' ? 'Gateway' : provider === 'openrouter' ? 'OpenRouter' : 'TypeSafe';
  const settings = EVALUATION_PROVIDERS[provider];
  const credential = [settings.credential, ...settings.credentialAliases].join(' or ');
  if ((RetryError.isInstance(error) && error.reason === 'abort') ||
    (failure instanceof Error && ['AbortError', 'TimeoutError'].includes(failure.name))) {
    return new EvaluationError('timeout', `Decision evaluation timed out after ${EVALUATION_TIMEOUT_MS / 1000} seconds.`);
  }
  if (InvalidResponseDataError.isInstance(failure) || JSONParseError.isInstance(failure) || TypeValidationError.isInstance(failure)) {
    return new EvaluationError('invalid_response', 'Decision provider returned invalid evaluation data.', {
      stage: JSONParseError.isInstance(failure) ? 'json' : 'answers', category: 'shape',
    });
  }
  const status = statusCode(failure);
  if (NoSuchModelError.isInstance(failure) || status === 404) {
    return new EvaluationError('model_unavailable', `The configured decision model is unavailable. Check ROUTER_MODEL and ${label} access.`);
  }
  switch (status) {
    case 401:
      return new EvaluationError('authentication', `${label} rejected the credential. Check ${credential}.`);
    case 403:
      return new EvaluationError('authorization', `${label} denied access. Check account permissions and model/plan eligibility; a valid key and credit balance do not guarantee model access.`);
    case 402:
      return new EvaluationError('billing', `${label} billing prevented evaluation. Check account credits and billing limits.`);
    case 408:
    case 504:
      return new EvaluationError('timeout', `${label} request timed out. Try the evaluation again later.`);
    case 429:
      return new EvaluationError('rate_limit', `${label} rate limit reached. Wait before retrying the evaluation.`);
    default:
      return status !== undefined && status >= 500
        ? new EvaluationError('service_unavailable', `${label} is temporarily unavailable. Try the evaluation again later.`)
        : new EvaluationError('request_failed', 'Decision evaluation failed. Check provider configuration and try again later.');
  }
}

export function isTransientEvaluationError(error: unknown): boolean {
  const failure = lastError(error);
  const status = statusCode(failure);
  return status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599) ||
    (status === undefined && (failure instanceof TypeError || (APICallError.isInstance(failure) && failure.isRetryable)));
}

// Compatibility exports use the same constructors so instanceof remains valid.
export { EvaluationError as JevEvaluationError, EvaluationHttpError as JevHttpError };
export type JevEvaluationErrorCode = EvaluationErrorCode;
export const normalizeJevEvaluationError = normalizeEvaluationError;
export const JEV_EVALUATION_TIMEOUT_MS = EVALUATION_TIMEOUT_MS;
export const JEV_EVALUATION_MAX_RETRIES = EVALUATION_MAX_RETRIES;
