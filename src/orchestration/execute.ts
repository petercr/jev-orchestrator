import { open } from 'node:fs/promises';
import path from 'node:path';
import { createCodexAdapter } from '../agents/codex.js';
import { createClaudeAdapter } from '../agents/claude.js';
import type { CodingAgentResult } from '../agents/types.js';
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
export const VALIDATION_TIMEOUT_MS = 120_000;

export type ToolResult = {
  action: CandidateProposal['action'];
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  output: string;
  files: string[];
  stdout?: string;
  stderr?: string;
};

export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

function normalizedOutput(result: ProcessResult): string {
  const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  return combined || (result.timedOut ? 'Process timed out.' : 'Process produced no output.');
}

function normalizedAgentOutput(result: ProcessResult): string {
  const finalMessage = result.stdout.trim();
  if (finalMessage) return finalMessage;
  const diagnostics = result.stderr.trim();
  return diagnostics || (result.timedOut ? 'Process timed out.' : 'Process produced no output.');
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
    output: normalizedAgentOutput(result),
    files: [],
    stdout: result.stdout,
    stderr: result.stderr,
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
      files: [safeRelativePath],
    };
  } finally {
    await file.close();
  }
}

export async function executeCandidate(
  proposal: CandidateProposal,
  runner: ProcessRunner = runProcess,
): Promise<ToolResult> {
  if (proposal.action === 'ASK_USER' || proposal.action === 'FINISH') {
    throw new ToolExecutionError(`${proposal.action} does not execute a repository tool.`);
  }
  if (proposal.action === 'READ_FILE') return executeRead(proposal);
  if (proposal.action === 'CALL_CODEX') {
    const result = await createCodexAdapter(runner)({
      root: proposal.input.root,
      task: proposal.input.task,
    });
    return codingAgentToolResult(proposal.action, result);
  }
  if (proposal.action === 'CALL_CLAUDE') {
    const result = await createClaudeAdapter(runner)({
      root: proposal.input.root,
      task: proposal.input.task,
    });
    return codingAgentToolResult(proposal.action, result);
  }

  if (proposal.action === 'RUN_TESTS') {
    const expectedCommand = proposal.input.packageManager;
    const expectedArgs = ['run', proposal.input.script];
    if (
      proposal.input.command !== expectedCommand ||
      proposal.input.args.length !== expectedArgs.length ||
      proposal.input.args.some((arg, index) => arg !== expectedArgs[index])
    ) {
      throw new ToolExecutionError('The validation proposal does not match its package-manager script.');
    }
  }

  const startedAt = performance.now();
  const request: ProcessRequest = proposal.action === 'SEARCH_REPO'
    ? {
      command: 'rg',
      args: searchArgs(proposal.input.terms),
      cwd: proposal.input.root,
      timeoutMs: SEARCH_TIMEOUT_MS,
    }
    : {
      command: proposal.input.command,
      args: proposal.input.args,
      cwd: proposal.input.root,
      timeoutMs: VALIDATION_TIMEOUT_MS,
    };
  const result = await runner(request);
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

  return {
    action: proposal.action,
    ok: !result.timedOut && (result.exitCode === 0 || successfulSearch),
    exitCode: result.exitCode,
    durationMs: Math.round(performance.now() - startedAt),
    timedOut: result.timedOut,
    output: normalizedOutput(result),
    files,
  };
}
