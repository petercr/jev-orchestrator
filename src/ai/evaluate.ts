import {
  APICallError,
  experimental_evaluate as evaluate,
  InvalidResponseDataError,
  NoSuchModelError,
  RetryError,
  type Experimental_EvaluationModel as EvaluationModel,
} from 'ai';
import type { Action, AgentAssessment, AgentState, EvaluationResult } from '../types.js';
import {
  limitStrings,
  MAX_EVALUATION_COMMAND_OUTPUT_LENGTH,
  MAX_EVALUATION_COMMANDS,
  MAX_EVALUATION_LIST_ITEMS,
  MAX_EVALUATION_TEXT_LENGTH,
  MAX_TASK_LENGTH,
  truncateText,
} from '../limits.js';

export const JEV_EVALUATION_TIMEOUT_MS = 10_000;
export const JEV_EVALUATION_MAX_RETRIES = 1;

export type JevEvaluationErrorCode =
  | 'timeout'
  | 'authentication'
  | 'rate_limit'
  | 'model_unavailable'
  | 'invalid_response'
  | 'service_unavailable'
  | 'request_failed';

export class JevEvaluationError extends Error {
  readonly code: JevEvaluationErrorCode;

  constructor(code: JevEvaluationErrorCode, message: string) {
    super(message);
    this.name = 'JevEvaluationError';
    this.code = code;
  }
}

const ACTION_CRITERIA = {
  SEARCH_REPO: 'Search repository contents to locate relevant code or configuration.',
  READ_FILE: 'Inspect one or more known files before deciding what to change.',
  RUN_COMMAND: 'Run a safe, non-destructive diagnostic command.',
  RUN_TESTS: 'Run an existing test, typecheck, lint, or build validation script.',
  CALL_CODEX: 'Delegate implementation or deeper coding analysis to Codex.',
  CALL_CLAUDE: 'Delegate implementation or deeper coding analysis to Claude Code.',
  ASK_USER: 'Required information or authorization is unavailable and must come from the user.',
  FINISH: 'The requested task is complete and adequately validated.',
} as const;

export function boundAgentStateForEvaluation(state: AgentState): AgentState {
  const { repo } = state;
  return {
    ...state,
    task: truncateText(state.task, MAX_TASK_LENGTH),
    currentGoal: truncateText(state.currentGoal, MAX_EVALUATION_TEXT_LENGTH),
    repo: {
      root: truncateText(repo.root, MAX_EVALUATION_TEXT_LENGTH),
      packageManager: repo.packageManager,
      ...(repo.packageName
        ? { packageName: truncateText(repo.packageName, MAX_EVALUATION_TEXT_LENGTH) }
        : {}),
      scripts: limitStrings(repo.scripts),
      validationScripts: limitStrings(repo.validationScripts),
      ...(repo.gitBranch
        ? { gitBranch: truncateText(repo.gitBranch, MAX_EVALUATION_TEXT_LENGTH) }
        : {}),
      gitStatus: limitStrings(repo.gitStatus),
      topLevelFiles: limitStrings(repo.topLevelFiles),
    },
    filesRead: limitStrings(state.filesRead),
    filesModified: limitStrings(state.filesModified),
    observations: limitStrings(state.observations),
    commandsRun: state.commandsRun.slice(0, MAX_EVALUATION_COMMANDS).map((command) => ({
      command: truncateText(command.command, MAX_EVALUATION_TEXT_LENGTH),
      exitCode: command.exitCode,
      output: truncateText(command.output, MAX_EVALUATION_COMMAND_OUTPUT_LENGTH),
    })),
    tests: {
      ran: state.tests.ran,
      ...(state.tests.passed !== undefined ? { passed: state.tests.passed } : {}),
      ...(state.tests.summary !== undefined
        ? { summary: truncateText(state.tests.summary, MAX_EVALUATION_TEXT_LENGTH) }
        : {}),
    },
    failedApproaches: limitStrings(state.failedApproaches, MAX_EVALUATION_LIST_ITEMS),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function invalidProviderMetadata(): never {
  throw new JevEvaluationError(
    'invalid_response',
    'Jev returned invalid provider metadata.',
  );
}

function getNextActionConfidence(providerMetadata: unknown): number | undefined {
  if (providerMetadata === undefined) return undefined;
  if (!isRecord(providerMetadata)) invalidProviderMetadata();

  const typesafe = providerMetadata.typesafe;
  if (typesafe === undefined) return undefined;
  if (!isRecord(typesafe)) invalidProviderMetadata();

  const confidence = typesafe.confidence;
  if (confidence === undefined) return undefined;
  if (!isRecord(confidence)) invalidProviderMetadata();

  const nextAction = confidence.nextAction;
  if (nextAction === undefined) return undefined;
  if (!isProbability(nextAction)) invalidProviderMetadata();

  return nextAction;
}

function isTimeoutError(error: unknown): boolean {
  return (
    (RetryError.isInstance(error) && error.reason === 'abort') ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
  );
}

function lastEvaluationError(error: unknown): unknown {
  return RetryError.isInstance(error) ? error.lastError : error;
}

function getStatusCode(error: unknown): number | undefined {
  if (APICallError.isInstance(error)) return error.statusCode;
  if (!isRecord(error)) return undefined;
  const statusCode = error.statusCode;
  return typeof statusCode === 'number' && Number.isInteger(statusCode)
    ? statusCode
    : undefined;
}

export function normalizeJevEvaluationError(error: unknown): JevEvaluationError {
  if (error instanceof JevEvaluationError) return error;
  if (isTimeoutError(error)) {
    return new JevEvaluationError(
      'timeout',
      `Jev evaluation timed out after ${JEV_EVALUATION_TIMEOUT_MS / 1000} seconds.`,
    );
  }

  const lastError = lastEvaluationError(error);
  if (InvalidResponseDataError.isInstance(lastError)) {
    return new JevEvaluationError('invalid_response', 'Jev returned invalid evaluation data.');
  }
  if (NoSuchModelError.isInstance(lastError)) {
    return new JevEvaluationError(
      'model_unavailable',
      'The configured Jev model is unavailable. Check ROUTER_MODEL and Gateway access.',
    );
  }

  switch (getStatusCode(lastError)) {
    case 401:
    case 403:
      return new JevEvaluationError(
        'authentication',
        'Jev Gateway authentication or authorization failed. Check AI_GATEWAY_API_KEY and Gateway access.',
      );
    case 404:
      return new JevEvaluationError(
        'model_unavailable',
        'The configured Jev model is unavailable. Check ROUTER_MODEL and Gateway access.',
      );
    case 429:
      return new JevEvaluationError(
        'rate_limit',
        'Jev Gateway rate limit reached. Wait before retrying the evaluation.',
      );
    default: {
      const statusCode = getStatusCode(lastError);
      if (statusCode !== undefined && statusCode >= 500) {
        return new JevEvaluationError(
          'service_unavailable',
          'Jev Gateway is temporarily unavailable. Try the evaluation again later.',
        );
      }
      return new JevEvaluationError(
        'request_failed',
        'Jev evaluation failed. Try the evaluation again later.',
      );
    }
  }
}

export async function evaluateAgentState(
  state: AgentState,
  model: EvaluationModel = process.env.ROUTER_MODEL ?? 'typesafe-ai/jev',
): Promise<EvaluationResult> {
  const startedAt = performance.now();
  const evaluation = evaluate({
    model,
    state: boundAgentStateForEvaluation(state),
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
    maxRetries: JEV_EVALUATION_MAX_RETRIES,
    abortSignal: AbortSignal.timeout(JEV_EVALUATION_TIMEOUT_MS),
    providerOptions: {
      gateway: {
        zeroDataRetention: false,
      },
    },
  });
  let result: Awaited<typeof evaluation>;

  try {
    result = await evaluation;
  } catch (error) {
    throw normalizeJevEvaluationError(error);
  }

  const confidence = getNextActionConfidence(result.providerMetadata);
  const { taskComplete, needsMoreInformation, needsTesting, stuck, nextAction } = result.answers;

  const assessment: AgentAssessment = {
    taskComplete: { probability: taskComplete.probability },
    needsMoreInformation: { probability: needsMoreInformation.probability },
    needsTesting: { probability: needsTesting.probability },
    stuck: { probability: stuck.probability },
    nextAction: {
      choice: nextAction.choice as Action,
      probabilities: nextAction.probabilities ?? {},
      ...(confidence !== undefined ? { confidence } : {}),
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
