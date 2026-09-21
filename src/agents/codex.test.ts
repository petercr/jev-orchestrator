import { describe, expect, it, vi } from 'vitest';
import { MAX_TASK_LENGTH } from '../limits.js';
import type { ProcessRunner } from '../process.js';
import { buildCodexPrompt, CODEX_TIMEOUT_MS, createCodexAdapter } from './codex.js';

describe('Codex adapter', () => {
  it('uses fixed non-interactive arguments, a writable sandbox, and no shell', async () => {
    const runner = vi.fn<ProcessRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: 'Implemented the fix.',
      stderr: '',
      timedOut: false,
    });
    const result = await createCodexAdapter(runner)({
      root: '/repo',
      task: '--dangerously-bypass-approvals-and-sandbox',
    });

    expect(result).toMatchObject({
      agent: 'codex',
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: 'Implemented the fix.',
    });
    expect(runner).toHaveBeenCalledWith({
      command: 'codex',
      args: [
        '--ask-for-approval',
        'never',
        'exec',
        '--cd',
        '/repo',
        '--sandbox',
        'workspace-write',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--color',
        'never',
        '--',
        buildCodexPrompt('--dangerously-bypass-approvals-and-sandbox'),
      ],
      cwd: '/repo',
      timeoutMs: CODEX_TIMEOUT_MS,
    });
  });

  it('normalizes failures and timeouts', async () => {
    const result = await createCodexAdapter(async () => ({
      exitCode: null,
      stdout: 'partial output',
      stderr: 'timed out',
      timedOut: true,
    }))({ root: '/repo', task: 'Fix the bug' });

    expect(result).toMatchObject({
      ok: false,
      exitCode: null,
      timedOut: true,
      stdout: 'partial output',
      stderr: 'timed out',
    });
  });

  it('rejects malformed process results and unbounded tasks', async () => {
    const malformed = (async () => ({
      exitCode: 0,
      stdout: 42,
      stderr: '',
      timedOut: false,
    })) as unknown as ProcessRunner;

    await expect(createCodexAdapter(malformed)({
      root: '/repo',
      task: 'Fix the bug',
    })).rejects.toThrow('malformed result');
    await expect(createCodexAdapter()({
      root: '/repo',
      task: 'x'.repeat(MAX_TASK_LENGTH + 1),
    })).rejects.toThrow('character limit');
  });
});
