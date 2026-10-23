#!/usr/bin/env node
import type { ExecutionOptions } from './cancellation.js';
import { throwIfInterrupted } from './cancellation.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEvaluator } from './ai/evaluate.js';
import { PROBABILITY_SUM_TOLERANCE } from './ai/contract.js';
import { evaluationFailure, EvaluationError, type EvaluationFailure } from './ai/errors.js';
import { resolveEvaluationConfiguration } from './config.js';
import { requireBoundedTask } from './limits.js';
import { writeTrace } from './logging/trace.js';
import { evaluationAttribution, redactSensitiveText } from './logging/trace.js';
import { mockEvaluation } from './mock.js';
import { formatApprovalLines, formatOutcomeLines, formatRecoveryLines } from './cli/presentation.js';
import { createPresentation, createTerminal, terminalText, type CliTerminal } from './cli/terminal.js';
import { executeCandidate } from './orchestration/execute.js';
import {
  createInitialState,
  runOrchestration,
  type ApprovalContext,
  type ApprovalDecision,
  type OrchestrationResult,
  type EvaluationRecoveryContext,
} from './orchestration/loop.js';
import { applyPolicy } from './policy.js';
import type { RunSummary } from './orchestration/summary.js';
import { inspectGitIdentity, inspectRepo } from './repo/inspect.js';
import { createSavedRunConfiguration, createSavedRunRepository } from './saved-runs/contract.js';
import { openSavedRunStore } from './saved-runs/store.js';
import type { SavedRunEventInput, SavedRunOwnership, SavedRunStatus } from './saved-runs/types.js';
import type {
  Action,
  AgentAssessment,
  AgentState,
  EvaluationResult,
  EvaluationAttribution,
  PolicyDecision,
  RepoSnapshot,
  WorkerSelection,
} from './types.js';

export const EXIT_CODES = {
  success: 0,
  operationalError: 1,
  usageError: 2,
} as const;

export type CliOptions = {
  repoPath: string;
  task: string;
  mock: boolean;
  noTrace: boolean;
  json: boolean;
  orchestrate: boolean;
  saveRun?: true;
  workerSelection?: WorkerSelection;
  codexNetworkAccess?: true;
  plain?: true;
};

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; options: CliOptions };

export type DecisionOutput = EvaluationAttribution & {
  schemaVersion: 1;
  status: 'unexecuted';
  mode: 'mock' | 'live';
  repo: RepoSnapshot;
  task: string;
  workerSelection?: WorkerSelection;
  codexNetworkAccess?: true;
  assessment: AgentAssessment;
  policy: PolicyDecision;
  model: string;
  latencyMs: number;
  tracePath?: string;
};

type ErrorOutput = {
  schemaVersion: 1;
  status: 'error';
  error: {
    kind: 'usage' | 'operational';
    message: string;
    failure?: EvaluationFailure;
  };
  exitCode: number;
};

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export function usage(): string {
  return `dev-agent <repo-path> <task> [--mock] [--no-trace] [--json] [--orchestrate] [--save-run] [--worker codex|claude] [--codex-network] [--plain]

Options:
  --mock       Use the offline deterministic evaluation.
  --no-trace   Do not write a JSONL trace.
  --json       Write one machine-readable decision to stdout.
  --orchestrate  Enter the bounded, manually approved execution loop.
  --save-run     Persist the bounded orchestration state and event history.
  --worker     Restrict coding work to codex or claude; otherwise the evaluator may choose either.
  --codex-network  Allow Codex command networking, including local sockets; keep its file sandbox.
  --plain      Use static plain orchestration output (also used for pipes, CI, NO_COLOR, or TERM=dumb).
  --version    Print the installed package version.
  --help, -h   Print this help text.

Examples:
  dev-agent . "Decide what to inspect first"
  dev-agent ../my-app "Fix preview auth" --mock --json --no-trace
  dev-agent ../my-app "Investigate preview auth" --mock --orchestrate

Environment:
  ROUTER_PROVIDER     typesafe (default), vercel, openrouter, or cloudflare
  JEV_PROVIDER        Compatibility alias; must agree with ROUTER_PROVIDER if both are set
  AI_GATEWAY_API_KEY  Vercel AI Gateway key (vercel only)
  OPENROUTER_API_KEY  OpenRouter key (openrouter only)
  OPENROUTE_API_KEY   Accepted OpenRouter key alias
  TYPESAFE_API_KEY    TypeSafe AI key (typesafe only)
  TYPESAFE_AI_API_KEY Accepted TypeSafe key alias
  CLOUDFLARE_ACCOUNT_ID  Cloudflare account ID (cloudflare only)
  CLOUDFLARE_AUTH_TOKEN  Workers AI token (cloudflare only)
  ROUTER_MODEL        Selected provider's model override
  OPENROUTE_MODEL     OpenRouter model fallback when ROUTER_MODEL is blank

Exit codes:
  0  A decision, help text, or version was printed.
  1  An operational error prevented a decision.
  2  Invalid command-line usage.
  130  Approval-gated run interrupted by Ctrl+C / SIGINT.
  143  Approval-gated run interrupted by SIGTERM.`;
}

function usageError(message: string): CliUsageError {
  return new CliUsageError(`${message}\n\n${usage()}`);
}

function taskFromPositionals(positionals: string[]): string {
  try {
    return requireBoundedTask(positionals.slice(1).join(' ').trim());
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
}

function withoutNodeArgumentSeparator(argv: string[]): string[] {
  return argv[0] === '--' ? argv.slice(1) : argv;
}

export function parseArgs(argv: string[]): CliCommand {
  let mock = false;
  let noTrace = false;
  let json = false;
  let orchestrate = false;
  let saveRun: true | undefined;
  let workerSelection: WorkerSelection | undefined;
  let codexNetworkAccess: true | undefined;
  let plain: true | undefined;
  let showHelp = false;
  let showVersion = false;
  let parseFlags = true;
  const positional: string[] = [];

  const args = withoutNodeArgumentSeparator(argv);
  const selectWorker = (value: string | undefined): void => {
    if (workerSelection !== undefined) throw usageError('--worker can only be specified once.');
    if (value !== 'codex' && value !== 'claude') throw usageError('--worker requires codex or claude.');
    workerSelection = value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (!parseFlags) {
      positional.push(arg);
      continue;
    }

    if (arg === '--') {
      parseFlags = false;
      continue;
    }

    switch (arg) {
      case '--mock':
        mock = true;
        break;
      case '--no-trace':
        noTrace = true;
        break;
      case '--json':
        json = true;
        break;
      case '--orchestrate':
        orchestrate = true;
        break;
      case '--save-run':
        if (saveRun) throw usageError('--save-run can only be specified once.');
        saveRun = true;
        break;
      case '--plain':
        plain = true;
        break;
      case '--worker':
        selectWorker(args[++index]);
        break;
      case '--codex-network':
        if (codexNetworkAccess) throw usageError('--codex-network can only be specified once.');
        codexNetworkAccess = true;
        break;
      case '--help':
      case '-h':
        showHelp = true;
        break;
      case '--version':
        showVersion = true;
        break;
      default:
        if (arg.startsWith('--worker=')) {
          selectWorker(arg.slice('--worker='.length));
          break;
        }
        if (arg.startsWith('-')) {
          throw usageError(`Unknown option: ${arg}`);
        }
        positional.push(arg);
    }
  }

  if (showHelp || showVersion) {
    if (showHelp && showVersion) {
      throw usageError('Use either --help or --version, not both.');
    }
    if (mock || noTrace || json || orchestrate || saveRun || plain || workerSelection !== undefined || codexNetworkAccess !== undefined || positional.length > 0) {
      throw usageError('--help and --version cannot be combined with a decision request.');
    }
    return showHelp ? { kind: 'help' } : { kind: 'version' };
  }

  if (positional.length < 2) {
    throw usageError('Missing repository path or task.');
  }

  const repoPath = positional[0] ?? '';
  const task = taskFromPositionals(positional);
  if (orchestrate && json) {
    throw usageError('--orchestrate is interactive and cannot be combined with --json.');
  }
  if (orchestrate && noTrace) {
    throw usageError('--orchestrate requires its per-iteration safety trace.');
  }
  if (saveRun && !orchestrate) {
    throw usageError('--save-run requires --orchestrate.');
  }
  if (codexNetworkAccess && workerSelection === 'claude') {
    throw usageError('--codex-network cannot be combined with --worker claude.');
  }
  return {
    kind: 'run',
    options: {
      repoPath, task, mock, noTrace, json, orchestrate,
      ...(saveRun === undefined ? {} : { saveRun }),
      ...(workerSelection === undefined ? {} : { workerSelection }),
      ...(codexNetworkAccess === undefined ? {} : { codexNetworkAccess }),
      ...(plain === undefined ? {} : { plain }),
    },
  };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function printDistribution(probabilities: Partial<Record<Action, number>>): void {
  const entries = Object.entries(probabilities).sort(([, a], [, b]) => (b ?? 0) - (a ?? 0));
  for (const [action, probability] of entries) {
    console.log(`  ${action.padEnd(14)} ${percent(probability ?? 0).padStart(4)}`);
  }
}

export function createDecisionOutput(
  state: AgentState,
  evaluation: EvaluationResult,
  policy: PolicyDecision,
  mode: DecisionOutput['mode'],
  tracePath?: string,
): DecisionOutput {
  return {
    schemaVersion: 1,
    status: 'unexecuted',
    mode,
    repo: {
      ...state.repo,
      root: redactSensitiveText(state.repo.root),
      ...(state.repo.packageName === undefined ? {} : { packageName: redactSensitiveText(state.repo.packageName) }),
      ...(state.repo.gitBranch === undefined ? {} : { gitBranch: redactSensitiveText(state.repo.gitBranch) }),
      scripts: state.repo.scripts.map((value) => redactSensitiveText(value)),
      validationScripts: state.repo.validationScripts.map((value) => redactSensitiveText(value)),
      ...(state.repo.requiredValidationScripts ? {
        requiredValidationScripts: state.repo.requiredValidationScripts.map((value) => redactSensitiveText(value)),
      } : {}),
      ...(state.repo.validationScriptCoverage ? {
        validationScriptCoverage: Object.fromEntries(Object.entries(state.repo.validationScriptCoverage)
          .map(([script, covered]) => [redactSensitiveText(script), covered.map((value) => redactSensitiveText(value))])),
      } : {}),
      gitStatus: state.repo.gitStatus.map((value) => redactSensitiveText(value)),
      topLevelFiles: state.repo.topLevelFiles.map((value) => redactSensitiveText(value)),
    },
    task: redactSensitiveText(state.task),
    ...(state.workerSelection === undefined ? {} : { workerSelection: state.workerSelection }),
    ...(state.codexNetworkAccess === undefined ? {} : { codexNetworkAccess: state.codexNetworkAccess }),
    assessment: evaluation.assessment,
    policy: { ...policy, reason: redactSensitiveText(policy.reason) },
    model: redactSensitiveText(evaluation.model),
    ...evaluationAttribution(evaluation),
    latencyMs: evaluation.latencyMs,
    ...(tracePath === undefined ? {} : { tracePath: redactSensitiveText(tracePath) }),
  };
}

export async function runDecision(
  options: Pick<CliOptions, 'repoPath' | 'task' | 'mock' | 'noTrace' | 'workerSelection' | 'codexNetworkAccess'>,
  cwd: string = process.cwd(),
): Promise<DecisionOutput> {
  const repo = await inspectRepo(options.repoPath);
  const state = createInitialState(repo, options.task, options.workerSelection, options.codexNetworkAccess);
  const mode: DecisionOutput['mode'] = options.mock ? 'mock' : 'live';

  const evaluation = options.mock ? mockEvaluation() : await createEvaluator()(state);
  const policy = applyPolicy(state, evaluation.assessment);
  const tracePath = options.noTrace
    ? undefined
    : path.relative(cwd, await writeTrace(cwd, { state, evaluation, policy }));

  return createDecisionOutput(state, evaluation, policy, mode, tracePath);
}

export function parseApprovalChoice(
  value: string,
  context: ApprovalContext,
): ApprovalDecision | undefined {
  const normalized = value.trim().toUpperCase();
  if (normalized === 'A' || normalized === 'APPROVE') return { kind: 'approve' };
  if (normalized === 'R' || normalized === 'REJECT') return { kind: 'reject' };
  if (normalized === 'STOP' || normalized === 'QUIT') return { kind: 'stop' };

  const actionAliases: Partial<Record<string, ApprovalDecision>> = {
    SEARCH: { kind: 'alternative', action: 'SEARCH_REPO' },
    SEARCH_REPO: { kind: 'alternative', action: 'SEARCH_REPO' },
    READ: { kind: 'alternative', action: 'READ_FILE' },
    READ_FILE: { kind: 'alternative', action: 'READ_FILE' },
    ISSUE: { kind: 'alternative', action: 'READ_ISSUE' },
    READ_ISSUE: { kind: 'alternative', action: 'READ_ISSUE' },
    COMMAND: { kind: 'alternative', action: 'RUN_COMMAND' },
    RUN_COMMAND: { kind: 'alternative', action: 'RUN_COMMAND' },
    TEST: { kind: 'alternative', action: 'RUN_TESTS' },
    RUN_TESTS: { kind: 'alternative', action: 'RUN_TESTS' },
    CODEX: { kind: 'alternative', action: 'CALL_CODEX' },
    CALL_CODEX: { kind: 'alternative', action: 'CALL_CODEX' },
    CLAUDE: { kind: 'alternative', action: 'CALL_CLAUDE' },
    CALL_CLAUDE: { kind: 'alternative', action: 'CALL_CLAUDE' },
    ASK: { kind: 'alternative', action: 'ASK_USER' },
    ASK_USER: { kind: 'alternative', action: 'ASK_USER' },
    FINISH: { kind: 'alternative', action: 'FINISH' },
  };
  const decision = actionAliases[normalized];
  if (decision?.kind === 'alternative' && context.allowedAlternatives.includes(decision.action)) {
    return decision;
  }
  return undefined;
}

export function printApprovalProposal(context: ApprovalContext): void {
  for (const line of formatApprovalLines(context)) console.log(line);
}

async function promptForApproval(
  terminal: CliTerminal,
  context: ApprovalContext,
  options: ExecutionOptions = {},
): Promise<ApprovalDecision> {
  terminal.review(context);
  while (true) {
    const answer = await terminal.question(
      'Choose approve, reject, stop, or an allowed action name: ',
      options,
    );
    throwIfInterrupted(options.signal);
    const decision = parseApprovalChoice(answer, context);
    if (decision) return decision;
    terminal.line('Invalid choice. This input approved no action.');
  }
}

async function promptForEvaluationRecovery(
  terminal: CliTerminal,
  context: EvaluationRecoveryContext,
  options: ExecutionOptions,
): Promise<'continue' | 'stop'> {
  terminal.section('Evaluation failed', [
    `${formatEvaluationFailure(context.failure)}.`, ...formatRecoveryLines(context), `Trace: ${redactSensitiveText(context.tracePath)}`,
  ]);
  while (true) {
    const answer = (await terminal.question('Enter continue to reevaluate this state, or stop: ', options)).trim().toLowerCase();
    throwIfInterrupted(options.signal);
    if (answer === 'continue') return 'continue';
    if (answer === 'stop' || answer === 'quit') return 'stop';
    terminal.line('Explicit continue or stop is required; no action has been approved.');
  }
}

export async function runCliOrchestration(options: CliOptions): Promise<OrchestrationResult> {
  const controller = new AbortController();
  let exitCode: number | undefined;
  const interrupt = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (controller.signal.aborted) return;
    exitCode = signal === 'SIGINT' ? 130 : 143;
    controller.abort();
  };
  const sigint = (): void => interrupt('SIGINT');
  const sigterm = (): void => interrupt('SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  let terminal: CliTerminal | undefined;
  let worktreeOwnership: SavedRunOwnership | undefined;
  let runOwnership: SavedRunOwnership | undefined;
  let savedRunId: string | undefined;
  let savedRunStore: Awaited<ReturnType<typeof openSavedRunStore>> | undefined;
  const executionOptions = { signal: controller.signal };
  try {
    savedRunStore = await openSavedRunStore();
    worktreeOwnership = await savedRunStore.acquireWorktreeOwnership(options.repoPath);
    const savedEvaluationConfiguration = options.saveRun && !options.mock
      ? resolveEvaluationConfiguration()
      : undefined;
    // Inspection is read-only and already bounded. Drain it before returning;
    // an initial interruption never enters evaluation or approval.
    const inspectionStartedAt = performance.now();
    let repo = await inspectRepo(options.repoPath);
    let savedRepository: Awaited<ReturnType<typeof createSavedRunRepository>> | undefined;
    if (options.saveRun) {
      const identity = await inspectGitIdentity(repo.root);
      if (identity.root !== repo.root) repo = await inspectRepo(identity.root);
      savedRepository = await createSavedRunRepository(identity.root, identity.gitCommonDirectory, identity.head);
    }
    const initialInspectionMs = performance.now() - inspectionStartedAt;
    const state = createInitialState(repo, options.task, options.workerSelection, options.codexNetworkAccess);
    const configuration = options.mock
      ? undefined
      : controller.signal.aborted && !options.saveRun
        ? undefined
        : savedEvaluationConfiguration ?? resolveEvaluationConfiguration();
    const evaluate = configuration ? createEvaluator(configuration) : mockEvaluation;
    terminal = await createTerminal({
      ...(options.plain ? { plain: true } : {}), interrupt: sigint,
      writeLine: (line) => console.log(line),
    });
    const prompts = terminal;
    if (options.saveRun && savedRepository) {
      const runId = randomUUID();
      runOwnership = await savedRunStore.acquireRunOwnership(runId);
      await savedRunStore.create({
        runId,
        iterationLimit: 8,
        repository: savedRepository,
        configuration: createSavedRunConfiguration(
          options.mock ? 'mock' : 'live',
          configuration,
          options.workerSelection,
          options.codexNetworkAccess === true,
        ),
        state,
      });
      savedRunId = runId;
    }

    const oneLine = (value: string): string => terminalText(value).replace(/\s+/gu, ' ').trim();
    prompts.header('Dev Orchestrator — approval-gated orchestration', [
      `Repo: ${oneLine(repo.root)}`, `Task: ${oneLine(options.task)}`,
      `Mode: ${options.mock ? 'mock' : `live (${configuration?.provider ?? 'interrupted'})`}`,
      ...(configuration ? [`Provider: ${configuration.provider}`, `Requested model: ${oneLine(configuration.model)}`] : []),
      ...(savedRunId ? [`Saved run: ${savedRunId} (active)`] : []),
      `Worker selection: ${options.workerSelection ?? 'Codex or Claude'}`,
      ...(options.codexNetworkAccess ? ['Codex command network: enabled; workspace file sandbox retained.'] : []),
      'No repository action runs without approval.',
    ]);

    const result = await runOrchestration(state, {
      evaluate: async (currentState) => prompts.phase('Evaluating task', async () => evaluate(currentState, executionOptions), executionOptions),
      approve: async (context) => promptForApproval(prompts, context, executionOptions),
      askForInformation: async () => prompts.question('Provide the required information: ', executionOptions),
      recoverEvaluation: async (context) => promptForEvaluationRecovery(prompts, context, executionOptions),
      execute: async (proposal, runner, execution = {}) => prompts.phase(`Approved ${proposal.action}`,
        () => executeCandidate(proposal, runner, execution), execution, (result) => result.ok),
    }, {
      signal: controller.signal,
      initialInspectionMs,
      ...(controller.signal.aborted ? { initialPhase: 'inspection' as const } : {}),
      ...(savedRunId ? {
        persistence: {
          record: (event: SavedRunEventInput, currentState: AgentState) =>
            savedRunStore!.append(savedRunId!, event, currentState),
        },
      } : {}),
    });
    let savedRunStatus: SavedRunStatus | undefined;
    let savedRunStatusUnavailable: true | undefined;
    if (savedRunId) {
      try {
        savedRunStatus = (await savedRunStore.read(savedRunId)).checkpoint.status;
      } catch {
        // A failed append can leave the checkpoint and ledger inconsistent.
        savedRunStatusUnavailable = true;
      }
    }
    const resultExitCode = exitCode ?? (
      savedRunStatusUnavailable && result.exitCode === undefined ? EXIT_CODES.operationalError : result.exitCode
    );
    return {
      ...result,
      ...(savedRunId === undefined ? {} : { savedRunId }),
      ...(savedRunStatus === undefined ? {} : { savedRunStatus }),
      ...(savedRunStatusUnavailable === undefined ? {} : { savedRunStatusUnavailable }),
      ...(resultExitCode === undefined ? {} : { exitCode: resultExitCode }),
    };
  } finally {
    try {
      terminal?.dispose();
    } finally {
      process.removeListener('SIGINT', sigint);
      process.removeListener('SIGTERM', sigterm);
      try {
        await runOwnership?.release();
      } finally {
        await worktreeOwnership?.release();
      }
    }
  }
}

function printHumanDecision(decision: DecisionOutput): void {
  const { assessment, policy } = decision;
  console.log('\nDev Orchestrator — decision-only milestone');
  console.log('Status: unexecuted decision (no tools or coding agents ran)\n');
  console.log(`Repo: ${terminalText(decision.repo.root).replace(/\s+/gu, ' ')}`);
  console.log(`Task: ${terminalText(decision.task).replace(/\s+/gu, ' ')}`);
  if (decision.workerSelection) console.log(`Worker selection: ${decision.workerSelection}`);
  if (decision.codexNetworkAccess) console.log('Codex command network: enabled; workspace file sandbox retained.');
  console.log(`Mode: ${decision.mode === 'mock' ? 'mock' : `live (${decision.provider})`}\n`);
  console.log(`Task complete       ${percent(assessment.taskComplete.probability)}`);
  console.log(`Needs information  ${percent(assessment.needsMoreInformation.probability)}`);
  console.log(`Needs testing      ${percent(assessment.needsTesting.probability)}`);
  console.log(`Stuck              ${percent(assessment.stuck.probability)}\n`);
  console.log('Next-action distribution');
  printDistribution(assessment.nextAction.probabilities);
  console.log(`\nEvaluator requested: ${policy.requested}`);
  console.log(`Policy selected (unexecuted): ${policy.selected}${policy.override ? ' (override)' : ''}`);
  console.log(`Reason: ${policy.reason}`);
  console.log(`Latency: ${decision.latencyMs}ms`);
  printEvaluationAttribution(decision);
  if (decision.tracePath !== undefined) console.log(`Trace: ${terminalText(decision.tracePath).replace(/\s+/gu, ' ')}`);
}

function printEvaluationAttribution(evaluation: EvaluationAttribution): void {
  if (evaluation.provider) console.log(`Provider: ${evaluation.provider}`);
  if (evaluation.requestedModel) console.log(`Requested model: ${terminalText(evaluation.requestedModel).replace(/\s+/gu, ' ')}`);
  if (evaluation.servedModel) console.log(`Served model: ${terminalText(evaluation.servedModel).replace(/\s+/gu, ' ')}`);
}

export function formatRunSummary(summary: RunSummary): string {
  const { timings, counts, validation } = summary;
  const seconds = (ms: number): string => `${(ms / 1_000).toFixed(2)}s`;
  const checks = validation.checks.map((check) => `${redactSensitiveText(check.script)}: ${check.status}`).join(', ');
  const validationStatus = validation.passed ? 'passed'
    : validation.checks.some((check) => check.status === 'failed') ? 'failed' : 'incomplete';
  return [
    '\nRun summary',
    `Elapsed: ${seconds(timings.elapsedMs)}; active: ${seconds(timings.activeMs)} (excludes prompt waits)`,
    `Evaluation: ${seconds(timings.evaluationMs)}; preparation: ${seconds(timings.preparationMs)}`,
    `Worker: ${seconds(timings.workerMs)}; independent validation: ${seconds(timings.validationMs)}`,
    `Approval wait: ${seconds(timings.approvalWaitMs)}; information wait: ${seconds(timings.informationWaitMs)}; recovery wait: ${seconds(timings.recoveryWaitMs)}`,
    `Inspection: ${seconds(timings.inspectionMs)}; diagnostics: ${seconds(timings.diagnosticsMs)}; other: ${seconds(timings.otherMs)}`,
    `Evaluations: ${counts.evaluations}; failures: ${counts.evaluationFailures}; explicit recoveries: ${counts.evaluationRecoveries}`,
    `Approval requests: ${counts.approvalRequests}; approvals: ${counts.approvals}; rejections: ${counts.rejections}; manual alternatives: ${counts.alternatives}`,
    `Worker calls: Codex ${counts.codexCalls}, Claude ${counts.claudeCalls}; retries: ${counts.workerRetries}`,
    `Validation runs: ${counts.validationRuns}; failed: ${counts.validationFailures}`,
    `Failed executions: ${counts.failedExecutions}; timed out: ${counts.timedOutExecutions}; cancelled: ${counts.cancelledExecutions}`,
    `Independent checks (generation ${validation.generation}): ${validationStatus}. ${checks || 'No required checks detected.'}`,
    ...(validation.requirementsOmitted ? ['Additional validation requirements were omitted; completion remains blocked.'] : []),
    ...(validation.repoRefreshRequired ? ['Repository inspection requires recovery before validation can confirm completion.'] : []),
  ].join('\n');
}

async function packageVersion(): Promise<string> {
  const manifest = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(manifest);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    typeof parsed.version !== 'string'
  ) {
    throw new Error('Unable to read the package version.');
  }
  return parsed.version;
}

export function exitCodeFor(error: unknown): number {
  return error instanceof CliUsageError
    ? EXIT_CODES.usageError
    : EXIT_CODES.operationalError;
}

export function formatEvaluationFailure(failure: EvaluationFailure): string {
  const sum = failure.probabilitySum === undefined ? ''
    : `; probability sum ${failure.probabilitySum}, expected 1 (tolerance ${PROBABILITY_SUM_TOLERANCE})`;
  return `${failure.code} at ${failure.stage}/${failure.category}${failure.field ? ` (${failure.field})` : ''}${sum}`;
}

export function createErrorOutput(error: unknown): ErrorOutput {
  const usage = error instanceof CliUsageError;
  const failure = error instanceof EvaluationError ? evaluationFailure(error) : undefined;
  return {
    schemaVersion: 1,
    status: 'error',
    error: {
      kind: usage ? 'usage' : 'operational',
      message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      ...(failure === undefined ? {} : { failure }),
    },
    exitCode: exitCodeFor(error),
  };
}

function wantsJsonError(argv: string[]): boolean {
  let parseFlags = true;
  for (const arg of withoutNodeArgumentSeparator(argv)) {
    if (!parseFlags) continue;
    if (arg === '--') {
      parseFlags = false;
      continue;
    }
    if (arg === '--json') return true;
  }
  return false;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = parseArgs(argv);
  if (command.kind === 'help') {
    console.log(usage());
    return;
  }
  if (command.kind === 'version') {
    console.log(await packageVersion());
    return;
  }

  if (command.options.orchestrate) {
    const result = await runCliOrchestration(command.options);
    if (result.exitCode !== undefined) process.exitCode = result.exitCode;
    const view = await createPresentation({ ...(command.options.plain ? { plain: true } : {}), writeLine: (line) => console.log(line) });
    const outcome = [
      `\nLoop status: ${result.status}`, `Iterations: ${result.iterations}`,
      ...(result.savedRunId ? [
        `Saved run: ${result.savedRunId} (${result.persistenceFailure
          ? `persistence failed at ${result.persistenceFailure}; status requires inspection`
          : result.savedRunStatusUnavailable ? 'status unavailable; inspect the record' : result.savedRunStatus ?? result.status})`,
      ] : []),
      ...(result.persistenceFailure ? [
        'The run stopped after a saved-state write failed; no later evaluation or execution was started.',
      ] : []),
      `Trace: ${redactSensitiveText(path.relative(process.cwd(), result.tracePath))}`,
      ...(result.failure ? [`Failure: ${formatEvaluationFailure(result.failure)}.`] : []),
      ...(result.status === 'iteration_limit' ? ['Task completion was not approved before the iteration limit; edits and evidence are preserved. Exit code: 1.'] : []),
      ...formatOutcomeLines(result),
    ];
    if (view.styled) {
      view.section('Run result', outcome);
      view.section('Run summary', formatRunSummary(result.summary).trim().split('\n').slice(1));
      view.end(result.status === 'finished' ? 'Task acceptance approved.' : 'Run stopped; edits and evidence preserved.');
    } else {
      outcome.forEach(view.line);
      view.line(formatRunSummary(result.summary));
    }
    return;
  }

  const decision = await runDecision(command.options);
  if (command.options.json) {
    console.log(JSON.stringify(decision));
    return;
  }
  printHumanDecision(decision);
}

function isDirectInvocation(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href;
}

if (isDirectInvocation()) {
  void main().catch((error: unknown) => {
    const output = createErrorOutput(error);
    if (wantsJsonError(process.argv.slice(2))) {
      console.error(JSON.stringify(output));
    } else {
      console.error(`\nError: ${terminalText(output.error.message).replace(/\s+/gu, ' ')}`);
      if (output.error.failure) console.error(`Failure: ${formatEvaluationFailure(output.error.failure)}.`);
    }
    process.exitCode = output.exitCode;
  });
}
