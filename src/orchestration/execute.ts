import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { resolveSafeRepoFile, type CandidateProposal } from './candidate.js';

export const MAX_TOOL_OUTPUT_BYTES = 16 * 1024;
export const MAX_SEARCH_RESULTS = 50;
export const MAX_READ_FILE_BYTES = 64 * 1024;
export const SEARCH_TIMEOUT_MS = 10_000;
export const VALIDATION_TIMEOUT_MS = 120_000;

export type ProcessRequest = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
};

export type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

export type ToolResult = {
  action: CandidateProposal['action'];
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  output: string;
  files: string[];
};

export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

function appendBounded(current: Buffer[], chunk: Buffer, byteCount: { value: number }): void {
  const available = MAX_TOOL_OUTPUT_BYTES - byteCount.value;
  if (available <= 0) return;
  const bounded = chunk.subarray(0, available);
  current.push(bounded);
  byteCount.value += bounded.length;
}

export const runProcess: ProcessRunner = async (request) => new Promise((resolve, reject) => {
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const stdoutBytes = { value: 0 };
  const stderrBytes = { value: 0 };
  let timedOut = false;
  let settled = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, request.timeoutMs);
  timeout.unref();

  child.stdout.on('data', (chunk: Buffer) => appendBounded(stdout, chunk, stdoutBytes));
  child.stderr.on('data', (chunk: Buffer) => appendBounded(stderr, chunk, stderrBytes));
  child.on('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    reject(new ToolExecutionError(`Unable to start ${request.command}: ${error.message}`));
  });
  child.on('close', (exitCode) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolve({
      exitCode,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut,
    });
  });
});

function validateProcessResult(result: ProcessResult): void {
  if (
    (result.exitCode !== null && !Number.isInteger(result.exitCode)) ||
    typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string' ||
    typeof result.timedOut !== 'boolean'
  ) {
    throw new ToolExecutionError('The process runner returned a malformed result.');
  }
}

function normalizedOutput(result: ProcessResult): string {
  const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  return combined || (result.timedOut ? 'Process timed out.' : 'Process produced no output.');
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
  validateProcessResult(result);
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
