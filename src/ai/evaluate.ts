import {
  experimental_evaluate as evaluate,
  type Experimental_EvaluationModel as EvaluationModel,
} from 'ai';
import type { Action, AgentAssessment, AgentState, EvaluationResult } from '../types.js';

const ACTION_CRITERIA = {
  SEARCH_REPO: 'Search repository contents to locate relevant code or configuration.',
  READ_FILE: 'Inspect one or more known files before deciding what to change.',
  RUN_COMMAND: 'Run a safe, non-destructive diagnostic command.',
  RUN_TESTS: 'Run an existing test, typecheck, lint, or build validation script.',
  CALL_CODEX: 'Delegate implementation or deeper coding analysis to Codex.',
  ASK_USER: 'Required information or authorization is unavailable and must come from the user.',
  FINISH: 'The requested task is complete and adequately validated.',
} as const;

export async function evaluateAgentState(
  state: AgentState,
  model: EvaluationModel = process.env.ROUTER_MODEL ?? 'typesafe-ai/jev',
): Promise<EvaluationResult> {
  const startedAt = performance.now();
  const result = await evaluate({
    model,
    state,
    questions: {
      taskComplete: {
        type: 'boolean',
        instructions: 'Has the original requested coding task been completed and validated?',
        criteria: {
          true: 'The requested outcome exists and available validation supports completion.',
          false: 'Work, evidence, or validation is still missing.',
        },
      },
      needsMoreInformation: {
        type: 'boolean',
        instructions: 'Is information required that cannot be obtained from the repository or safe local inspection?',
      },
      needsTesting: {
        type: 'boolean',
        instructions: 'Should the current implementation or hypothesis be validated now?',
      },
      stuck: {
        type: 'boolean',
        instructions: 'Is the workflow repeating failed approaches or failing to make meaningful progress?',
      },
      nextAction: {
        type: 'choice',
        instructions: 'Which single action would most effectively and safely advance the coding task?',
        criteria: ACTION_CRITERIA,
      },
    },
    providerOptions: {
      gateway: {
        zeroDataRetention: true,
      },
    },
  });

  const confidence = result.providerMetadata?.typesafe?.confidence as
    | Record<string, number>
    | undefined;
  const { taskComplete, needsMoreInformation, needsTesting, stuck, nextAction } = result.answers;

  const assessment: AgentAssessment = {
    taskComplete: { probability: taskComplete.probability },
    needsMoreInformation: { probability: needsMoreInformation.probability },
    needsTesting: { probability: needsTesting.probability },
    stuck: { probability: stuck.probability },
    nextAction: {
      choice: nextAction.choice as Action,
      probabilities: nextAction.probabilities ?? {},
      ...(confidence?.nextAction !== undefined
        ? { confidence: confidence.nextAction }
        : {}),
    },
  };

  return {
    assessment,
    model: typeof model === 'string' ? model : process.env.ROUTER_MODEL ?? 'evaluation-model',
    latencyMs: Math.round(performance.now() - startedAt),
    ...(result.providerMetadata ? { providerMetadata: result.providerMetadata } : {}),
    rawAnswers: result.answers,
  };
}
