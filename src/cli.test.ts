import { describe, expect, it, vi } from 'vitest';
import {
  CliUsageError,
  createDecisionOutput,
  createErrorOutput,
  EXIT_CODES,
  exitCodeFor,
  formatEvaluationFailure,
  parseArgs,
  parseApprovalChoice,
  printApprovalProposal,
} from './cli.js';
import { buildWorkerContext } from './agents/context.js';
import { evaluationFailure, JevEvaluationError } from './ai/errors.js';
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
  claudeCalls: 0,
};

const policy: PolicyDecision = {
  requested: 'SEARCH_REPO',
  selected: 'SEARCH_REPO',
  override: false,
  reason: 'Clear recommendation.',
};

describe('evaluation error reporting', () => {
  it('exposes allowlisted evaluation diagnostics in the JSON error contract', () => {
    const error = new JevEvaluationError('invalid_response', 'Jev returned invalid evaluation data.', {
      stage: 'distribution', category: 'sum', probabilitySum: 0.99,
    });
    Object.assign(error.diagnostic, { rawBody: 'untrusted upstream body' });
    const output = JSON.parse(JSON.stringify(createErrorOutput(error)));
    expect(output).toMatchObject({
      schemaVersion: 1, status: 'error', exitCode: 1,
      error: { kind: 'operational', failure: { code: 'invalid_response', stage: 'distribution', category: 'sum', probabilitySum: 0.99 } },
    });
    expect(JSON.stringify(output)).not.toContain('untrusted upstream body');
  });

  it('omits unavailable numeric evidence and preserves the usage-error contract', () => {
    const error = new JevEvaluationError('invalid_response', 'Invalid.', { stage: 'answers', category: 'shape' });
    expect(createErrorOutput(error).error.failure).not.toHaveProperty('probabilitySum');
    expect(formatEvaluationFailure(evaluationFailure(error))).toBe('invalid_response at answers/shape');
    expect(createErrorOutput(new CliUsageError('Invalid flags.'))).toEqual({
      schemaVersion: 1, status: 'error', error: { kind: 'usage', message: 'Invalid flags.' }, exitCode: 2,
    });
  });

  it('shows a rejected zero total without hiding or rounding the evidence', () => {
    const error = new JevEvaluationError('invalid_response', 'Invalid.', { stage: 'distribution', category: 'sum', probabilitySum: 0 });
    expect(formatEvaluationFailure(evaluationFailure(error))).toBe('invalid_response at distribution/sum; probability sum 0, expected 1 (tolerance 0.001)');
  });
});

describe('parseArgs', () => {
  it.each(['codex', 'claude'] as const)('accepts a %s worker selection in either flag form', (workerSelection) => {
    expect(parseArgs(['--worker', workerSelection, '/repo', 'Fix task', '--orchestrate'])).toMatchObject({
      kind: 'run', options: { repoPath: '/repo', task: 'Fix task', workerSelection, orchestrate: true },
    });
    expect(parseArgs(['/repo', 'Inspect', `--worker=${workerSelection}`, '--mock', '--json'])).toMatchObject({
      kind: 'run', options: { workerSelection, json: true },
    });
  });

  it.each([
    ['--worker'], ['--worker', 'auto'], ['--worker', '--mock'], ['--worker='],
    ['--worker=unknown'], ['--worker', 'codex', '--worker=claude'], ['--worker=codex', '--worker', 'codex'],
  ])('rejects invalid or repeated worker flags: %s', (...flags) => {
    expect(() => parseArgs(['/repo', 'Inspect', ...flags])).toThrow(CliUsageError);
  });

  it('keeps worker-like text after the argument separator in the task', () => {
    const result = parseArgs(['/repo', 'Document', '--', '--worker', 'claude']);
    expect(result).toMatchObject({ kind: 'run', options: { task: 'Document --worker claude' } });
    if (result.kind === 'run') expect(result.options).not.toHaveProperty('workerSelection');
  });

  it('does not combine worker selection with informational flags', () => {
    expect(() => parseArgs(['--help', '--worker', 'codex'])).toThrow(CliUsageError);
    expect(() => parseArgs(['--version', '--worker=claude'])).toThrow(CliUsageError);
  });

  it('parses known flags independently of positional argument order', () => {
    expect(parseArgs(['--mock', '/repo', '--json', 'Inspect', 'this', '--no-trace'])).toEqual({
      kind: 'run',
      options: {
        repoPath: '/repo',
        task: 'Inspect this',
        mock: true,
        noTrace: true,
        json: true,
        orchestrate: false,
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
        orchestrate: false,
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
        orchestrate: false,
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
    expect(() => parseArgs(['/repo', 'Inspect', '--orchestrate', '--json'])).toThrow(CliUsageError);
    expect(() => parseArgs(['/repo', 'Inspect', '--orchestrate', '--no-trace'])).toThrow(CliUsageError);
  });

  it('parses the explicit orchestration mode', () => {
    expect(parseArgs(['/repo', 'Inspect', '--mock', '--orchestrate'])).toEqual({
      kind: 'run',
      options: {
        repoPath: '/repo',
        task: 'Inspect',
        mock: true,
        noTrace: false,
        json: false,
        orchestrate: true,
      },
    });
  });
});

describe('worker selection reporting', () => {
  it('retains an explicit worker in JSON while preserving omitted defaults', () => {
    const evaluation = mockEvaluation();
    expect(createDecisionOutput({ ...state, workerSelection: 'codex' }, evaluation, policy, 'mock')).toMatchObject({ workerSelection: 'codex', status: 'unexecuted' });
    expect(createDecisionOutput(state, evaluation, policy, 'mock')).not.toHaveProperty('workerSelection');
  });
});

describe('CLI output contract', () => {
  it('prints parseable approval parameters when credential phrases end string values', () => {
    const workerContext = buildWorkerContext({
      ...state,
      evidence: {
        revision: 1,
        validationGeneration: 0,
        clarifications: [],
        findings: [{
          iteration: 1, source: 'read', paths: ['src/auth.ts'], excerpt: 'password=[REDACTED]',
        }],
        failures: [],
      },
    });
    const input = { root: '/repo', task: 'Fix password=fake-review-value', context: workerContext };
    const originalInput = structuredClone(input);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printApprovalProposal({
        state,
        evaluation: mockEvaluation(),
        policy,
        proposal: { action: 'CALL_CODEX', tool: 'codex_cli', input },
        allowedAlternatives: ['CALL_CODEX', 'ASK_USER'],
      });
      const parameters = log.mock.calls.map(([line]) => line)
        .find((line): line is string => typeof line === 'string' && line.startsWith('Parameters: '));
      expect(parameters).toBeDefined();
      expect(parameters).not.toContain('fake-review-value');
      expect(JSON.parse(parameters!.slice('Parameters: '.length))).toEqual({
        ...input, task: 'Fix password=[REDACTED]',
      });
      expect(input).toEqual(originalInput);
    } finally {
      log.mockRestore();
    }
  });

  it('parses user-only stop controls independently of allowed action alternatives', () => {
    const evaluation = mockEvaluation();
    const context = {
      state,
      evaluation,
      policy,
      proposal: {
        action: 'SEARCH_REPO' as const,
        tool: 'rg' as const,
        input: { root: '/repo', terms: ['auth'] },
      },
      allowedAlternatives: ['SEARCH_REPO' as const],
    };

    expect(parseApprovalChoice('stop', context)).toEqual({ kind: 'stop' });
    expect(parseApprovalChoice('QUIT', context)).toEqual({ kind: 'stop' });
    expect(parseApprovalChoice('FINISH', context)).toBeUndefined();
  });

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
