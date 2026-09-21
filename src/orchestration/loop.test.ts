import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockEvaluation } from '../mock.js';
import type { AgentAssessment, EvaluationResult, RepoSnapshot } from '../types.js';
import { createInitialState, runOrchestration, type ApprovalDecision } from './loop.js';
import { MAX_CODEX_CALLS } from './candidate.js';
import type { ToolResult } from './execute.js';

const roots: string[] = [];

async function repository(): Promise<RepoSnapshot> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-loop-'));
  roots.push(root);
  await writeFile(path.join(root, 'README.md'), 'fixture auth documentation');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  return {
    root,
    packageManager: 'pnpm',
    scripts: ['test'],
    validationScripts: ['test'],
    gitStatus: [],
    topLevelFiles: ['README.md', 'package.json'],
  };
}

function evaluation(assessment: AgentAssessment): EvaluationResult {
  return {
    assessment,
    model: 'mock/jev',
    latencyMs: 0,
    rawAnswers: { mock: true },
  };
}

function clearAssessment(choice: AgentAssessment['nextAction']['choice']): EvaluationResult {
  return evaluation({
    taskComplete: { probability: 0.02 },
    needsMoreInformation: { probability: 0.02 },
    needsTesting: { probability: 0.02 },
    stuck: { probability: 0.02 },
    nextAction: {
      choice,
      probabilities: { [choice]: 0.8 },
      confidence: 0.8,
    },
  });
}

function finishAssessment(
  taskComplete: number,
  finishProbability: number = 0.99,
  confidence: number = 0.98,
): EvaluationResult {
  return evaluation({
    taskComplete: { probability: taskComplete },
    needsMoreInformation: { probability: 0.1 },
    needsTesting: { probability: 0.1 },
    stuck: { probability: 0.1 },
    nextAction: {
      choice: 'FINISH',
      probabilities: { FINISH: finishProbability },
      confidence,
    },
  });
}

const approve = async (): Promise<ApprovalDecision> => ({ kind: 'approve' });

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('approval-gated orchestration loop', () => {
  it('executes an approved search, read, validation, and finish sequence', async () => {
    const repo = await repository();
    const execute = vi.fn().mockImplementation(async (proposal): Promise<ToolResult> => {
      if (proposal.action === 'SEARCH_REPO') {
        return {
          action: 'SEARCH_REPO',
          ok: true,
          exitCode: 0,
          durationMs: 1,
          timedOut: false,
          output: 'README.md',
          files: ['README.md'],
        };
      }
      if (proposal.action === 'READ_FILE') {
        return {
          action: 'READ_FILE',
          ok: true,
          exitCode: 0,
          durationMs: 1,
          timedOut: false,
          output: 'fixture auth documentation',
          files: ['README.md'],
        };
      }
      return {
        action: 'RUN_TESTS',
        ok: true,
        exitCode: 0,
        durationMs: 1,
        timedOut: false,
        output: 'tests passed',
        files: [],
      };
    });

    const result = await runOrchestration(
      createInitialState(repo, 'Inspect fixture auth'),
      {
        evaluate: async (state) => mockEvaluation(state),
        approve,
        askForInformation: async () => '',
        execute,
      },
    );

    expect(result.status).toBe('finished');
    expect(result.iterations).toBe(4);
    expect(result.state).toMatchObject({
      filesRead: ['README.md'],
      tests: { ran: true, passed: true },
    });
    expect(execute).toHaveBeenCalledTimes(3);
    const records = (await readFile(result.tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records).toHaveLength(4);
    expect(records[0]).toMatchObject({
      schemaVersion: 2,
      iteration: 1,
      approval: { kind: 'approve', history: [{ kind: 'approve' }] },
      toolInput: { terms: expect.any(Array) },
      toolResult: { ok: true },
    });
    expect(records[3]).toMatchObject({
      proposal: { selected: { action: 'FINISH' } },
      toolInput: null,
      toolResult: null,
    });
  });

  it('records rejection as an observation and executes nothing', async () => {
    const repo = await repository();
    const execute = vi.fn();
    const result = await runOrchestration(
      createInitialState(repo, 'Inspect fixture auth'),
      {
        evaluate: async () => clearAssessment('SEARCH_REPO'),
        approve: async () => ({ kind: 'reject', reason: 'Use another approach' }),
        askForInformation: async () => '',
        execute,
      },
      { maxIterations: 1 },
    );

    expect(result.status).toBe('iteration_limit');
    expect(execute).not.toHaveBeenCalled();
    expect(result.state.observations).toContain('User rejected the proposal: Use another approach');
  });

  it('resolves and re-presents a permitted user alternative before execution', async () => {
    const repo = await repository();
    const approvals: ApprovalDecision[] = [
      { kind: 'alternative', action: 'READ_FILE' },
      { kind: 'approve' },
    ];
    const execute = vi.fn().mockResolvedValue({
      action: 'READ_FILE',
      ok: true,
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
      output: 'contents',
      files: ['README.md'],
    } satisfies ToolResult);

    await runOrchestration(
      createInitialState(repo, 'Inspect fixture auth'),
      {
        evaluate: async () => clearAssessment('SEARCH_REPO'),
        approve: async () => approvals.shift() ?? { kind: 'reject' },
        askForInformation: async () => '',
        execute,
      },
      { maxIterations: 1 },
    );

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ action: 'READ_FILE' }));
  });

  it('allows a twice-confirmed finish override after passing validation', async () => {
    const repo = await repository();
    const initial = createInitialState(repo, 'Inspect and validate fixture auth');
    initial.tests = { ran: true, passed: true, summary: 'tests passed' };
    const approvals: ApprovalDecision[] = [
      { kind: 'alternative', action: 'FINISH' },
      { kind: 'approve' },
    ];
    const alternatives: string[][] = [];
    const execute = vi.fn();

    const result = await runOrchestration(
      initial,
      {
        evaluate: async () => finishAssessment(0.66),
        approve: async (context) => {
          alternatives.push(context.allowedAlternatives);
          return approvals.shift() ?? { kind: 'reject' };
        },
        askForInformation: async () => '',
        execute,
      },
      { maxIterations: 1 },
    );

    expect(result.status).toBe('finished');
    expect(alternatives).toHaveLength(2);
    expect(alternatives[0]).toContain('FINISH');
    expect(execute).not.toHaveBeenCalled();
    expect(result.state.observations).toContain(
      'User explicitly overrode completion confidence after passing validation.',
    );
    const record = JSON.parse((await readFile(result.tracePath, 'utf8')).trim());
    expect(record).toMatchObject({
      policy: { requested: 'FINISH', selected: 'ASK_USER', override: true },
      proposal: {
        considered: [
          { action: 'ASK_USER' },
          { action: 'FINISH' },
        ],
        selected: { action: 'FINISH' },
      },
      approval: {
        kind: 'approve',
        history: [
          { kind: 'alternative', action: 'FINISH' },
          { kind: 'approve' },
        ],
      },
      toolInput: null,
      toolResult: null,
      stateAfter: { currentGoal: 'Task complete.' },
    });
  });

  it('does not offer a finish override without passing validation or clear routing', async () => {
    const repo = await repository();
    const withoutValidation = createInitialState(repo, 'Inspect fixture auth');
    const lowConfidence = createInitialState(repo, 'Inspect fixture auth');
    lowConfidence.tests = { ran: true, passed: true, summary: 'tests passed' };
    const missingInformation = createInitialState(repo, 'Inspect fixture auth');
    missingInformation.tests = { ran: true, passed: true, summary: 'tests passed' };
    const alternatives: string[][] = [];

    await runOrchestration(withoutValidation, {
      evaluate: async () => finishAssessment(0.66),
      approve: async (context) => {
        alternatives.push(context.allowedAlternatives);
        return { kind: 'reject' };
      },
      askForInformation: async () => '',
    }, { maxIterations: 1 });
    await runOrchestration(lowConfidence, {
      evaluate: async () => finishAssessment(0.66, 0.54, 0.98),
      approve: async (context) => {
        alternatives.push(context.allowedAlternatives);
        return { kind: 'reject' };
      },
      askForInformation: async () => '',
    }, { maxIterations: 1 });
    await runOrchestration(missingInformation, {
      evaluate: async () => {
        const result = finishAssessment(0.66);
        result.assessment.needsMoreInformation.probability = 0.95;
        return result;
      },
      approve: async (context) => {
        alternatives.push(context.allowedAlternatives);
        return { kind: 'reject' };
      },
      askForInformation: async () => '',
    }, { maxIterations: 1 });

    expect(alternatives).toHaveLength(3);
    expect(alternatives[0]).not.toContain('FINISH');
    expect(alternatives[1]).not.toContain('FINISH');
    expect(alternatives[2]).not.toContain('FINISH');
  });

  it('does not repeat an identical failed candidate', async () => {
    const repo = await repository();
    const execute = vi.fn().mockResolvedValue({
      action: 'SEARCH_REPO',
      ok: false,
      exitCode: null,
      durationMs: 10_000,
      timedOut: true,
      output: 'Process timed out.',
      files: [],
    } satisfies ToolResult);
    const proposals: string[] = [];
    const result = await runOrchestration(
      createInitialState(repo, 'Inspect fixture auth'),
      {
        evaluate: async () => clearAssessment('SEARCH_REPO'),
        approve: async ({ proposal }) => {
          proposals.push(proposal.action);
          return { kind: 'approve' };
        },
        askForInformation: async () => 'Try a narrower search',
        execute,
      },
      { maxIterations: 2 },
    );

    expect(result.status).toBe('iteration_limit');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(proposals).toEqual(['SEARCH_REPO', 'ASK_USER']);
    expect(result.state.failedApproaches).toHaveLength(1);
  });

  it('normalizes a malformed tool result into a traced failure', async () => {
    const repo = await repository();
    const malformedExecute = (async () => ({ ok: true })) as never;
    const result = await runOrchestration(
      createInitialState(repo, 'Inspect fixture auth'),
      {
        evaluate: async () => clearAssessment('SEARCH_REPO'),
        approve,
        askForInformation: async () => '',
        execute: malformedExecute,
      },
      { maxIterations: 1 },
    );

    expect(result.state.failedApproaches).toHaveLength(1);
    expect(result.state.observations).toContain(
      'SEARCH_REPO failed: The tool executor returned a malformed result.',
    );
    const record = JSON.parse((await readFile(result.tracePath, 'utf8')).trim());
    expect(record.toolResult).toMatchObject({ ok: false, exitCode: null });
  });

  it('records failed validation and enforces the hard iteration ceiling', async () => {
    const repo = await repository();
    const initial = createInitialState(repo, 'Validate fixture auth');
    initial.filesRead = ['README.md'];
    const result = await runOrchestration(
      initial,
      {
        evaluate: async () => clearAssessment('RUN_TESTS'),
        approve,
        askForInformation: async () => '',
        execute: async () => ({
          action: 'RUN_TESTS',
          ok: false,
          exitCode: 1,
          durationMs: 5,
          timedOut: false,
          output: 'tests failed',
          files: [],
        }),
      },
      { maxIterations: 1 },
    );

    expect(result.state.tests).toEqual({ ran: true, passed: false, summary: 'tests failed' });
    expect(result.state.commandsRun).toMatchObject([{ exitCode: 1 }]);
    expect(result.state.observations.at(-1)).toContain('iteration limit');
    await expect(runOrchestration(initial, {
      evaluate: async () => clearAssessment('RUN_TESTS'),
      approve,
      askForInformation: async () => '',
    }, { maxIterations: 9 })).rejects.toThrow('between 1 and 8');
  });

  it('records an approved Codex call, refreshes repository state, and invalidates validation', async () => {
    const repo = await repository();
    const initial = createInitialState(repo, 'Implement fixture authentication');
    initial.tests = { ran: true, passed: true, summary: 'old validation' };
    const execute = vi.fn().mockResolvedValue({
      action: 'CALL_CODEX',
      ok: true,
      exitCode: 0,
      durationMs: 12,
      timedOut: false,
      output: 'Implemented authentication.',
      files: [],
      stdout: 'Implemented authentication.',
      stderr: 'Codex progress details.',
    } satisfies ToolResult);

    const result = await runOrchestration(initial, {
      evaluate: async () => clearAssessment('CALL_CODEX'),
      approve,
      askForInformation: async () => '',
      execute,
      inspect: async () => ({
        ...repo,
        gitStatus: [
          ' M src/auth.ts',
          '?? src/auth.test.ts',
          '?? traces/run.jsonl',
        ],
      }),
    }, { maxIterations: 1 });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ action: 'CALL_CODEX' }));
    expect(result.state).toMatchObject({
      codexCalls: 1,
      filesModified: ['src/auth.ts', 'src/auth.test.ts'],
      tests: { ran: false },
      commandsRun: [{ command: 'codex exec', exitCode: 0 }],
    });
    expect(result.state.observations).toContain('Codex completed: Implemented authentication.');
    const record = JSON.parse((await readFile(result.tracePath, 'utf8')).trim());
    expect(record.toolResult).toMatchObject({
      output: 'Implemented authentication.',
      stdout: 'Implemented authentication.',
      stderr: 'Codex progress details.',
    });
  });

  it('does not execute Codex after the per-run call limit', async () => {
    const repo = await repository();
    const initial = createInitialState(repo, 'Implement fixture authentication');
    initial.codexCalls = MAX_CODEX_CALLS;
    const execute = vi.fn();

    const result = await runOrchestration(initial, {
      evaluate: async () => clearAssessment('CALL_CODEX'),
      approve,
      askForInformation: async () => 'Continue manually',
      execute,
    }, { maxIterations: 1 });

    expect(execute).not.toHaveBeenCalled();
    expect(result.state.codexCalls).toBe(MAX_CODEX_CALLS);
    expect(result.state.observations).toContain('User supplied information: Continue manually');
  });

  it('captures partial repository changes after a failed Codex call', async () => {
    const repo = await repository();
    const result = await runOrchestration(
      createInitialState(repo, 'Implement fixture authentication'),
      {
        evaluate: async () => clearAssessment('CALL_CODEX'),
        approve,
        askForInformation: async () => '',
        execute: async () => ({
          action: 'CALL_CODEX',
          ok: false,
          exitCode: null,
          durationMs: 900_000,
          timedOut: true,
          output: 'Codex timed out after making a partial change.',
          files: [],
        }),
        inspect: async () => ({
          ...repo,
          gitStatus: [' M src/partial.ts'],
        }),
      },
      { maxIterations: 1 },
    );

    expect(result.state).toMatchObject({
      codexCalls: 1,
      filesModified: ['src/partial.ts'],
      tests: { ran: false },
      commandsRun: [{ command: 'codex exec', exitCode: 1 }],
    });
    expect(result.state.failedApproaches).toHaveLength(1);
  });
});
