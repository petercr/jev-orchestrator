import type { ExecutionOptions } from './cancellation.js';
import { spawn } from 'node:child_process';

export const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024;
export const FORCE_KILL_GRACE_MS = 1_000;

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
  cancelled?: boolean;
};

export type ProcessRunner = (request: ProcessRequest, options?: ExecutionOptions) => Promise<ProcessResult>;

export class ProcessExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessExecutionError';
  }
}

function appendBounded(current: Buffer[], chunk: Buffer, byteCount: { value: number }): void {
  const available = MAX_PROCESS_OUTPUT_BYTES - byteCount.value;
  if (available <= 0) return;
  const bounded = chunk.subarray(0, available);
  current.push(bounded);
  byteCount.value += bounded.length;
}

export const runProcess: ProcessRunner = async (request, options = {}) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) {
    resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: true });
    return;
  }
  const useProcessGroup = process.platform !== 'win32';
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: process.env,
    detached: useProcessGroup,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const stdoutBytes = { value: 0 };
  const stderrBytes = { value: 0 };
  let timedOut = false;
  let settled = false;
  let cancelled = false;
  let closed = false;
  let closedExitCode: number | null = null;
  let forceKillTimeout: NodeJS.Timeout | undefined;
  const kill = (signal: NodeJS.Signals): void => {
    try {
      if (useProcessGroup && child.pid !== undefined) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      child.kill(signal);
    }
  };
  const finish = (): void => {
    if (settled || !closed || forceKillTimeout !== undefined) return;
    settled = true;
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    resolve({
      exitCode: closedExitCode,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut,
      ...(cancelled ? { cancelled: true } : {}),
    });
  };
  const terminate = (): void => {
    if (forceKillTimeout !== undefined || settled) return;
    kill('SIGTERM');
    // Keep escalation even if the parent closes: its process group may still
    // contain descendants that closed their inherited output and ignored TERM.
    forceKillTimeout = setTimeout(() => {
      kill('SIGKILL');
      forceKillTimeout = undefined;
      finish();
    }, FORCE_KILL_GRACE_MS);
  };
  const abort = (): void => {
    cancelled = true;
    clearTimeout(timeout);
    terminate();
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, request.timeoutMs);
  timeout.unref();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();

  child.stdout.on('data', (chunk: Buffer) => appendBounded(stdout, chunk, stdoutBytes));
  child.stderr.on('data', (chunk: Buffer) => appendBounded(stderr, chunk, stderrBytes));
  child.on('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout);
    options.signal?.removeEventListener('abort', abort);
    reject(new ProcessExecutionError(`Unable to start ${request.command}: ${error.message}`));
  });
  child.on('close', (exitCode) => {
    closed = true;
    closedExitCode = exitCode;
    finish();
  });
});

export function validateProcessResult(result: ProcessResult): void {
  if (
    (result.exitCode !== null && !Number.isInteger(result.exitCode)) ||
    typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string' ||
    typeof result.timedOut !== 'boolean' ||
    (result.cancelled !== undefined && typeof result.cancelled !== 'boolean')
  ) {
    throw new ProcessExecutionError('The process runner returned a malformed result.');
  }
}
