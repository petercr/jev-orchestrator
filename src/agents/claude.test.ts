import { describe, expect, it, vi } from 'vitest';
import { MAX_TASK_LENGTH } from '../limits.js';
import type { ProcessRunner } from '../process.js';
import {
  buildClaudePrompt,
  CLAUDE_EFFORT,
  CLAUDE_MAX_TURNS,
  CLAUDE_MODEL,
  CLAUDE_TIMEOUT_MS,
  createClaudeAdapter,
} from './claude.js';

describe('Claude adapter', () => {
  it('uses fixed Sonnet medium settings and file-only restricted tools', async () => {
    const runner = vi.fn<ProcessRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: 'Implemented the fix.',
      stderr: '',
      timedOut: false,
    });
    const result = await createClaudeAdapter(runner)({
      root: '/repo',
      task: '--dangerously-skip-permissions',
    });

    expect(result).toMatchObject({
      agent: 'claude',
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: 'Implemented the fix.',
    });
    expect(runner).toHaveBeenCalledWith({
      command: 'claude',
      args: [
        '-p',
        '--model',
        CLAUDE_MODEL,
        '--effort',
        CLAUDE_EFFORT,
        '--output-format',
        'text',
        '--permission-mode',
        'acceptEdits',
        '--permission-prompts',
        'none',
        '--max-turns',
        String(CLAUDE_MAX_TURNS),
        '--no-session-persistence',
        '--safe-mode',
        '--restricted',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--no-chrome',
        '--tools',
        'Read,Write,Edit,Glob,Grep',
        '--',
        buildClaudePrompt('--dangerously-skip-permissions'),
      ],
      cwd: '/repo',
      timeoutMs: CLAUDE_TIMEOUT_MS,
    });
  });

  it('normalizes failures and timeouts', async () => {
    const result = await createClaudeAdapter(async () => ({
      exitCode: null,
      stdout: 'partial output',
      stderr: 'timed out',
      timedOut: true,
    }))({ root: '/repo', task: 'Fix the bug' });

    expect(result).toMatchObject({
      agent: 'claude',
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

    await expect(createClaudeAdapter(malformed)({
      root: '/repo',
      task: 'Fix the bug',
    })).rejects.toThrow('malformed result');
    await expect(createClaudeAdapter()({
      root: '/repo',
      task: 'x'.repeat(MAX_TASK_LENGTH + 1),
    })).rejects.toThrow('character limit');
  });
});
