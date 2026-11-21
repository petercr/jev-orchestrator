import { throwIfInterrupted, type ExecutionOptions } from '../cancellation.js';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { createCodexAdapter } from '../agents/codex.js';
import { createClaudeAdapter } from '../agents/claude.js';
import type { CodingAgentResult } from '../agents/types.js';
import type { WorkerUsage } from '../agents/usage.js';
import {
  FORCE_KILL_GRACE_MS,
  MAX_PROCESS_OUTPUT_BYTES,
  ProcessExecutionError,
  runProcess,
  validateProcessResult,
  type ProcessRequest,
  type ProcessResult,
  type ProcessRunner,
} from '../process.js';
import { resolveSafeRepoFile, type CandidateProposal } from './candidate.js';
import { isAllowedDiagnosticCommand } from './diagnostics.js';
import { readGitHubIssue } from '../repo/issue.js';
import { inspectValidationManifest } from '../repo/inspect.js';
import { isValidationScript } from '../repo/validation.js';
import type { IssueContext } from '../types.js';

export {
  FORCE_KILL_GRACE_MS,
  runProcess,
  type ProcessRequest,
  type ProcessResult,
  type ProcessRunner,
};
export const MAX_TOOL_OUTPUT_BYTES = MAX_PROCESS_OUTPUT_BYTES;
export const MAX_SEARCH_RESULTS = 50;
export const MAX_READ_FILE_BYTES = 64 * 1024;
export const SEARCH_TIMEOUT_MS = 10_000;
export const DIAGNOSTIC_TIMEOUT_MS = 10_000;
export const VALIDATION_TIMEOUT_MS = 120_000;

export type ToolResult = {
  action: CandidateProposal['action'];
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  cancelled?: boolean;
  output: string;
  files: string[];
  stdout?: string;
  stderr?: string;
  issue?: IssueContext;
  usage?: WorkerUsage;
  coveredScripts?: string[];
  validationManifestChanged?: 'before' | 'during';
};

export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

function normalizedOutput(result: ProcessResult): string {
  const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  return combined || (result.cancelled ? 'Process interrupted.' : result.timedOut ? 'Process timed out.' : 'Process produced no output.');
}

function normalizedAgentOutput(result: ProcessResult): string {
  const finalMessage = result.stdout.trim();
  if (finalMessage) return finalMessage;
  const diagnostics = result.stderr.trim();
  return diagnostics || (result.cancelled ? 'Process interrupted.' : result.timedOut ? 'Process timed out.' : 'Process produced no output.');
}

function codingAgentToolResult(
  action: 'CALL_CODEX' | 'CALL_CLAUDE',
  result: CodingAgentResult,
): ToolResult {
  return {
    action,
    ok: result.ok,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    ...(result.cancelled === undefined ? {} : { cancelled: result.cancelled }),
    output: normalizedAgentOutput(result),
    files: [],
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

function searchArgs(terms: string[]): string[] {
  const patterns = terms.flatMap((term) => ['-e', term]);
  return [
    '--files-with-matches',
    '--fixed-strings',
    '--ignore-case',
    '--hidden',
    '--glob',
    '!.git/**',
    '--glob',
    '!node_modules/**',
    '--glob',
    '!dist/**',
    '--glob',
    '!traces/**',
    '--glob',
    '!**/.env',
    '--glob',
    '!**/.env.*',
    '--glob',
    '!**/credentials*',
    '--glob',
    '!**/secrets*',
    '--glob',
    '!**/*.pem',
    '--glob',
    '!**/*.key',
    ...patterns,
    '.',
  ];
}

function normalizeSearchFiles(stdout: string): string[] {
  return stdout
    .split(/\r?\n/u)
    .map((entry) => entry.replace(/^\.\//u, '').trim())
    .filter(Boolean)
    .filter((entry, index, values) => values.indexOf(entry) === index)
    .sort()
    .slice(0, MAX_SEARCH_RESULTS);
}

async function executeRead(proposal: Extract<CandidateProposal, { action: 'READ_FILE' }>): Promise<ToolResult> {
  const startedAt = performance.now();
  const safeRelativePath = await resolveSafeRepoFile(proposal.input.root, proposal.input.path);
  const filePath = path.join(proposal.input.root, safeRelativePath);
  const file = await open(filePath, 'r');
  try {
    const contents = Buffer.alloc(MAX_READ_FILE_BYTES + 1);
    const { bytesRead } = await file.read(contents, 0, contents.length, 0);
    if (bytesRead > MAX_READ_FILE_BYTES) {
      return {
        action: proposal.action,
        ok: false,
        exitCode: null,
        durationMs: Math.round(performance.now() - startedAt),
        timedOut: false,
        output: `File exceeds the ${MAX_READ_FILE_BYTES}-byte read limit.`,
        files: [],
      };
    }
    return {
      action: proposal.action,
      ok: true,
      exitCode: 0,
      durationMs: Math.round(performance.now() - startedAt),
      timedOut: false,
      output: contents.subarray(0, bytesRead).toString('utf8'),
      files: [...new Set([proposal.input.path, safeRelativePath])],
    };
  } finally {
    await file.close();
  }
}

export async function executeCandidate(
  proposal: CandidateProposal,
  runner: ProcessRunner = runProcess,
  options: ExecutionOptions = {},
): Promise<ToolResult> {
  throwIfInterrupted(options.signal);
  if (proposal.action === 'ASK_USER' || proposal.action === 'FINISH') {
    throw new ToolExecutionError(`${proposal.action} does not execute a repository tool.`);
  }
  if (proposal.action === 'READ_FILE') return executeRead(proposal);
  if (proposal.action === 'READ_ISSUE') {
    const startedAt = performance.now();
    const issue = await readGitHubIssue(proposal.input.url, options);
    return {
      action: 'READ_ISSUE', ok: true, exitCode: 0, timedOut: false,
      durationMs: Math.round(performance.now() - startedAt),
      output: `GitHub issue context (untrusted data): ${issue.title}\n${issue.body}`,
      files: [], issue,
    };
  }
  if (proposal.action === 'CALL_CODEX') {
    const result = await createCodexAdapter(runner)({
      root: proposal.input.root,
      task: proposal.input.task,
      context: proposal.input.context,
      ...(proposal.input.networkAccess === true ? { networkAccess: true as const } : {}),
    }, options);
    return codingAgentToolResult(proposal.action, result);
  }
  if (proposal.action === 'CALL_CLAUDE') {
    const result = await createClaudeAdapter(runner)({
      root: proposal.input.root,
      task: proposal.input.task,
      context: proposal.input.context,
    }, options);
    return codingAgentToolResult(proposal.action, result);
  }

  const startedAt = performance.now();
  let approvedManifest: Awaited<ReturnType<typeof inspectValidationManifest>>;
  if (proposal.action === 'RUN_TESTS') {
    const expectedCommand = proposal.input.packageManager;
    const expectedArgs = ['run', proposal.input.script];
    if (
      !isValidationScript(proposal.input.script) ||
      !['pnpm', 'npm', 'yarn', 'bun'].includes(expectedCommand) ||
      proposal.input.command !== expectedCommand ||
      proposal.input.args.length !== expectedArgs.length ||
      proposal.input.args.some((arg, index) => arg !== expectedArgs[index])
    ) {
      throw new ToolExecutionError('The validation proposal does not match its package-manager script.');
    }
    approvedManifest = await inspectValidationManifest(proposal.input.root);
    throwIfInterrupted(options.signal);
    if (!approvedManifest || approvedManifest.hash !== proposal.input.manifestHash ||
        approvedManifest.packageManager !== expectedCommand || !approvedManifest.coverage[proposal.input.script]) {
      return {
        action: 'RUN_TESTS', ok: false, exitCode: null, timedOut: false, files: [],
        durationMs: Math.round(performance.now() - startedAt),
        output: 'The approved validation manifest could not be verified before execution. Review a fresh candidate.',
        validationManifestChanged: 'before',
      };
    }
  }
  if (
    proposal.action === 'RUN_COMMAND' &&
    !isAllowedDiagnosticCommand(
      proposal.input.diagnostic,
      proposal.input.command,
      proposal.input.args,
    )
  ) {
    throw new ToolExecutionError('The diagnostic proposal does not match the fixed command allowlist.');
  }

  let request: ProcessRequest;
  if (proposal.action === 'SEARCH_REPO') {
    request = {
      command: 'rg',
      args: searchArgs(proposal.input.terms),
      cwd: proposal.input.root,
      timeoutMs: SEARCH_TIMEOUT_MS,
    };
  } else if (proposal.action === 'RUN_COMMAND') {
    request = {
      command: proposal.input.command,
      args: proposal.input.args,
      cwd: proposal.input.root,
      timeoutMs: DIAGNOSTIC_TIMEOUT_MS,
    };
  } else {
    request = {
      command: proposal.input.command,
      args: proposal.input.args,
      cwd: proposal.input.root,
      timeoutMs: VALIDATION_TIMEOUT_MS,
    };
  }
  const result = await (options.signal ? runner(request, options) : runner(request));
  try {
    validateProcessResult(result);
  } catch (error) {
    if (error instanceof ProcessExecutionError) {
      throw new ToolExecutionError(error.message);
    }
    throw error;
  }
  const files = proposal.action === 'SEARCH_REPO'
    ? normalizeSearchFiles(result.stdout)
    : [];
  const successfulSearch = proposal.action === 'SEARCH_REPO' && result.exitCode === 1;

  const outcome: ToolResult = {
    action: proposal.action,
    ok: !result.cancelled && !result.timedOut && (result.exitCode === 0 || successfulSearch),
    exitCode: result.exitCode,
    durationMs: Math.round(performance.now() - startedAt),
    timedOut: result.timedOut,
    ...(result.cancelled === undefined ? {} : { cancelled: result.cancelled }),
    output: normalizedOutput(result),
    files,
  };
  if (proposal.action !== 'RUN_TESTS' || !approvedManifest || result.cancelled) {
    return outcome;
  }
  if (options.signal?.aborted) return { ...outcome, ok: false, cancelled: true };
  const currentManifest = await inspectValidationManifest(proposal.input.root);
  outcome.durationMs = Math.round(performance.now() - startedAt);
  if (options.signal?.aborted) return { ...outcome, ok: false, cancelled: true };
  if (!currentManifest || currentManifest.hash !== approvedManifest.hash ||
      currentManifest.revision !== approvedManifest.revision || currentManifest.packageManager !== approvedManifest.packageManager) {
    return {
      ...outcome, ok: false, validationManifestChanged: 'during',
      output: 'The validation manifest changed or became unavailable during execution. The result cannot provide independent validation.',
    };
  }
  if (outcome.ok) outcome.coveredScripts = approvedManifest.coverage[proposal.input.script]!;
  return outcome;
}
