import { ACTIONS, type Action, type AgentAssessment, type AgentState } from '../types.js';
import { JevEvaluationError } from './errors.js';
import { redactSensitiveText } from '../logging/trace.js';
import {
  limitStrings,
  MAX_EVALUATION_COMMAND_OUTPUT_LENGTH,
  MAX_EVALUATION_COMMANDS,
  MAX_EVALUATION_LIST_ITEMS,
  MAX_EVALUATION_TEXT_LENGTH,
  MAX_TASK_LENGTH,
  truncateText,
} from '../limits.js';

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

export type ProviderEvaluation = {
  assessment: AgentAssessment;
  rawAnswers: unknown;
  providerMetadata?: unknown;
  servedModel?: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function invalidAnswer(): never {
  throw new JevEvaluationError('invalid_response', 'Jev returned invalid evaluation data.');
}

function booleanAnswer(answers: Record<string, unknown>, key: string, native: boolean): { probability: number } {
  const answer = answers[key];
  if (!isRecord(answer) || answer.type !== (native ? 'noul' : 'boolean')) invalidAnswer();
  const probability = answer[native ? 'noul' : 'probability'];
  if (!isProbability(probability)) invalidAnswer();
  return { probability };
}

function isAction(value: unknown): value is Action {
  return typeof value === 'string' && ACTIONS.some((action) => action === value);
}

export function normalizeAssessment(answers: unknown, confidence: unknown, native = false): AgentAssessment {
  if (!isRecord(answers)) invalidAnswer();
  const nextAction = answers.nextAction;
  if (!isRecord(nextAction) || nextAction.type !== 'choice' || !isAction(nextAction.choice)) invalidAnswer();
  if (!isRecord(nextAction.probabilities)) invalidAnswer();
  const choice = nextAction.choice;
  const probabilities: Partial<Record<Action, number>> = {};
  let total = 0;
  for (const [action, probability] of Object.entries(nextAction.probabilities)) {
    if (!isAction(action) || !isProbability(probability)) invalidAnswer();
    probabilities[action] = probability;
    total += probability;
  }
  // The SDK can omit zero-probability options; native APIs promise every option.
  if ((native && ACTIONS.some((action) => probabilities[action] === undefined)) ||
    Math.abs(total - 1) > 0.001 ||
    probabilities[choice] === undefined ||
    Object.values(probabilities).some((probability) => probability > (probabilities[choice] ?? 0))) {
    invalidAnswer();
  }
  if (confidence !== undefined && !isProbability(confidence)) {
    throw new JevEvaluationError('invalid_response', 'Jev returned invalid provider metadata.');
  }
  return {
    taskComplete: booleanAnswer(answers, 'taskComplete', native),
    needsMoreInformation: booleanAnswer(answers, 'needsMoreInformation', native),
    needsTesting: booleanAnswer(answers, 'needsTesting', native),
    stuck: booleanAnswer(answers, 'stuck', native),
    nextAction: {
      choice: nextAction.choice,
      probabilities,
      ...(confidence === undefined ? {} : { confidence }),
    },
  };
}

export function nextActionConfidence(metadata: unknown): unknown {
  if (metadata === undefined) return undefined;
  if (!isRecord(metadata)) invalidAnswer();
  const typesafe = metadata.typesafe;
  if (typesafe === undefined) return undefined;
  if (!isRecord(typesafe)) invalidAnswer();
  if (typesafe.confidence === undefined) return undefined;
  if (!isRecord(typesafe.confidence)) invalidAnswer();
  return typesafe.confidence.nextAction;
}

export function servedModel(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\s\x00-\x1f\x7f]/.test(value)) invalidAnswer();
  return value;
}

function boundedText(value: string, limit: number): string {
  return truncateText(redactSensitiveText(value), limit);
}

function boundedStrings(values: string[], limit = MAX_EVALUATION_LIST_ITEMS): string[] {
  return limitStrings(values.slice(0, limit).map((value) => redactSensitiveText(value)), limit);
}

export function boundAgentStateForEvaluation(state: AgentState): AgentState {
  const { repo, evidence: _evidence, ...boundedState } = state;
  return {
    ...boundedState,
    task: boundedText(state.task, MAX_TASK_LENGTH),
    currentGoal: boundedText(state.currentGoal, MAX_EVALUATION_TEXT_LENGTH),
    repo: {
      root: boundedText(repo.root, MAX_EVALUATION_TEXT_LENGTH),
      packageManager: repo.packageManager,
      ...(repo.packageName
        ? { packageName: boundedText(repo.packageName, MAX_EVALUATION_TEXT_LENGTH) }
        : {}),
      scripts: boundedStrings(repo.scripts),
      validationScripts: boundedStrings(repo.validationScripts),
      ...(repo.gitBranch
        ? { gitBranch: boundedText(repo.gitBranch, MAX_EVALUATION_TEXT_LENGTH) }
        : {}),
      gitStatus: boundedStrings(repo.gitStatus),
      topLevelFiles: boundedStrings(repo.topLevelFiles),
    },
    filesRead: boundedStrings(state.filesRead),
    filesModified: boundedStrings(state.filesModified),
    observations: boundedStrings(state.observations),
    commandsRun: state.commandsRun.slice(0, MAX_EVALUATION_COMMANDS).map((command) => ({
      command: boundedText(command.command, MAX_EVALUATION_TEXT_LENGTH),
      exitCode: command.exitCode,
      output: boundedText(command.output, MAX_EVALUATION_COMMAND_OUTPUT_LENGTH),
    })),
    tests: {
      ran: state.tests.ran,
      ...(state.tests.passed !== undefined ? { passed: state.tests.passed } : {}),
      ...(state.tests.summary !== undefined
        ? { summary: boundedText(state.tests.summary, MAX_EVALUATION_TEXT_LENGTH) }
        : {}),
    },
    failedApproaches: boundedStrings(state.failedApproaches, MAX_EVALUATION_LIST_ITEMS),
  };
}

export const EVALUATION_QUESTIONS = {
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
} as const;
