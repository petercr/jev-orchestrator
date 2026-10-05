import { describe, expect, it, vi } from 'vitest';
import { MAX_TASK_LENGTH } from '../limits.js';
import type { WorkerContext } from './context.js';
import type { ProcessRunner } from '../process.js';
import {
  buildClaudePrompt,
  buildClaudeToolsConfig,
  CLAUDE_SESSION_SETTINGS,
  CLAUDE_EFFORT,
  CLAUDE_MAX_TURNS,
  CLAUDE_MODEL,
  CLAUDE_TIMEOUT_MS,
  createClaudeAdapter,
} from './claude.js';

describe('Claude adapter', () => {
  it('uses fixed Sonnet medium settings, restricted file tools and the private rename tool', async () => {
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
      remainingCalls: { codex: 2, claude: 1 },
      validation: {
        iteration: 2, generation: 1, script: 'test', exitCode: 1,
        timedOut: false, passed: false, summary: 'Expected 401, received 200',
      },
    };
    const result = await createClaudeAdapter(runner)({
      root: '/repo',
      task: '--dangerously-skip-permissions',
      context,
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
        '--restricted',
        '--setting-sources',
        '',
        '--settings',
        JSON.stringify(CLAUDE_SESSION_SETTINGS),
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--no-chrome',
        '--tools',
        'Read,Write,Edit,Glob,Grep',
        '--mcp-config',
        buildClaudeToolsConfig('/repo'),
        '--allowedTools',
        'mcp__jev_files__rename_file',
        '--',
        buildClaudePrompt('--dangerously-skip-permissions', context),
      ],
      cwd: '/repo',
      timeoutMs: CLAUDE_TIMEOUT_MS,
    });
    expect(buildClaudePrompt('Fix the bug', context)).toContain('Expected 401, received 200');
    expect(buildClaudePrompt('Rename the config')).toContain('mcp__jev_files__rename_file');
    expect(buildClaudePrompt('Rename the config')).toContain('Do not copy a file to simulate a rename');
    expect(buildClaudePrompt('Rename the config')).toContain('delete unrelated files');
    const configuration = JSON.parse(buildClaudeToolsConfig('/repo with spaces'));
    expect(Object.keys(configuration.mcpServers)).toEqual(['jev_files']);
    expect(configuration.mcpServers.jev_files).toMatchObject({ type: 'stdio', command: process.execPath });
    expect(configuration.mcpServers.jev_files.args.at(-1)).toBe('/repo with spaces');
    expect(configuration.mcpServers.jev_files.args).not.toContain('--env-file');
    expect(CLAUDE_SESSION_SETTINGS).toMatchObject({
      disableAllHooks: true,
      autoMemoryEnabled: false,
      enabledPlugins: {},
      claudeMdExcludes: ['**/CLAUDE.md', '**/CLAUDE.local.md', '**/CLAUDE.override.md', '**/.claude/rules/**'],
    });
    const args = runner.mock.calls[0]?.[0].args ?? [];
    expect(args).not.toContain('--safe-mode');
    expect(args).toContain('--restricted');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('mcp__jev_files__rename_file');
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
