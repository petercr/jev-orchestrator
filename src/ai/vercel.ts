import { createGateway, experimental_evaluate as evaluate, type Experimental_EvaluationModel as EvaluationModel } from 'ai';
import type { AgentState } from '../types.js';
import type { JevConfiguration } from '../config.js';
import { sanitizeTraceValue } from '../logging/trace.js';
import { EVALUATION_QUESTIONS, normalizeAssessment, nextActionConfidence, type ProviderEvaluation } from './contract.js';
import { JevEvaluationError } from './errors.js';
import { boundedResponse } from './transport.js';

export async function evaluateVercel(
  state: AgentState,
  configuration: JevConfiguration,
  signal: AbortSignal,
  modelOverride?: EvaluationModel,
): Promise<ProviderEvaluation> {
  const gateway = createGateway({
    apiKey: configuration.apiKey,
    baseURL: 'https://ai-gateway.vercel.sh/v4/ai',
    fetch: async (url, init) => {
      if (String(url) !== 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model') {
        throw new JevEvaluationError('request_failed', 'Unexpected Jev Gateway endpoint.');
      }
      return boundedResponse(await fetch(url, { ...init, redirect: 'error' }), signal);
    },
  });
  const result = await evaluate({
    model: modelOverride ?? gateway.evaluationModel(configuration.model),
    state,
    questions: EVALUATION_QUESTIONS,
    maxRetries: 0,
    abortSignal: signal,
    providerOptions: { gateway: { zeroDataRetention: false } },
  });
  return {
    assessment: normalizeAssessment(result.answers, nextActionConfidence(result.providerMetadata)),
    rawAnswers: sanitizeTraceValue(result.answers),
    ...(result.providerMetadata === undefined ? {} : { providerMetadata: sanitizeTraceValue(result.providerMetadata) }),
    // Gateway's SDK response.modelId echoes the requested alias. It does not
    // identify an upstream served version, so do not invent one here.
  };
}
