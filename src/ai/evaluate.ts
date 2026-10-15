import type { Experimental_EvaluationModel as EvaluationModel } from 'ai';
import { interruptible, RunInterruptedError, throwIfInterrupted, type ExecutionOptions } from '../cancellation.js';
import { resolveEvaluationConfiguration, validateCloudflareAccountId, validateEvaluationModel, type EvaluationConfiguration } from '../config.js';
import { redactSensitiveText, withRedactionSecrets } from '../logging/trace.js';
import type { AgentState, EvaluationResult } from '../types.js';
import { boundAgentStateForEvaluation } from './contract.js';
import {
  evaluationRetryDelay, isTransientEvaluationError, EVALUATION_MAX_RETRIES,
  EVALUATION_TIMEOUT_MS, normalizeEvaluationError,
} from './errors.js';
import { evaluateNative } from './native.js';
import { evaluateVercel } from './vercel.js';
import { evaluateCloudflare } from './cloudflare.js';

export { boundAgentStateForEvaluation } from './contract.js';
export { EvaluationError, EVALUATION_MAX_RETRIES, EVALUATION_TIMEOUT_MS, normalizeEvaluationError } from './errors.js';
export type { EvaluationErrorCode } from './errors.js';
export { JevEvaluationError, JEV_EVALUATION_MAX_RETRIES, JEV_EVALUATION_TIMEOUT_MS, normalizeJevEvaluationError } from './errors.js';
export type { JevEvaluationErrorCode } from './errors.js';

export type Evaluator = (state: AgentState, options?: ExecutionOptions) => Promise<EvaluationResult>;

/** Bind transport credentials and model once, outside serializable run state. */
export function createEvaluator(
  configuration: EvaluationConfiguration = resolveEvaluationConfiguration(),
  modelOverride?: EvaluationModel,
): Evaluator {
  const selected = Object.freeze({ ...configuration, model: typeof modelOverride === 'string' ? modelOverride : configuration.model });
  validateEvaluationModel(selected.provider, selected.model);
  if (selected.provider === 'cloudflare') validateCloudflareAccountId(selected.accountId);
  if (modelOverride !== undefined && typeof modelOverride !== 'string' && selected.provider !== 'vercel') {
    throw new Error('An SDK evaluation model override requires ROUTER_PROVIDER=vercel.');
  }
  return (state, options = {}) => withRedactionSecrets([selected.apiKey], () =>
    evaluateConfiguredState(state, selected, options, typeof modelOverride === 'string' ? undefined : modelOverride));
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfInterrupted(signal);
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new RunInterruptedError());
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function evaluateAgentState(
  state: AgentState,
  model?: EvaluationModel,
  options: ExecutionOptions = {},
): Promise<EvaluationResult> {
  throwIfInterrupted(options.signal);
  return createEvaluator(resolveEvaluationConfiguration(), model)(state, options);
}

async function evaluateConfiguredState(
  state: AgentState,
  configuration: EvaluationConfiguration,
  options: ExecutionOptions,
  modelOverride?: EvaluationModel,
): Promise<EvaluationResult> {
  throwIfInterrupted(options.signal);
  const startedAt = performance.now();
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), EVALUATION_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const snapshot = boundAgentStateForEvaluation(state);
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await interruptible(() => {
          if (configuration.provider === 'cloudflare') return evaluateCloudflare(snapshot, configuration, signal);
          return configuration.provider === 'vercel'
            ? evaluateVercel(snapshot, configuration, signal, modelOverride)
            : evaluateNative(snapshot, { ...configuration, provider: configuration.provider }, signal);
        }, signal);
        throwIfInterrupted(signal);
        return {
          ...result,
          provider: configuration.provider,
          model: redactSensitiveText(configuration.model),
          requestedModel: redactSensitiveText(configuration.model),
          latencyMs: Math.round(performance.now() - startedAt),
        };
      } catch (error) {
        throwIfInterrupted(signal);
        if (attempt >= EVALUATION_MAX_RETRIES || !isTransientEvaluationError(error)) throw error;
        await waitForRetry(evaluationRetryDelay(error), signal);
      }
    }
  } catch (error) {
    throwIfInterrupted(options.signal);
    throw normalizeEvaluationError(deadline.signal.aborted ? new DOMException('', 'TimeoutError') : error, configuration.provider);
  } finally {
    clearTimeout(timeout);
  }
}
