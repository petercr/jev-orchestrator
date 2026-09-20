import {
  appendOrchestrationTrace,
  createOrchestrationTrace,
} from '../logging/trace.js';
import { applyPolicy, DEFAULT_THRESHOLDS } from '../policy.js';
import { truncateText } from '../limits.js';
import type {
  Action,
  AgentState,
  EvaluationResult,
  PolicyDecision,
  RepoSnapshot,
} from '../types.js';
import {
  EXECUTABLE_ACTIONS,
  proposalSignature,
  selectCandidate,
  type CandidateProposal,
  type ExecutableAction,
} from './candidate.js';
import { executeCandidate, type ToolResult } from './execute.js';

export const MAX_ORCHESTRATION_ITERATIONS = 8;
export const MAX_APPROVAL_ALTERNATIVES = 2;
const MAX_OBSERVATION_LENGTH = 2_000;

export type ApprovalDecision =
  | { kind: 'approve' }
  | { kind: 'reject'; reason?: string }
  | { kind: 'alternative'; action: ExecutableAction };

export type ApprovalContext = {
  state: AgentState;
  evaluation: EvaluationResult;
  policy: PolicyDecision;
  proposal: CandidateProposal;
  allowedAlternatives: ExecutableAction[];
};

export type OrchestrationStatus = 'finished' | 'iteration_limit';

export type OrchestrationResult = {
  status: OrchestrationStatus;
  state: AgentState;
  tracePath: string;
  iterations: number;
};

export type OrchestrationDependencies = {
  evaluate: (state: AgentState) => Promise<EvaluationResult>;
  approve: (context: ApprovalContext) => Promise<ApprovalDecision>;
  askForInformation: (state: AgentState) => Promise<string>;
  execute?: typeof executeCandidate;
};

export type OrchestrationOptions = {
  maxIterations?: number;
};

export function createInitialState(repo: RepoSnapshot, task: string): AgentState {
  return {
    task,
    iteration: 1,
    currentGoal: 'Choose the safest useful first action.',
    repo,
    filesRead: [],
    filesModified: [],
    observations: ['Initial repository snapshot collected.'],
    commandsRun: [],
    tests: { ran: false },
    failedApproaches: [],
    codexCalls: 0,
  };
}

function canUserOverrideFinish(
  state: AgentState,
  evaluation: EvaluationResult,
  policy: PolicyDecision,
): boolean {
  if (
    state.repo.validationScripts.length === 0 ||
    state.tests.ran !== true ||
    state.tests.passed !== true ||
    policy.requested !== 'FINISH' ||
    policy.selected !== 'ASK_USER' ||
    evaluation.assessment.needsMoreInformation.probability >= DEFAULT_THRESHOLDS.askUser ||
    evaluation.assessment.stuck.probability >= DEFAULT_THRESHOLDS.askUser
  ) {
    return false;
  }

  const finishProbability = evaluation.assessment.nextAction.probabilities.FINISH ?? 0;
  const confidence = evaluation.assessment.nextAction.confidence ?? 0;
  return finishProbability >= DEFAULT_THRESHOLDS.minChoiceProbability &&
    confidence >= DEFAULT_THRESHOLDS.minChoiceConfidence;
}

function allowedAlternatives(
  state: AgentState,
  evaluation: EvaluationResult,
  policy: PolicyDecision,
): ExecutableAction[] {
  return EXECUTABLE_ACTIONS.filter((action) => {
    if (action === 'FINISH') {
      return policy.selected === 'FINISH' || canUserOverrideFinish(state, evaluation, policy);
    }
    if (action === 'RUN_TESTS') return state.repo.validationScripts.length > 0;
    return true;
  });
}

function rejectionObservation(decision: Extract<ApprovalDecision, { kind: 'reject' }>): string {
  const reason = decision.reason?.trim();
  return reason
    ? `User rejected the proposal: ${truncateText(reason, MAX_OBSERVATION_LENGTH)}`
    : 'User rejected the proposal without executing it.';
}

function commandDescription(proposal: Extract<CandidateProposal, { action: 'RUN_TESTS' }>): string {
  return [proposal.input.command, ...proposal.input.args].join(' ');
}

function isToolResult(value: unknown, action: CandidateProposal['action']): value is ToolResult {
  if (value === null || typeof value !== 'object') return false;
  const result = value as Partial<ToolResult>;
  return result.action === action &&
    typeof result.ok === 'boolean' &&
    (result.exitCode === null || Number.isInteger(result.exitCode)) &&
    typeof result.durationMs === 'number' &&
    Number.isFinite(result.durationMs) &&
    result.durationMs >= 0 &&
    typeof result.timedOut === 'boolean' &&
    typeof result.output === 'string' &&
    Array.isArray(result.files) &&
    result.files.every((file) => typeof file === 'string');
}

async function safelyExecute(
  proposal: Exclude<CandidateProposal, { action: 'ASK_USER' | 'FINISH' }>,
  execute: typeof executeCandidate,
): Promise<ToolResult> {
  const startedAt = performance.now();
  try {
    const result: unknown = await execute(proposal);
    if (!isToolResult(result, proposal.action)) {
      throw new Error('The tool executor returned a malformed result.');
    }
    return result;
  } catch (error) {
    return {
      action: proposal.action,
      ok: false,
      exitCode: null,
      durationMs: Math.round(performance.now() - startedAt),
      timedOut: false,
      output: truncateText(
        error instanceof Error ? error.message : 'Tool execution failed.',
        MAX_OBSERVATION_LENGTH,
      ),
      files: [],
    };
  }
}

function applyToolResult(
  state: AgentState,
  proposal: CandidateProposal,
  result: ToolResult,
): AgentState {
  const signature = proposalSignature(proposal);
  const observations = [...state.observations];
  const failedApproaches = [...state.failedApproaches];
  let filesRead = state.filesRead;
  let commandsRun = state.commandsRun;
  let tests = state.tests;
  let currentGoal = state.currentGoal;

  if (!result.ok) {
    failedApproaches.push(signature);
    observations.push(`${proposal.action} failed: ${truncateText(result.output, MAX_OBSERVATION_LENGTH)}`);
    currentGoal = 'Gather information before retrying a failed approach.';
  } else if (proposal.action === 'SEARCH_REPO') {
    const summary = result.files.length > 0 ? result.files.join(', ') : 'no matching files';
    observations.push(`Search completed: ${truncateText(summary, MAX_OBSERVATION_LENGTH)}`);
    currentGoal = 'Inspect a safe repository file informed by the search.';
  } else if (proposal.action === 'READ_FILE') {
    filesRead = [...new Set([...state.filesRead, ...result.files])];
    observations.push(`Read ${result.files[0] ?? proposal.input.path}: ${truncateText(result.output, MAX_OBSERVATION_LENGTH)}`);
    currentGoal = 'Validate the repository after inspection.';
  } else if (proposal.action === 'RUN_TESTS') {
    const summary = truncateText(result.output, MAX_OBSERVATION_LENGTH);
    commandsRun = [...state.commandsRun, {
      command: commandDescription(proposal),
      exitCode: result.exitCode ?? 1,
      output: summary,
    }];
    tests = { ran: true, passed: true, summary };
    observations.push(`Validation passed: ${summary}`);
    currentGoal = 'Determine whether the requested task is complete.';
  }

  if (proposal.action === 'RUN_TESTS' && !result.ok) {
    const summary = truncateText(result.output, MAX_OBSERVATION_LENGTH);
    commandsRun = [...state.commandsRun, {
      command: commandDescription(proposal),
      exitCode: result.exitCode ?? 1,
      output: summary,
    }];
    tests = { ran: true, passed: false, summary };
  }

  return {
    ...state,
    currentGoal,
    filesRead,
    observations,
    commandsRun,
    tests,
    failedApproaches,
  };
}

async function resolveApproval(
  initialProposal: CandidateProposal,
  state: AgentState,
  evaluation: EvaluationResult,
  policy: PolicyDecision,
  approve: OrchestrationDependencies['approve'],
  searchResults: string[],
): Promise<{
  proposals: CandidateProposal[];
  proposal: CandidateProposal;
  decision: ApprovalDecision;
  decisions: ApprovalDecision[];
}> {
  const proposals = [initialProposal];
  const decisions: ApprovalDecision[] = [];
  let proposal = initialProposal;

  for (let attempt = 0; attempt <= MAX_APPROVAL_ALTERNATIVES; attempt += 1) {
    const alternatives = allowedAlternatives(state, evaluation, policy);
    const decision = await approve({
      state,
      evaluation,
      policy,
      proposal,
      allowedAlternatives: alternatives,
    });
    decisions.push(decision);
    if (decision.kind !== 'alternative') return { proposals, proposal, decision, decisions };
    if (!alternatives.includes(decision.action)) {
      const rejection: ApprovalDecision = {
        kind: 'reject',
        reason: `${decision.action} is not a permitted alternative.`,
      };
      decisions.push(rejection);
      return {
        proposals,
        proposal,
        decision: rejection,
        decisions,
      };
    }
    proposal = await selectCandidate(decision.action, state, searchResults);
    proposals.push(proposal);
  }

  const rejection: ApprovalDecision = {
    kind: 'reject',
    reason: 'Too many alternative selections.',
  };
  decisions.push(rejection);
  return {
    proposals,
    proposal,
    decision: rejection,
    decisions,
  };
}

function repeatedFailureProposal(proposal: CandidateProposal, state: AgentState): CandidateProposal {
  if (!state.failedApproaches.includes(proposalSignature(proposal))) return proposal;
  return {
    action: 'ASK_USER',
    tool: null,
    input: null,
    reason: 'The same resolved candidate already failed; policy requires new information.',
  };
}

export async function runOrchestration(
  initialState: AgentState,
  dependencies: OrchestrationDependencies,
  options: OrchestrationOptions = {},
): Promise<OrchestrationResult> {
  const maxIterations = options.maxIterations ?? MAX_ORCHESTRATION_ITERATIONS;
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > MAX_ORCHESTRATION_ITERATIONS) {
    throw new Error(`Iteration limit must be between 1 and ${MAX_ORCHESTRATION_ITERATIONS}.`);
  }

  const trace = await createOrchestrationTrace(initialState.repo.root);
  const execute = dependencies.execute ?? executeCandidate;
  let state = initialState;
  let searchResults: string[] = [];

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    state = { ...state, iteration };
    const stateBefore = state;
    const evaluation = await dependencies.evaluate(state);
    const policy = applyPolicy(state, evaluation.assessment);
    const selected = repeatedFailureProposal(
      await selectCandidate(policy.selected, state, searchResults),
      state,
    );
    const approval = await resolveApproval(
      selected,
      state,
      evaluation,
      policy,
      dependencies.approve,
      searchResults,
    );
    const { proposal, decision } = approval;
    let toolResult: ToolResult | null = null;
    let nextState = state;
    let finished = false;

    if (decision.kind === 'reject') {
      nextState = {
        ...state,
        observations: [...state.observations, rejectionObservation(decision)],
        currentGoal: 'Choose a permitted alternative after user rejection.',
      };
    } else if (proposal.action === 'ASK_USER') {
      const information = truncateText(
        (await dependencies.askForInformation(state)).trim(),
        MAX_OBSERVATION_LENGTH,
      );
      nextState = {
        ...state,
        observations: [
          ...state.observations,
          information ? `User supplied information: ${information}` : 'User supplied no additional information.',
        ],
        currentGoal: 'Reassess the task with the user response.',
      };
    } else if (proposal.action === 'FINISH') {
      finished = true;
      const completionObservation = policy.selected === 'FINISH'
        ? 'User approved completion.'
        : 'User explicitly overrode completion confidence after passing validation.';
      nextState = {
        ...state,
        observations: [...state.observations, completionObservation],
        currentGoal: 'Task complete.',
      };
    } else {
      toolResult = await safelyExecute(proposal, execute);
      if (proposal.action === 'SEARCH_REPO' && toolResult.ok) searchResults = toolResult.files;
      nextState = applyToolResult(state, proposal, toolResult);
    }

    const reachedLimit = !finished && iteration === maxIterations;
    if (reachedLimit) {
      nextState = {
        ...nextState,
        observations: [...nextState.observations, `Stopped at the ${maxIterations}-iteration limit.`],
        currentGoal: 'Ask the user how to continue after the iteration limit.',
      };
    }

    await appendOrchestrationTrace(trace, {
      iteration,
      stateBefore,
      evaluation,
      policy,
      proposal: { considered: approval.proposals, selected: structuredClone(proposal) },
      approval: { ...decision, history: approval.decisions },
      toolInput: proposal.input,
      toolResult,
      stateAfter: nextState,
    });
    state = nextState;

    if (finished) {
      return {
        status: 'finished',
        state,
        tracePath: trace.path,
        iterations: iteration,
      };
    }
  }

  return {
    status: 'iteration_limit',
    state,
    tracePath: trace.path,
    iterations: maxIterations,
  };
}
