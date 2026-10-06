import { interruptible, throwIfInterrupted, RunInterruptedError, type ExecutionOptions } from '../cancellation.js';
import {
  appendOrchestrationTrace,
  createOrchestrationTrace,
  type InterruptionPhase,
} from '../logging/trace.js';
import { applyPolicy } from '../policy.js';
import { requiresTaskPreparation, taskPreparation } from '../repo/preparation.js';
import { truncateText } from '../limits.js';
import { inspectRepo } from '../repo/inspect.js';
import { isIssueContext, parseGitHubIssue } from '../repo/issue.js';
import { hasFailedValidation, hasPassedValidation, pendingValidationScripts, selectPendingValidation } from '../repo/validation.js';
import { evaluationFailure, type EvaluationFailure } from '../ai/errors.js';
import { isWorkerActionAllowed } from '../agents/selection.js';
import type {
  Action,
  AgentEvidence,
  AgentState,
  EvaluationResult,
  PolicyDecision,
  RepoSnapshot,
  WorkerSelection,
} from '../types.js';
import {
  EXECUTABLE_ACTIONS,
  MAX_CLAUDE_CALLS,
  MAX_CODEX_CALLS,
  proposalSignature,
  selectCandidate,
  type CandidateProposal,
  type ExecutableAction,
} from './candidate.js';
import { executeCandidate, type ToolResult } from './execute.js';
import { createRunMetrics, executionTimingPhase, type RunMetricsCollector, type RunSummary } from './summary.js';

export const MAX_ORCHESTRATION_ITERATIONS = 8;
export const MAX_APPROVAL_ALTERNATIVES = 2;
const MAX_OBSERVATION_LENGTH = 2_000;

export type ApprovalDecision =
  | { kind: 'approve' }
  | { kind: 'reject'; reason?: string }
  | { kind: 'stop'; reason?: string }
  | { kind: 'alternative'; action: ExecutableAction };

export type ApprovalContext = {
  state: AgentState;
  evaluation: EvaluationResult;
  policy: PolicyDecision;
  proposal: CandidateProposal;
  allowedAlternatives: ExecutableAction[];
};

export type OrchestrationStatus = 'finished' | 'stopped' | 'iteration_limit' | 'evaluation_failed';

export type OrchestrationResult = {
  status: OrchestrationStatus;
  state: AgentState;
  tracePath: string;
  iterations: number;
  summary: RunSummary;
  exitCode?: number;
  failure?: EvaluationFailure;
};

export type EvaluationRecoveryContext = {
  state: AgentState;
  failure: EvaluationFailure;
  remainingIterations: number;
  tracePath: string;
};

export type OrchestrationDependencies = {
  evaluate: (state: AgentState, options?: ExecutionOptions) => Promise<EvaluationResult>;
  approve: (context: ApprovalContext) => Promise<ApprovalDecision>;
  askForInformation: (state: AgentState) => Promise<string>;
  recoverEvaluation?: (context: EvaluationRecoveryContext) => Promise<'continue' | 'stop'>;
  execute?: typeof executeCandidate;
  inspect?: typeof inspectRepo;
};

export type OrchestrationOptions = {
  maxIterations?: number;
  signal?: AbortSignal;
  initialPhase?: 'inspection';
  initialInspectionMs?: number;
};

export function createInitialState(repo: RepoSnapshot, task: string, workerSelection?: WorkerSelection, codexNetworkAccess?: true): AgentState {
  return {
    task,
    ...(workerSelection === undefined ? {} : { workerSelection }),
    ...(codexNetworkAccess === undefined ? {} : { codexNetworkAccess }),
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
    claudeCalls: 0,
    evidence: {
      revision: 0,
      validationGeneration: 0,
      clarifications: [],
      findings: [],
      failures: [],
      validations: [],
    },
  };
}

function currentEvidence(state: AgentState): AgentEvidence {
  return state.evidence ?? {
    revision: 0,
    validationGeneration: 0,
    clarifications: [],
    findings: [],
    failures: [],
  };
}

function withClarification(state: AgentState, information: string): AgentState {
  const evidence = currentEvidence(state);
  const normalized = information.replace(/\s+/gu, ' ').trim();
  const newInformation = normalized.length > 0 &&
    !evidence.clarifications.some((item) => item.text.replace(/\s+/gu, ' ').trim() === normalized);
  return {
    ...state,
    evidence: newInformation ? {
      ...evidence,
      revision: evidence.revision + 1,
      lastRevisionSource: 'user',
      clarifications: [...evidence.clarifications, { iteration: state.iteration, text: information }].slice(-8),
    } : evidence,
  };
}

function withToolEvidence(
  state: AgentState,
  proposal: CandidateProposal,
  result: ToolResult,
  modified: string[],
  refreshFailed: boolean,
): AgentEvidence {
  const previous = currentEvidence(state);
  let evidence: AgentEvidence = { ...previous };
  if (!result.ok) {
    evidence.failures = [...previous.failures, {
      iteration: state.iteration,
      action: proposal.action,
      summary: truncateText(result.output, 1_000),
    }].slice(-8);
  }
  if (proposal.action === 'SEARCH_REPO' && result.ok) {
    const finding = { iteration: state.iteration, source: 'search' as const, paths: result.files.slice(0, 8) };
    if (!previous.findings.some((item) => item.source === finding.source &&
      JSON.stringify(item.paths) === JSON.stringify(finding.paths))) {
      evidence = {
        ...evidence,
        revision: evidence.revision + 1,
        lastRevisionSource: 'search',
        findings: [...previous.findings, finding].slice(-8),
      };
    }
  }
  if (proposal.action === 'READ_FILE' && result.ok) {
    const finding = {
      iteration: state.iteration,
      source: 'read' as const,
      paths: result.files.slice(0, 8),
      excerpt: truncateText(result.output, 1_000),
    };
    if (!previous.findings.some((item) => item.source === finding.source &&
      JSON.stringify(item.paths) === JSON.stringify(finding.paths) && item.excerpt === finding.excerpt)) {
      evidence = {
        ...evidence,
        revision: evidence.revision + 1,
        lastRevisionSource: 'read',
        findings: [...previous.findings, finding].slice(-8),
      };
    }
  }
  if (proposal.action === 'RUN_COMMAND' && result.ok) {
    const finding = {
      iteration: state.iteration,
      source: 'diagnostic' as const,
      paths: [],
      excerpt: truncateText(result.output, 1_000),
    };
    if (!previous.findings.some((item) => item.source === finding.source && item.excerpt === finding.excerpt)) {
      evidence = {
        ...evidence,
        revision: evidence.revision + 1,
        lastRevisionSource: 'diagnostic',
        findings: [...previous.findings, finding].slice(-8),
      };
    }
  }
  if (proposal.action === 'RUN_TESTS') {
    evidence.validation = {
      iteration: state.iteration,
      generation: previous.validationGeneration,
      script: proposal.input.script,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      passed: result.ok,
      summary: truncateText(result.output, 1_000),
    };
    evidence.validations = [...(previous.validations ?? []).filter((item) =>
      item.generation === previous.validationGeneration && item.script !== proposal.input.script), evidence.validation].slice(-8);
  }
  if (proposal.action === 'READ_ISSUE' && result.ok && result.issue) {
    evidence.issue = result.issue;
    evidence.revision += 1;
    evidence.lastRevisionSource = 'issue';
  }
  if (isCodingAgentProposal(proposal)) {
    const reportedEnvironmentLimitations: Array<'loopback_bind_denied'> =
      /\blisten\s+(?:EPERM|EACCES)\b/iu.test(result.output) ? ['loopback_bind_denied'] : [];
    evidence.validationGeneration = previous.validationGeneration + 1;
    evidence.worker = {
      iteration: state.iteration,
      agent: proposal.action === 'CALL_CODEX' ? 'codex' : 'claude',
      evidenceRevision: previous.revision,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      ok: result.ok,
      summary: truncateText(result.output, 500),
      modifiedFiles: refreshFailed ? [] : modified.slice(0, 8),
      ...(reportedEnvironmentLimitations.length ? { reportedEnvironmentLimitations } : {}),
    };
    evidence.repoRefreshRequired = refreshFailed;
  }
  return evidence;
}

function allowedAlternatives(
  state: AgentState,
  policy: PolicyDecision,
): ExecutableAction[] {
  if (state.evidence?.repoRefreshRequired) return ['ASK_USER'];
  const preparation = taskPreparation(state);
  return EXECUTABLE_ACTIONS.filter((action) => {
    if (!isWorkerActionAllowed(action, state.workerSelection)) return false;
    if (preparation.nextAction !== null && requiresTaskPreparation(action)) return false;
    if (action === 'FINISH') {
      return hasPassedValidation(state) && (policy.selected === 'FINISH' ||
        (policy.selected === 'ASK_USER' && policy.completionReview !== undefined));
    }
    if (action === 'RUN_TESTS') return selectPendingValidation(state) !== undefined;
    if (action === 'READ_ISSUE') {
      const issue = parseGitHubIssue(state.task);
      return Boolean(issue && state.evidence?.issue?.url !== issue.url);
    }
    if (action === 'CALL_CODEX') return state.codexCalls < MAX_CODEX_CALLS;
    if (action === 'CALL_CLAUDE') return state.claudeCalls < MAX_CLAUDE_CALLS;
    return true;
  });
}

function rejectionObservation(decision: Extract<ApprovalDecision, { kind: 'reject' }>): string {
  const reason = decision.reason?.trim();
  return reason
    ? `User rejected the proposal: ${truncateText(reason, MAX_OBSERVATION_LENGTH)}`
    : 'User rejected the proposal without executing it.';
}

function stopObservation(decision: Extract<ApprovalDecision, { kind: 'stop' }>): string {
  const reason = decision.reason?.trim();
  return reason
    ? `User stopped the run: ${truncateText(reason, MAX_OBSERVATION_LENGTH)}`
    : 'User stopped the run without marking the task complete.';
}

function commandDescription(
  proposal: Extract<CandidateProposal, { action: 'RUN_COMMAND' | 'RUN_TESTS' }>,
): string {
  return [proposal.input.command, ...proposal.input.args].join(' ');
}

type CodingAgentProposal = Extract<CandidateProposal, { action: 'CALL_CODEX' | 'CALL_CLAUDE' }>;

function isCodingAgentProposal(proposal: CandidateProposal): proposal is CodingAgentProposal {
  return proposal.action === 'CALL_CODEX' || proposal.action === 'CALL_CLAUDE';
}

function codingAgentName(proposal: CodingAgentProposal): 'Codex' | 'Claude' {
  return proposal.action === 'CALL_CODEX' ? 'Codex' : 'Claude';
}

function codingAgentCommand(proposal: CodingAgentProposal): string {
  return proposal.action === 'CALL_CODEX' ? 'codex exec' : 'claude -p';
}

function isToolResult(value: unknown, proposal: CandidateProposal): value is ToolResult {
  if (value === null || typeof value !== 'object') return false;
  const result = value as Partial<ToolResult>;
  const action = proposal.action;
  return result.action === action &&
    typeof result.ok === 'boolean' &&
    (result.exitCode === null || Number.isInteger(result.exitCode)) &&
    (!result.ok || (result.exitCode === 0 || (action === 'SEARCH_REPO' && result.exitCode === 1))) &&
    (!result.timedOut || !result.ok) &&
    (!result.cancelled || !result.ok) &&
    (result.cancelled === undefined || typeof result.cancelled === 'boolean') &&
    typeof result.durationMs === 'number' &&
    Number.isFinite(result.durationMs) &&
    result.durationMs >= 0 &&
    typeof result.timedOut === 'boolean' &&
    typeof result.output === 'string' &&
    Array.isArray(result.files) &&
    result.files.every((file) => typeof file === 'string') &&
    (result.stdout === undefined || typeof result.stdout === 'string') &&
    (result.stderr === undefined || typeof result.stderr === 'string') &&
    (proposal.action !== 'READ_ISSUE' || !result.ok ||
      (isIssueContext(result.issue) && result.issue.url === proposal.input.url));
}

function modifiedFiles(repo: RepoSnapshot): string[] {
  return [...new Set(repo.gitStatus
    .map((entry) => entry.slice(3).trim())
    .filter(Boolean)
    .filter((entry) => entry !== 'traces' && entry !== 'traces/' && !entry.startsWith('traces/')))];
}

async function safelyExecute(
  proposal: Exclude<CandidateProposal, { action: 'ASK_USER' | 'FINISH' }>,
  execute: typeof executeCandidate,
  options: ExecutionOptions,
): Promise<ToolResult> {
  const startedAt = performance.now();
  try {
    const result: unknown = await (options.signal ? execute(proposal, undefined, options) : execute(proposal));
    if (!isToolResult(result, proposal)) {
      throw new Error('The tool executor returned a malformed result.');
    }
    return options.signal?.aborted
      ? { ...result, ok: false, cancelled: true }
      : result;
  } catch (error) {
    return {
      action: proposal.action,
      ok: false,
      exitCode: null,
      durationMs: Math.round(performance.now() - startedAt),
      timedOut: false,
      ...(options.signal?.aborted ? { cancelled: true } : {}),
      output: truncateText(
        options.signal?.aborted ? 'Tool execution interrupted.' : error instanceof Error ? error.message : 'Tool execution failed.',
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
  refreshedRepo?: RepoSnapshot,
  refreshFailed: boolean = false,
): AgentState {
  const signature = proposalSignature(proposal, state);
  const observations = [...state.observations];
  const failedApproaches = [...state.failedApproaches];
  let filesRead = state.filesRead;
  let filesModified = state.filesModified;
  let commandsRun = state.commandsRun;
  let tests = state.tests;
  let currentGoal = state.currentGoal;
  let repo = state.repo;
  let codexCalls = state.codexCalls;
  let claudeCalls = state.claudeCalls;

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
  } else if (proposal.action === 'RUN_COMMAND') {
    const summary = truncateText(result.output, MAX_OBSERVATION_LENGTH);
    observations.push(`Diagnostic completed: ${summary}`);
    currentGoal = 'Use the approved diagnostic result to choose the next action.';
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
  } else if (proposal.action === 'READ_ISSUE') {
    observations.push(`Read linked GitHub issue (untrusted context): ${result.issue?.title ?? ''}`);
    currentGoal = 'Inspect repository instructions and implement the issue acceptance criteria.';
  } else if (isCodingAgentProposal(proposal)) {
    const summary = truncateText(result.output, MAX_OBSERVATION_LENGTH);
    commandsRun = [...state.commandsRun, {
      command: codingAgentCommand(proposal),
      exitCode: result.exitCode ?? 1,
      output: summary,
    }];
    observations.push(`${codingAgentName(proposal)} completed: ${summary}`);
    tests = { ran: false };
    currentGoal = `Validate the ${codingAgentName(proposal)} changes with an approved repository script.`;
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

  if (proposal.action === 'RUN_COMMAND') {
    const summary = truncateText(result.output, MAX_OBSERVATION_LENGTH);
    commandsRun = [...state.commandsRun, {
      command: commandDescription(proposal),
      exitCode: result.exitCode ?? 1,
      output: summary,
    }];
  }

  if (isCodingAgentProposal(proposal)) {
    if (proposal.action === 'CALL_CODEX') codexCalls += 1;
    else claudeCalls += 1;
    if (!result.ok) {
      const summary = truncateText(result.output, MAX_OBSERVATION_LENGTH);
      commandsRun = [...state.commandsRun, {
        command: codingAgentCommand(proposal),
        exitCode: result.exitCode ?? 1,
        output: summary,
      }];
    }
    if (refreshedRepo !== undefined) {
      repo = refreshedRepo;
      filesModified = modifiedFiles(refreshedRepo);
    }
    tests = { ran: false };
  }

  const nextState: AgentState = {
    ...state,
    repo,
    currentGoal,
    filesRead,
    filesModified,
    observations,
    commandsRun,
    tests,
    failedApproaches,
    codexCalls,
    claudeCalls,
    evidence: withToolEvidence(state, proposal, result, filesModified, refreshFailed),
  };
  if (proposal.action === 'RUN_TESTS') {
    const pending = pendingValidationScripts(nextState);
    nextState.tests = {
      ran: true,
      ...(hasFailedValidation(nextState) ? { passed: false } : pending.length === 0 ? { passed: true } : {}),
      summary: truncateText(`Independent ${proposal.input.script}: ${result.ok ? 'passed' : 'failed'}. Pending: ${pending.join(', ') || 'none'}.\n${result.output}`, MAX_OBSERVATION_LENGTH),
    };
    nextState.currentGoal = pending.length ? `Validate remaining required checks: ${pending.join(', ')}.` : 'Determine whether the requested task is complete.';
  }
  return nextState;
}

async function resolveApproval(
  initialProposal: CandidateProposal,
  state: AgentState,
  evaluation: EvaluationResult,
  policy: PolicyDecision,
  approve: OrchestrationDependencies['approve'],
  searchResults: string[],
  metrics: RunMetricsCollector,
  signal?: AbortSignal,
  onProgress?: (proposals: CandidateProposal[], decisions: ApprovalDecision[]) => void,
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
    onProgress?.(proposals, decisions);
    const alternatives = allowedAlternatives(state, policy);
    const decision = await metrics.measure('approvalWaitMs', () => interruptible(() => {
      metrics.counts.approvalRequests += 1;
      return approve({
        state,
        evaluation,
        policy,
        proposal: structuredClone(proposal),
        allowedAlternatives: [...alternatives],
      });
    }, signal));
    metrics.recordApproval(decision);
    decisions.push(decision);
    onProgress?.(proposals, decisions);
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
    proposal = repeatedFailureProposal(
      await interruptible(() => selectCandidate(decision.action, state, searchResults), signal),
      state,
    );
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
  if (!state.failedApproaches.includes(proposalSignature(proposal, state))) return proposal;
  return {
    action: 'ASK_USER',
    tool: null,
    input: null,
    reason: 'The same resolved candidate already failed; policy requires new information.',
  };
}

function workerTraceRequest(
  proposal: CodingAgentProposal,
  state: AgentState,
  decision: ApprovalDecision,
): unknown {
  return {
    id: proposalSignature(proposal, state),
    evidenceRevision: state.evidence?.revision ?? 0,
    validationGeneration: state.evidence?.validationGeneration ?? 0,
    clarificationIterations: proposal.input.context.clarifications.map((item) => item.iteration),
    findingPaths: proposal.input.context.findings.flatMap((item) => item.paths).slice(0, 8),
    retryReason: decision.kind !== 'approve'
      ? 'Worker proposal was not executed.'
      : state.evidence?.validation?.passed === false
        ? 'Repair after failed independent validation.'
        : state.evidence?.worker?.ok === false
          ? state.evidence.worker.agent !== (proposal.action === 'CALL_CODEX' ? 'codex' : 'claude')
            ? 'User selected another agent after a failed worker.'
            : state.evidence.revision > state.evidence.worker.evidenceRevision
              ? `New ${state.evidence.lastRevisionSource ?? 'repository'} evidence after a failed worker.`
              : 'Approved worker request after prior failure.'
          : 'Approved worker request.',
  };
}

export async function runOrchestration(
  initialState: AgentState,
  dependencies: OrchestrationDependencies,
  options: OrchestrationOptions = {},
): Promise<OrchestrationResult> {
  const workerSelection = initialState.workerSelection;
  const codexNetworkAccess = initialState.codexNetworkAccess;
  const maxIterations = options.maxIterations ?? MAX_ORCHESTRATION_ITERATIONS;
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > MAX_ORCHESTRATION_ITERATIONS) {
    throw new Error(`Iteration limit must be between 1 and ${MAX_ORCHESTRATION_ITERATIONS}.`);
  }

  const metrics = createRunMetrics(options.initialInspectionMs);
  const trace = await createOrchestrationTrace(initialState.repo.root);
  const execute = dependencies.execute ?? executeCandidate;
  const inspect = dependencies.inspect ?? inspectRepo;
  let state = initialState;
  let lastSummary = metrics.summary(state);
  let searchResults: string[] = [];
  let phase: InterruptionPhase = options.initialPhase ?? 'evaluation';
  let interruptedPhase: InterruptionPhase | undefined;
  const latchPhase = (): void => { interruptedPhase ??= phase; };
  options.signal?.addEventListener('abort', latchPhase, { once: true });
  let stateBefore = state;
  let evaluation: EvaluationResult | null = null;
  let policy: PolicyDecision | null = null;
  let interruptedProposal: unknown = null;
  let interruptedApproval: unknown = null;
  let interruptedInput: unknown = null;
  let interruptedResult: ToolResult | null = null;
  let interruptedWorkerRequest: unknown;
  let interruptedIteration = 0;
  const executionOptions: ExecutionOptions = options.signal ? { signal: options.signal } : {};
  const stop = async (): Promise<OrchestrationResult> => {
    state = {
      ...state,
      currentGoal: 'Run interrupted without claiming completion.',
      observations: [...state.observations, 'Run interrupted by a signal.'],
    };
    const summary = metrics.summary(state);
    await appendOrchestrationTrace(trace, {
      iteration: interruptedIteration,
      stateBefore,
      evaluation,
      policy,
      proposal: interruptedProposal,
      approval: interruptedApproval,
      toolInput: interruptedInput,
      toolResult: interruptedResult,
      stateAfter: state,
      interruption: { phase: interruptedPhase ?? phase, reason: 'signal' },
      ...(interruptedWorkerRequest === undefined ? {} : { workerRequest: interruptedWorkerRequest }),
      metrics: { timings: summary.timings, counts: summary.counts },
      summary,
    });
    return { status: 'stopped', state, tracePath: trace.path, iterations: interruptedIteration, summary };
  };
  try {
    throwIfInterrupted(options.signal);

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      state = { ...state, iteration };
      if (workerSelection === undefined) delete state.workerSelection;
      else state.workerSelection = workerSelection;
      if (codexNetworkAccess === undefined) delete state.codexNetworkAccess;
      else state.codexNetworkAccess = codexNetworkAccess;
      interruptedIteration = iteration;
      stateBefore = state;
      evaluation = null;
      policy = null;
      interruptedProposal = null;
      interruptedApproval = null;
      interruptedInput = null;
      interruptedResult = null;
      interruptedWorkerRequest = undefined;
      phase = 'evaluation';
      try {
        evaluation = await metrics.measure('evaluationMs', () => interruptible(() => {
          metrics.counts.evaluations += 1;
          return dependencies.evaluate(state, executionOptions);
        }, options.signal));
      } catch (error) {
        throwIfInterrupted(options.signal);
        if (error instanceof RunInterruptedError) throw error;
        metrics.counts.evaluationFailures += 1;
        const failure = evaluationFailure(error);
        state = {
          ...state,
          currentGoal: 'Evaluation failed; explicit continuation is required.',
          observations: [...state.observations, `Evaluation failed: ${failure.code} at ${failure.stage}/${failure.category}.`],
        };
        const recoverEvaluation = dependencies.recoverEvaluation;
        const available = iteration < maxIterations && recoverEvaluation !== undefined;
        const failurePayload = {
          iteration, stateBefore, evaluation: null, policy: null, proposal: null,
          approval: null, toolInput: null, toolResult: null, stateAfter: state, failure,
        };
        // Record the failure before prompting so cancellation or EOF cannot
        // erase the rejected evaluation. A continuation is a separate record.
        phase = 'trace';
        await appendOrchestrationTrace(trace, { ...failurePayload, recovery: { available }, metrics: metrics.snapshot() });
        phase = 'recovery';
        const recovery = available && recoverEvaluation
          ? await metrics.measure('recoveryWaitMs', () => interruptible(() => recoverEvaluation({
            state: structuredClone(state), failure: { ...failure }, remainingIterations: maxIterations - iteration, tracePath: trace.path,
          }), options.signal))
          : 'stop';
        throwIfInterrupted(options.signal);
        const decision = recovery === 'continue' ? 'continue' : 'stop';
        if (decision === 'continue') metrics.counts.evaluationRecoveries += 1;
        if (decision === 'continue') state = {
          ...state,
          currentGoal: 'Reassess preserved task evidence after explicit evaluation recovery.',
          observations: [...state.observations, 'User explicitly continued after evaluation failure; existing budgets and evidence are retained.'],
        };
        phase = 'trace';
        const summary = metrics.summary(state);
        await appendOrchestrationTrace(trace, {
          ...failurePayload, stateAfter: state, recovery: { available, decision },
          metrics: { timings: summary.timings, counts: summary.counts },
          ...(decision === 'stop' ? { summary } : {}),
        });
        throwIfInterrupted(options.signal);
        if (decision === 'stop') return {
          status: 'evaluation_failed', state, tracePath: trace.path, iterations: iteration, exitCode: 1, failure, summary,
        };
        // This failed evaluation consumes an iteration. No candidate from it
        // exists, and call counts, generations, and failure history stay intact.
        continue;
      }
      throwIfInterrupted(options.signal);
      const evaluatedPolicy = applyPolicy(state, evaluation.assessment);
      policy = evaluatedPolicy;
      phase = 'candidate';
      const selected = repeatedFailureProposal(
        await interruptible(() => selectCandidate(evaluatedPolicy.selected, state, searchResults), options.signal),
        state,
      );
      interruptedProposal = { considered: [selected], selected: structuredClone(selected) };
      phase = 'approval';
      const approval = await resolveApproval(
        selected,
        state,
        evaluation,
        policy,
        dependencies.approve,
        searchResults,
        metrics,
        options.signal,
        (proposals, decisions) => {
          interruptedProposal = { considered: structuredClone(proposals), selected: structuredClone(proposals.at(-1)) };
          const decision = decisions.at(-1);
          interruptedApproval = decision ? { ...decision, history: structuredClone(decisions) } : null;
        },
      );
      const { proposal } = approval;
      interruptedProposal = { considered: approval.proposals, selected: structuredClone(proposal) };
      interruptedApproval = { ...approval.decision, history: approval.decisions };
      throwIfInterrupted(options.signal);
      let { decision } = approval;
      if (decision.kind === 'approve') {
        const blockedRepeat = state.failedApproaches.includes(proposalSignature(proposal, state));
        const exhaustedCodex = proposal.action === 'CALL_CODEX' && state.codexCalls >= MAX_CODEX_CALLS;
        const exhaustedClaude = proposal.action === 'CALL_CLAUDE' && state.claudeCalls >= MAX_CLAUDE_CALLS;
        const completionAllowed = policy.selected === 'FINISH' ||
          (policy.selected === 'ASK_USER' && policy.completionReview !== undefined);
        const blockedCompletion = proposal.action === 'FINISH' &&
          (!hasPassedValidation(state) || !completionAllowed);
        const blockedValidation = proposal.action === 'RUN_TESTS' && selectPendingValidation(state) === undefined;
        const blockedPreparation = requiresTaskPreparation(proposal.action) && taskPreparation(state).nextAction !== null;
        const blockedWorker = !isWorkerActionAllowed(proposal.action, workerSelection) ||
          (isCodingAgentProposal(proposal) && state.workerSelection !== workerSelection);
        const blockedCodexNetwork = proposal.action === 'CALL_CODEX' &&
          (state.codexNetworkAccess !== codexNetworkAccess || proposal.input.networkAccess !== codexNetworkAccess);
        if (blockedRepeat || exhaustedCodex || exhaustedClaude || blockedCompletion || blockedValidation || blockedPreparation || blockedWorker || blockedCodexNetwork ||
          (state.evidence?.repoRefreshRequired && proposal.action !== 'ASK_USER')) {
          decision = {
            kind: 'reject',
            reason: blockedRepeat
              ? 'The resolved candidate already failed with the same relevant evidence.'
              : blockedCodexNetwork
                ? 'The Codex network setting for this run prevents execution.'
                : blockedWorker
                  ? 'The worker selection for this run prevents execution.'
                  : blockedPreparation
                    ? 'Linked-task preparation must complete before execution.'
                    : blockedCompletion || blockedValidation
                      ? 'Current validation or completion policy prevents execution.'
                      : 'Repository inspection or a worker call limit prevents execution.',
          };
          approval.decisions.push(decision);
        }
      }
      let toolResult: ToolResult | null = null;
      if (codexNetworkAccess === undefined) delete state.codexNetworkAccess;
      else state.codexNetworkAccess = codexNetworkAccess;
      let nextState = state;
      let terminalStatus: Extract<OrchestrationStatus, 'finished' | 'stopped'> | undefined;

      if (decision.kind === 'stop') {
        terminalStatus = 'stopped';
        nextState = {
          ...state,
          observations: [...state.observations, stopObservation(decision)],
          currentGoal: 'Run stopped by user without claiming completion.',
        };
      } else if (decision.kind === 'reject') {
        nextState = {
          ...state,
          observations: [...state.observations, rejectionObservation(decision)],
          currentGoal: 'Choose a permitted alternative after user rejection.',
        };
      } else if (proposal.action === 'ASK_USER') {
        phase = 'information';
        const information = truncateText(
          (await metrics.measure('informationWaitMs', () => interruptible(() => dependencies.askForInformation(state), options.signal))).trim(),
          MAX_OBSERVATION_LENGTH,
        );
        nextState = withClarification({
          ...state,
          observations: [
            ...state.observations,
            information ? `User supplied information: ${information}` : 'User supplied no additional information.',
          ],
          currentGoal: 'Reassess the task with the user response.',
        }, information);
        // Recovery requires the approved user-input boundary as well as a fresh
        // snapshot. Rejection, stop, and alternative selection never reach here.
        if (nextState.evidence?.repoRefreshRequired) {
          phase = 'refresh';
          try {
            const refreshed = await metrics.measure('inspectionMs', () => inspect(state.repo.root));
            const modified = modifiedFiles(refreshed);
            nextState = {
              ...nextState,
              repo: refreshed,
              filesModified: modified,
              evidence: {
                ...nextState.evidence,
                repoRefreshRequired: false,
                ...(nextState.evidence.worker ? {
                  worker: { ...nextState.evidence.worker, modifiedFiles: modified.slice(0, 8) },
                } : {}),
              },
              observations: [...nextState.observations, 'Repository inspection recovered after user intervention.'],
            };
          } catch {
            nextState = {
              ...nextState,
              observations: [...nextState.observations, 'Repository inspection still requires recovery after user intervention.'],
            };
          }
        }
      } else if (proposal.action === 'FINISH') {
        terminalStatus = 'finished';
        const completionObservation = policy.selected === 'FINISH'
          ? 'User approved completion.'
          : policy.completionReview === 'validation_complete'
            ? 'User explicitly confirmed task acceptance after all required independent validation passed.'
            : 'User explicitly overrode completion confidence after passing validation.';
        nextState = {
          ...state,
          observations: [...state.observations, completionObservation],
          currentGoal: 'Task complete.',
        };
      } else {
        phase = 'execution';
        throwIfInterrupted(options.signal);
        interruptedInput = proposal.input;
        if (isCodingAgentProposal(proposal)) interruptedWorkerRequest = workerTraceRequest(proposal, stateBefore, decision);
        metrics.recordExecution(proposal.action);
        toolResult = await metrics.measure(executionTimingPhase(proposal.action), () => safelyExecute(proposal, execute, executionOptions));
        interruptedResult = toolResult;
        if (proposal.action === 'SEARCH_REPO' && toolResult.ok) searchResults = toolResult.files;
        let refreshedRepo: RepoSnapshot | undefined;
        let refreshFailed = false;
        if (isCodingAgentProposal(proposal)) {
          phase = 'refresh';
          try {
            refreshedRepo = await metrics.measure('inspectionMs', () => inspect(state.repo.root));
          } catch {
            refreshFailed = true;
            toolResult = {
              ...toolResult,
              ok: false,
              output: `${toolResult.output}\nUnable to inspect the repository after ${codingAgentName(proposal)} execution.`,
            };
          }
        }
        if (options.signal?.aborted) toolResult = { ...toolResult, ok: false, cancelled: true };
        metrics.recordResult(toolResult);
        nextState = applyToolResult(state, proposal, toolResult, refreshedRepo, refreshFailed);
        interruptedResult = toolResult;
      }

      if (options.signal?.aborted) {
        state = nextState;
        throwIfInterrupted(options.signal);
      }
      const reachedLimit = terminalStatus === undefined && iteration === maxIterations;
      if (reachedLimit) {
        nextState = {
          ...nextState,
          observations: [...nextState.observations, `Stopped at the ${maxIterations}-iteration limit.`],
          currentGoal: 'Ask the user how to continue after the iteration limit.',
        };
      }

      phase = 'trace';
      const summary = metrics.summary(nextState);
      lastSummary = summary;
      await appendOrchestrationTrace(trace, {
        iteration,
        stateBefore,
        evaluation,
        policy,
        proposal: { considered: approval.proposals, selected: structuredClone(proposal) },
        approval: { ...decision, history: approval.decisions },
        toolInput: decision.kind === 'stop' ? null : proposal.input,
        toolResult,
        stateAfter: nextState,
        metrics: { timings: summary.timings, counts: summary.counts },
        ...(terminalStatus !== undefined || reachedLimit ? { summary } : {}),
        ...(isCodingAgentProposal(proposal) ? {
          workerRequest: workerTraceRequest(proposal, stateBefore, decision),
        } : {}),
      });
      state = nextState;
      throwIfInterrupted(options.signal);

      if (terminalStatus !== undefined) {
        return {
          status: terminalStatus,
          state,
          tracePath: trace.path,
          iterations: iteration,
          summary,
        };
      }
    }

    throwIfInterrupted(options.signal);
    return {
      status: 'iteration_limit',
      state,
      tracePath: trace.path,
      iterations: maxIterations,
      exitCode: 1,
      summary: lastSummary,
    };
  } catch (error) {
    if (error instanceof RunInterruptedError || options.signal?.aborted) return await stop();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', latchPhase);
  }
}
