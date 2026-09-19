import {
  APICallError,
  experimental_evaluate as evaluate,
  InvalidResponseDataError,
  NoSuchModelError,
  RetryError,
} from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateAgentState,
  JevEvaluationError,
  JEV_EVALUATION_MAX_RETRIES,
  JEV_EVALUATION_TIMEOUT_MS,
  normalizeJevEvaluationError,
} from './evaluate.js';
import type { AgentState } from '../types.js';

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, experimental_evaluate: vi.fn() };
});

const state: AgentState = {
  task: 'Inspect the repository',
  iteration: 1,
  currentGoal: 'Choose the next action',
  repo: {
    root: '/repo',
    packageManager: 'pnpm',
    scripts: ['test'],
    validationScripts: ['test'],
    gitStatus: [],
    topLevelFiles: ['package.json'],
  },
  filesRead: [],
  filesModified: [],
  observations: [],
  commandsRun: [],
  tests: { ran: false },
  failedApproaches: [],
  codexCalls: 0,
};

function evaluationResult(providerMetadata: unknown = {
  typesafe: { confidence: { nextAction: 0.73 } },
}): never {
  return {
    answers: {
      taskComplete: { type: 'boolean', probability: 0.02 },
      needsMoreInformation: { type: 'boolean', probability: 0.08 },
      needsTesting: { type: 'boolean', probability: 0.09 },
      stuck: { type: 'boolean', probability: 0.01 },
      nextAction: {
        type: 'choice',
        choice: 'SEARCH_REPO',
        probabilities: { SEARCH_REPO: 1 },
      },
    },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    warnings: [],
    rounding: undefined,
    providerMetadata,
    response: { timestamp: new Date(), modelId: 'typesafe-ai/jev' },
  } as never;
}

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: 'upstream response included a secret value',
    url: 'https://ai-gateway.example.test',
    requestBodyValues: { apiKey: 'secret-value' },
    statusCode,
  });
}

describe('evaluateAgentState', () => {
  const evaluateMock = vi.mocked(evaluate);

  beforeEach(() => {
    evaluateMock.mockReset();
  });

  it('passes a bounded request policy and normalizes valid confidence metadata', async () => {
    evaluateMock.mockResolvedValue(evaluationResult());

    const result = await evaluateAgentState(state);

    const request = evaluateMock.mock.calls[0]?.[0];
    expect(request?.maxRetries).toBe(JEV_EVALUATION_MAX_RETRIES);
    expect(request?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(request?.providerOptions).toEqual({ gateway: { zeroDataRetention: false } });
    expect(result.assessment.nextAction.confidence).toBe(0.73);
  });

  it('rejects malformed TypeSafe confidence metadata', async () => {
    evaluateMock.mockResolvedValue(
      evaluationResult({ typesafe: { confidence: { nextAction: '0.73' } } }),
    );

    await expect(evaluateAgentState(state)).rejects.toMatchObject({
      code: 'invalid_response',
      message: 'Jev returned invalid provider metadata.',
    });
  });

  it('rethrows provider failures as safe local errors', async () => {
    evaluateMock.mockRejectedValue(apiError(429));

    await expect(evaluateAgentState(state)).rejects.toMatchObject({
      code: 'rate_limit',
      message: 'Jev Gateway rate limit reached. Wait before retrying the evaluation.',
    });
  });
});

describe('normalizeJevEvaluationError', () => {
  it.each([
    [apiError(401), 'authentication'],
    [apiError(429), 'rate_limit'],
    [apiError(404), 'model_unavailable'],
    [apiError(503), 'service_unavailable'],
    [
      new NoSuchModelError({ modelId: 'typesafe-ai/missing', modelType: 'evaluationModel' }),
      'model_unavailable',
    ],
    [new InvalidResponseDataError({ data: { task: 'private task details' } }), 'invalid_response'],
    [new DOMException('timed out', 'TimeoutError'), 'timeout'],
  ] as const)('maps %s to %s without exposing upstream details', (error, code) => {
    const normalized = normalizeJevEvaluationError(error);

    expect(normalized).toBeInstanceOf(JevEvaluationError);
    expect(normalized.code).toBe(code);
    expect(normalized.message).not.toContain('secret');
    expect(normalized.message).not.toContain('private task');
  });

  it('uses the final retry failure to classify a transient request', () => {
    const normalized = normalizeJevEvaluationError(
      new RetryError({
        message: 'retry request body with secret value',
        reason: 'maxRetriesExceeded',
        errors: [apiError(429)],
      }),
    );

    expect(normalized.code).toBe('rate_limit');
  });

  it('uses a safe fallback for unrecognized failures', () => {
    const normalized = normalizeJevEvaluationError(new Error('token=secret-value'));

    expect(normalized.code).toBe('request_failed');
    expect(normalized.message).not.toContain('secret-value');
  });

  it('reports the configured deadline', () => {
    expect(normalizeJevEvaluationError(new DOMException('', 'TimeoutError')).message).toContain(
      `${JEV_EVALUATION_TIMEOUT_MS / 1000} seconds`,
    );
  });
});
