import { describe, expect, it } from 'vitest';
import {
  CliUsageError,
  createDecisionOutput,
  EXIT_CODES,
  exitCodeFor,
  parseArgs,
} from './cli.js';
import { mockEvaluation } from './mock.js';
import type { AgentState, PolicyDecision } from './types.js';

const state: AgentState = {
  task: 'Inspect the repository',
  iteration: 1,
  currentGoal: 'Choose an action',
  repo: {
    root: '/repo',
    packageManager: 'pnpm',
    scripts: ['test'],
    validationScripts: ['test'],
    gitStatus: [],
    topLevelFiles: ['package.json'],
  },
  filesRead: [],
  filesModified: [],
  observations: [],
  commandsRun: [],
  tests: { ran: false },
  failedApproaches: [],
  codexCalls: 0,
};

const policy: PolicyDecision = {
  requested: 'SEARCH_REPO',
  selected: 'SEARCH_REPO',
  override: false,
  reason: 'Clear recommendation.',
};

describe('parseArgs', () => {
  it('parses known flags independently of positional argument order', () => {
    expect(parseArgs(['--mock', '/repo', '--json', 'Inspect', 'this', '--no-trace'])).toEqual({
      kind: 'run',
      options: {
        repoPath: '/repo',
        task: 'Inspect this',
        mock: true,
        noTrace: true,
        json: true,
      },
    });
  });

  it('ignores the Node argument separator added by pnpm dev', () => {
    expect(parseArgs(['--', '/repo', 'Inspect', '--mock', '--json'])).toEqual({
      kind: 'run',
      options: {
        repoPath: '/repo',
        task: 'Inspect',
        mock: true,
        noTrace: false,
        json: true,
      },
    });
  });

  it('treats arguments after -- as positional task text', () => {
    expect(parseArgs(['/repo', 'Investigate', '--', '--not-a-flag'])).toEqual({
      kind: 'run',
      options: {
        repoPath: '/repo',
        task: 'Investigate --not-a-flag',
        mock: false,
        noTrace: false,
        json: false,
      },
    });
  });

  it('returns help and version commands without a decision request', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
  });

  it('rejects unknown flags and incomplete decision requests', () => {
    expect(() => parseArgs(['/repo', 'Inspect', '--unsafe'])).toThrow(CliUsageError);
    expect(() => parseArgs(['/repo'])).toThrow(CliUsageError);
    expect(() => parseArgs(['--help', '--mock'])).toThrow(CliUsageError);
  });
});

describe('CLI output contract', () => {
  it('creates a bounded JSON decision with explicit unexecuted status', () => {
    const output = createDecisionOutput(state, mockEvaluation(), policy, 'mock', 'traces/run.jsonl');
    const serialized = JSON.parse(JSON.stringify(output)) as Record<string, unknown>;

    expect(serialized).toMatchObject({
      schemaVersion: 1,
      status: 'unexecuted',
      mode: 'mock',
      task: state.task,
      policy,
      tracePath: 'traces/run.jsonl',
    });
    expect(serialized).not.toHaveProperty('rawAnswers');
    expect(serialized).not.toHaveProperty('providerMetadata');
  });

  it('omits the trace path when tracing is disabled', () => {
    const output = createDecisionOutput(state, mockEvaluation(), policy, 'mock');

    expect(output).not.toHaveProperty('tracePath');
  });

  it('uses distinct usage and operational exit codes', () => {
    expect(exitCodeFor(new CliUsageError('Bad input'))).toBe(EXIT_CODES.usageError);
    expect(exitCodeFor(new Error('Gateway unavailable'))).toBe(EXIT_CODES.operationalError);
  });
});
