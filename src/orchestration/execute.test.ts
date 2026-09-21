import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeCandidate,
  DIAGNOSTIC_TIMEOUT_MS,
  FORCE_KILL_GRACE_MS,
  MAX_READ_FILE_BYTES,
  SEARCH_TIMEOUT_MS,
  ToolExecutionError,
  VALIDATION_TIMEOUT_MS,
  type ProcessRunner,
  runProcess,
} from './execute.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-execute-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('constrained execution', () => {
  it('uses direct rg arguments and normalizes bounded search results', async () => {
    const root = await temporaryRoot();
    const runner = vi.fn<ProcessRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: './src/z.ts\n./src/a.ts\n./src/a.ts\n',
      stderr: '',
      timedOut: false,
    });

    const result = await executeCandidate({
      action: 'SEARCH_REPO',
      tool: 'rg',
      input: { root, terms: ['auth; rm -rf', 'preview'] },
    }, runner);

    expect(result).toMatchObject({ ok: true, files: ['src/a.ts', 'src/z.ts'] });
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      command: 'rg',
      cwd: root,
      timeoutMs: SEARCH_TIMEOUT_MS,
      args: expect.arrayContaining(['--fixed-strings', '-e', 'auth; rm -rf']),
    }));
  });

  it('treats rg no-match as a successful empty investigation', async () => {
    const root = await temporaryRoot();
    const result = await executeCandidate({
      action: 'SEARCH_REPO',
      tool: 'rg',
      input: { root, terms: ['missing'] },
    }, async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false }));

    expect(result).toMatchObject({ ok: true, exitCode: 1, files: [] });
  });

  it('reads a bounded repository file and rejects oversized content', async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, 'small.ts'), 'export const small = true;');
    await writeFile(path.join(root, 'large.ts'), 'x'.repeat(MAX_READ_FILE_BYTES + 1));

    await expect(executeCandidate({
      action: 'READ_FILE',
      tool: 'read_file',
      input: { root, path: 'small.ts' },
    })).resolves.toMatchObject({ ok: true, output: 'export const small = true;' });
    await expect(executeCandidate({
      action: 'READ_FILE',
      tool: 'read_file',
      input: { root, path: 'large.ts' },
    })).resolves.toMatchObject({ ok: false, output: expect.stringContaining('read limit') });
  });

  it('runs only the resolved package script command and records failures and timeouts', async () => {
    const root = await temporaryRoot();
    const runner = vi.fn<ProcessRunner>().mockResolvedValue({
      exitCode: null,
      stdout: '',
      stderr: 'terminated',
      timedOut: true,
    });
    const result = await executeCandidate({
      action: 'RUN_TESTS',
      tool: 'package_script',
      input: {
        root,
        packageManager: 'pnpm',
        script: 'test',
        command: 'pnpm',
        args: ['run', 'test'],
      },
    }, runner);

    expect(result).toMatchObject({ ok: false, timedOut: true, exitCode: null });
    expect(runner).toHaveBeenCalledWith({
      command: 'pnpm',
      args: ['run', 'test'],
      cwd: root,
      timeoutMs: VALIDATION_TIMEOUT_MS,
    });
  });

  it('runs only an exact allowlisted diagnostic with a short timeout', async () => {
    const root = await temporaryRoot();
    const runner = vi.fn<ProcessRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: ' M src/auth.ts\n',
      stderr: '',
      timedOut: false,
    });
    const result = await executeCandidate({
      action: 'RUN_COMMAND',
      tool: 'diagnostic_command',
      input: {
        root,
        diagnostic: 'git_status',
        command: 'git',
        args: [
          '--no-pager',
          '--no-optional-locks',
          '-c',
          'core.fsmonitor=false',
          'status',
          '--short',
          '--untracked-files=all',
          '--no-renames',
          '--ignore-submodules=all',
          '--',
          '.',
          ':(exclude)traces/**',
        ],
      },
    }, runner);

    expect(result).toMatchObject({
      action: 'RUN_COMMAND',
      ok: true,
      output: 'M src/auth.ts',
    });
    expect(runner).toHaveBeenCalledWith({
      command: 'git',
      args: [
        '--no-pager',
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        'status',
        '--short',
        '--untracked-files=all',
        '--no-renames',
        '--ignore-submodules=all',
        '--',
        '.',
        ':(exclude)traces/**',
      ],
      cwd: root,
      timeoutMs: DIAGNOSTIC_TIMEOUT_MS,
    });
  });

  it('rejects modified diagnostic arguments before spawning a process', async () => {
    const root = await temporaryRoot();
    const runner = vi.fn<ProcessRunner>();

    await expect(executeCandidate({
      action: 'RUN_COMMAND',
      tool: 'diagnostic_command',
      input: {
        root,
        diagnostic: 'git_status',
        command: 'git',
        args: ['status', '--porcelain', '--', '../outside'],
      },
    }, runner)).rejects.toThrow('fixed command allowlist');
    await expect(executeCandidate({
      action: 'RUN_COMMAND',
      tool: 'diagnostic_command',
      input: {
        root,
        diagnostic: 'not_allowlisted',
        command: 'git',
        args: ['status'],
      },
    } as unknown as Parameters<typeof executeCandidate>[0], runner)).rejects.toThrow(
      'fixed command allowlist',
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it('normalizes a diagnostic timeout', async () => {
    const root = await temporaryRoot();
    const result = await executeCandidate({
      action: 'RUN_COMMAND',
      tool: 'diagnostic_command',
      input: {
        root,
        diagnostic: 'git_diff_stat',
        command: 'git',
        args: [
          '--no-pager',
          '--no-optional-locks',
          '-c',
          'core.fsmonitor=false',
          'diff',
          '--stat',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--ignore-submodules=all',
          'HEAD',
          '--',
          '.',
          ':(exclude)traces/**',
        ],
      },
    }, async () => ({
      exitCode: null,
      stdout: '',
      stderr: 'terminated',
      timedOut: true,
    }));

    expect(result).toMatchObject({
      action: 'RUN_COMMAND',
      ok: false,
      exitCode: null,
      timedOut: true,
      output: 'terminated',
    });
  });

  it('routes CALL_CODEX through the bounded typed adapter', async () => {
    const root = await temporaryRoot();
    const runner = vi.fn<ProcessRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: 'Implemented and validated the change.',
      stderr: 'progress details',
      timedOut: false,
    });
    const result = await executeCandidate({
      action: 'CALL_CODEX',
      tool: 'codex_cli',
      input: { root, task: 'Fix preview authentication' },
    }, runner);

    expect(result).toMatchObject({
      action: 'CALL_CODEX',
      ok: true,
      exitCode: 0,
      output: 'Implemented and validated the change.',
      files: [],
      stdout: 'Implemented and validated the change.',
      stderr: 'progress details',
    });
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      command: 'codex',
      cwd: root,
      args: expect.arrayContaining(['exec', '--sandbox', 'workspace-write']),
    }));
  });

  it('routes CALL_CLAUDE through the bounded typed adapter', async () => {
    const root = await temporaryRoot();
    const runner = vi.fn<ProcessRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: 'Implemented the requested change.',
      stderr: 'Claude progress details.',
      timedOut: false,
    });
    const result = await executeCandidate({
      action: 'CALL_CLAUDE',
      tool: 'claude_code_cli',
      input: { root, task: 'Fix preview authentication' },
    }, runner);

    expect(result).toMatchObject({
      action: 'CALL_CLAUDE',
      ok: true,
      exitCode: 0,
      output: 'Implemented the requested change.',
      files: [],
      stdout: 'Implemented the requested change.',
      stderr: 'Claude progress details.',
    });
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      command: 'claude',
      cwd: root,
      args: expect.arrayContaining(['--model', 'sonnet', '--effort', 'medium']),
    }));
  });

  it('rejects malformed process results and non-tool actions', async () => {
    const root = await temporaryRoot();
    const malformed = (async () => ({
      exitCode: 0,
      stdout: 42,
      stderr: '',
      timedOut: false,
    })) as unknown as ProcessRunner;

    await expect(executeCandidate({
      action: 'SEARCH_REPO',
      tool: 'rg',
      input: { root, terms: ['auth'] },
    }, malformed)).rejects.toBeInstanceOf(ToolExecutionError);
    await expect(executeCandidate({
      action: 'FINISH',
      tool: null,
      input: null,
      reason: 'Done',
    })).rejects.toThrow('does not execute');
    await expect(executeCandidate({
      action: 'RUN_TESTS',
      tool: 'package_script',
      input: {
        root,
        packageManager: 'pnpm',
        script: 'test',
        command: 'sh',
        args: ['-c', 'echo unsafe'],
      },
    }, async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }))).rejects.toThrow(
      'does not match',
    );
  });

  it('force-kills a process that ignores the execution timeout', async () => {
    const root = await temporaryRoot();
    const startedAt = performance.now();
    const result = await runProcess({
      command: process.execPath,
      args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);"],
      cwd: root,
      timeoutMs: 200,
    });

    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    expect(performance.now() - startedAt).toBeLessThan(FORCE_KILL_GRACE_MS + 1_000);
  });
});
