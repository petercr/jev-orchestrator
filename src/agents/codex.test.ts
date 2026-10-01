import { describe, expect, it, vi } from 'vitest';
import { MAX_TASK_LENGTH } from '../limits.js';
import type { WorkerContext } from './context.js';
import type { ProcessRunner } from '../process.js';
import {
  buildCodexPrompt,
  CODEX_MODEL,
  CODEX_REASONING_EFFORT,
  CODEX_TIMEOUT_MS,
  createCodexAdapter,
} from './codex.js';

describe('Codex adapter', () => {
  it('uses Terra with high reasoning, fixed non-interactive arguments, and no shell', async () => {
    const runner = vi.fn<ProcessRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: 'Implemented the fix.',
      stderr: '',
      timedOut: false,
    });
    const context: WorkerContext = {
      validationGeneration: 1,
      goal: 'Repair failed validation',
      clarifications: [{ iteration: 2, text: 'The user expects a 401 response.' }],
      findings: [],
      failures: [],
      remainingCalls: { codex: 1, claude: 2 },
      validation: {
        iteration: 2, generation: 1, script: 'test', exitCode: 1,
        timedOut: false, passed: false, summary: 'Expected 401, received 200',
      },
    };
    const result = await createCodexAdapter(runner)({
      root: '/repo',
      task: '--dangerously-bypass-approvals-and-sandbox',
      context,
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
        '--model',
        CODEX_MODEL,
        '--config',
        `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
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
        buildCodexPrompt('--dangerously-bypass-approvals-and-sandbox', context),
      ],
      cwd: '/repo',
      timeoutMs: CODEX_TIMEOUT_MS,
    });
    expect(buildCodexPrompt('Fix the bug', context)).toContain('Expected 401, received 200');
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
