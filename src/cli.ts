#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { evaluateAgentState } from './ai/evaluate.js';
import { requireGatewayApiKey } from './config.js';
import { requireBoundedTask } from './limits.js';
import { writeTrace } from './logging/trace.js';
import { mockEvaluation } from './mock.js';
import {
  createInitialState,
  runOrchestration,
  type ApprovalContext,
  type ApprovalDecision,
  type OrchestrationResult,
} from './orchestration/loop.js';
import { applyPolicy } from './policy.js';
import { inspectRepo } from './repo/inspect.js';
import type {
  Action,
  AgentAssessment,
  AgentState,
  EvaluationResult,
  PolicyDecision,
  RepoSnapshot,
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
};

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; options: CliOptions };

export type DecisionOutput = {
  schemaVersion: 1;
  status: 'unexecuted';
  mode: 'mock' | 'live';
  repo: RepoSnapshot;
  task: string;
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
  return `jev-agent <repo-path> <task> [--mock] [--no-trace] [--json] [--orchestrate]

Options:
  --mock       Use the offline deterministic evaluation.
  --no-trace   Do not write a JSONL trace.
  --json       Write one machine-readable decision to stdout.
  --orchestrate  Enter the bounded, manually approved execution loop.
  --version    Print the installed package version.
  --help, -h   Print this help text.

Examples:
  pnpm dev -- . "Decide what to inspect first"
  pnpm dev -- ../my-app "Fix preview auth" --mock --json --no-trace
  pnpm dev -- ../my-app "Investigate preview auth" --mock --orchestrate

Environment:
  AI_GATEWAY_API_KEY   Vercel AI Gateway key
  ROUTER_MODEL         Defaults to typesafe-ai/jev

Exit codes:
  0  A decision, help text, or version was printed.
  1  An operational error prevented a decision.
  2  Invalid command-line usage.`;
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
  let showHelp = false;
  let showVersion = false;
  let parseFlags = true;
  const positional: string[] = [];

  for (const arg of withoutNodeArgumentSeparator(argv)) {
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
      case '--help':
      case '-h':
        showHelp = true;
        break;
      case '--version':
        showVersion = true;
        break;
      default:
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
    if (mock || noTrace || json || orchestrate || positional.length > 0) {
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
  return {
    kind: 'run',
    options: { repoPath, task, mock, noTrace, json, orchestrate },
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
    repo: state.repo,
    task: state.task,
    assessment: evaluation.assessment,
    policy,
    model: evaluation.model,
    latencyMs: evaluation.latencyMs,
    ...(tracePath === undefined ? {} : { tracePath }),
  };
}

export async function runDecision(
  options: Pick<CliOptions, 'repoPath' | 'task' | 'mock' | 'noTrace'>,
  cwd: string = process.cwd(),
): Promise<DecisionOutput> {
  const repo = await inspectRepo(options.repoPath);
  const state = createInitialState(repo, options.task);
  const mode: DecisionOutput['mode'] = options.mock ? 'mock' : 'live';

  if (!options.mock) requireGatewayApiKey();
  const evaluation = options.mock ? mockEvaluation() : await evaluateAgentState(state);
  const policy = applyPolicy(state, evaluation.assessment);
  const tracePath = options.noTrace
    ? undefined
    : path.relative(cwd, await writeTrace(cwd, { state, evaluation, policy }));

  return createDecisionOutput(state, evaluation, policy, mode, tracePath);
}

function approvalChoice(value: string, context: ApprovalContext): ApprovalDecision | undefined {
  const normalized = value.trim().toUpperCase();
  if (normalized === 'A' || normalized === 'APPROVE') return { kind: 'approve' };
  if (normalized === 'R' || normalized === 'REJECT') return { kind: 'reject' };

  const actionAliases: Partial<Record<string, ApprovalDecision>> = {
    SEARCH: { kind: 'alternative', action: 'SEARCH_REPO' },
    SEARCH_REPO: { kind: 'alternative', action: 'SEARCH_REPO' },
    READ: { kind: 'alternative', action: 'READ_FILE' },
    READ_FILE: { kind: 'alternative', action: 'READ_FILE' },
    TEST: { kind: 'alternative', action: 'RUN_TESTS' },
    RUN_TESTS: { kind: 'alternative', action: 'RUN_TESTS' },
    CODEX: { kind: 'alternative', action: 'CALL_CODEX' },
    CALL_CODEX: { kind: 'alternative', action: 'CALL_CODEX' },
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

function printApprovalProposal(context: ApprovalContext): void {
  const { evaluation, policy, proposal } = context;
  const { assessment } = evaluation;
  console.log(`\nIteration ${context.state.iteration}`);
  console.log(`Jev requested: ${policy.requested}`);
  console.log('Next-action distribution');
  printDistribution(assessment.nextAction.probabilities);
  console.log(`Policy selected: ${policy.selected}${policy.override ? ' (override)' : ''}`);
  console.log(`Reason: ${policy.reason}`);
  console.log(`Safe candidate: ${proposal.action}`);
  console.log(`Tool: ${proposal.tool ?? 'none'}`);
  console.log(`Parameters: ${JSON.stringify(proposal.input)}`);
  if ('reason' in proposal) console.log(`Candidate reason: ${proposal.reason}`);
  console.log(`Allowed alternatives: ${context.allowedAlternatives.join(', ')}`);
  if (proposal.action === 'ASK_USER' && context.allowedAlternatives.includes('FINISH')) {
    console.log('Validated finish override: enter FINISH, review it, then enter approve.');
  }
}

async function promptForApproval(
  terminal: Interface,
  context: ApprovalContext,
): Promise<ApprovalDecision> {
  printApprovalProposal(context);
  while (true) {
    const answer = await terminal.question(
      'Choose approve, reject, or an allowed action name: ',
    );
    const decision = approvalChoice(answer, context);
    if (decision) return decision;
    console.log('Invalid choice. No repository action has run.');
  }
}

export async function runCliOrchestration(options: CliOptions): Promise<OrchestrationResult> {
  const repo = await inspectRepo(options.repoPath);
  if (!options.mock) requireGatewayApiKey();
  const state = createInitialState(repo, options.task);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });

  console.log('\nJev Orchestrator — approval-gated orchestration');
  console.log(`Repo: ${repo.root}`);
  console.log(`Task: ${options.task}`);
  console.log(`Mode: ${options.mock ? 'mock' : 'live Jev'}`);
  console.log('No repository action runs without approval.');

  try {
    return await runOrchestration(state, {
      evaluate: async (currentState) => options.mock
        ? mockEvaluation(currentState)
        : evaluateAgentState(currentState),
      approve: async (context) => promptForApproval(terminal, context),
      askForInformation: async () => terminal.question('Provide the required information: '),
    });
  } finally {
    terminal.close();
  }
}

function printHumanDecision(decision: DecisionOutput): void {
  const { assessment, policy } = decision;
  console.log('\nJev Orchestrator — decision-only milestone');
  console.log('Status: unexecuted decision (no tools or coding agents ran)\n');
  console.log(`Repo: ${decision.repo.root}`);
  console.log(`Task: ${decision.task}`);
  console.log(`Mode: ${decision.mode === 'mock' ? 'mock' : 'live Jev'}\n`);
  console.log(`Task complete       ${percent(assessment.taskComplete.probability)}`);
  console.log(`Needs information  ${percent(assessment.needsMoreInformation.probability)}`);
  console.log(`Needs testing      ${percent(assessment.needsTesting.probability)}`);
  console.log(`Stuck              ${percent(assessment.stuck.probability)}\n`);
  console.log('Next-action distribution');
  printDistribution(assessment.nextAction.probabilities);
  console.log(`\nJev requested: ${policy.requested}`);
  console.log(`Policy selected (unexecuted): ${policy.selected}${policy.override ? ' (override)' : ''}`);
  console.log(`Reason: ${policy.reason}`);
  console.log(`Latency: ${decision.latencyMs}ms`);
  if (decision.tracePath !== undefined) console.log(`Trace: ${decision.tracePath}`);
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

function errorOutput(error: unknown): ErrorOutput {
  const usage = error instanceof CliUsageError;
  return {
    schemaVersion: 1,
    status: 'error',
    error: {
      kind: usage ? 'usage' : 'operational',
      message: error instanceof Error ? error.message : String(error),
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
    console.log(`\nLoop status: ${result.status}`);
    console.log(`Iterations: ${result.iterations}`);
    console.log(`Trace: ${path.relative(process.cwd(), result.tracePath)}`);
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
    if (wantsJsonError(process.argv.slice(2))) {
      console.error(JSON.stringify(errorOutput(error)));
    } else {
      console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = exitCodeFor(error);
  });
}
