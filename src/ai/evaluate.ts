import type { Experimental_EvaluationModel as EvaluationModel } from 'ai';
import { interruptible, RunInterruptedError, throwIfInterrupted, type ExecutionOptions } from '../cancellation.js';
import { resolveJevConfiguration } from '../config.js';
import { redactSensitiveText } from '../logging/trace.js';
import type { AgentState, EvaluationResult } from '../types.js';
import { boundAgentStateForEvaluation } from './contract.js';
import {
  evaluationRetryDelay, isTransientEvaluationError, JEV_EVALUATION_MAX_RETRIES,
  JEV_EVALUATION_TIMEOUT_MS, normalizeJevEvaluationError,
} from './errors.js';
import { evaluateNative } from './native.js';
import { evaluateVercel } from './vercel.js';

export { boundAgentStateForEvaluation } from './contract.js';
export { JevEvaluationError, JEV_EVALUATION_MAX_RETRIES, JEV_EVALUATION_TIMEOUT_MS, normalizeJevEvaluationError } from './errors.js';
export type { JevEvaluationErrorCode } from './errors.js';

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
  const configuration = resolveJevConfiguration();
  if (typeof model === 'string') configuration.model = model;
  if (model !== undefined && typeof model !== 'string' && configuration.provider !== 'vercel') {
    throw new Error('An SDK evaluation model override requires JEV_PROVIDER=vercel.');
  }
  const startedAt = performance.now();
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), JEV_EVALUATION_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const snapshot = boundAgentStateForEvaluation(state);
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await interruptible(() => configuration.provider === 'vercel'
          ? evaluateVercel(snapshot, configuration, signal, typeof model === 'string' ? undefined : model)
          : evaluateNative(snapshot, { ...configuration, provider: configuration.provider }, signal), signal);
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
        if (attempt >= JEV_EVALUATION_MAX_RETRIES || !isTransientEvaluationError(error)) throw error;
        await waitForRetry(evaluationRetryDelay(error), signal);
      }
    }
  } catch (error) {
    throwIfInterrupted(options.signal);
    throw normalizeJevEvaluationError(deadline.signal.aborted ? new DOMException('', 'TimeoutError') : error, configuration.provider);
  } finally {
    clearTimeout(timeout);
  }
}
