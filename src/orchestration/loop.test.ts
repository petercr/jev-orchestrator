import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWorkerContext } from '../agents/context.js';
import { mockEvaluation } from '../mock.js';
import type { AgentAssessment, EvaluationResult, RepoSnapshot } from '../types.js';
import { createInitialState, runOrchestration, type ApprovalDecision } from './loop.js';
import { MAX_CLAUDE_CALLS, MAX_CODEX_CALLS } from './candidate.js';
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

  it('labels a rejected worker request as unexecuted in the trace', async () => {
    const repo = await repository();
    const execute = vi.fn();
    const result = await runOrchestration(createInitialState(repo, 'Fix authentication'), {
      evaluate: async () => clearAssessment('CALL_CODEX'),
      approve: async () => ({ kind: 'reject' }),
      askForInformation: async () => '',
      execute,
    }, { maxIterations: 1 });
    expect(execute).not.toHaveBeenCalled();
    const record = JSON.parse((await readFile(result.tracePath, 'utf8')).trim());
    expect(record).toMatchObject({
      approval: { kind: 'reject' },
      workerRequest: { retryReason: 'Worker proposal was not executed.' },
      toolResult: null,
    });
  });

  it('lets the user stop without executing or claiming completion and records the terminal trace', async () => {
    const repo = await repository();
    const execute = vi.fn();
    const askForInformation = vi.fn();
    const result = await runOrchestration(
      createInitialState(repo, 'Inspect fixture auth'),
      {
        evaluate: async () => clearAssessment('SEARCH_REPO'),
        approve: async () => ({ kind: 'stop', reason: 'Continue in a later session' }),
        askForInformation,
        execute,
      },
    );

    expect(result).toMatchObject({ status: 'stopped', iterations: 1 });
    expect(execute).not.toHaveBeenCalled();
    expect(askForInformation).not.toHaveBeenCalled();
    expect(result.state.currentGoal).toBe('Run stopped by user without claiming completion.');
    expect(result.state.observations).toContain(
      'User stopped the run: Continue in a later session',
    );
    expect(result.state.tests).toEqual({ ran: false });
    const record = JSON.parse((await readFile(result.tracePath, 'utf8')).trim());
    expect(record).toMatchObject({
      proposal: { selected: { action: 'SEARCH_REPO' } },
      approval: {
        kind: 'stop',
        reason: 'Continue in a later session',
        history: [{ kind: 'stop', reason: 'Continue in a later session' }],
      },
      toolInput: null,
      toolResult: null,
      stateAfter: {
        currentGoal: 'Run stopped by user without claiming completion.',
        tests: { ran: false },
      },
    });
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

  it('records an approved diagnostic without changing validation evidence', async () => {
    const repo = await repository();
    const initial = createInitialState(repo, 'Inspect the working tree');
    initial.tests = { ran: true, passed: true, summary: 'existing validation' };
    const execute = vi.fn().mockResolvedValue({
      action: 'RUN_COMMAND',
      ok: true,
      exitCode: 0,
      durationMs: 4,
      timedOut: false,
      output: 'M src/auth.ts',
      files: [],
    } satisfies ToolResult);

    const result = await runOrchestration(initial, {
      evaluate: async () => clearAssessment('RUN_COMMAND'),
      approve,
      askForInformation: async () => '',
      execute,
    }, { maxIterations: 1 });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      action: 'RUN_COMMAND',
      tool: 'diagnostic_command',
    }));
    expect(result.state).toMatchObject({
      tests: { ran: true, passed: true, summary: 'existing validation' },
      commandsRun: [{
        command: 'git --no-pager --no-optional-locks -c core.fsmonitor=false status --short --untracked-files=all --no-renames --ignore-submodules=all -- . :(exclude)traces/**',
      }],
    });
    expect(result.state.observations).toContain('Diagnostic completed: M src/auth.ts');
    const record = JSON.parse((await readFile(result.tracePath, 'utf8')).trim());
    expect(record).toMatchObject({
      proposal: {
        selected: {
          action: 'RUN_COMMAND',
          tool: 'diagnostic_command',
        },
      },
      toolInput: {
        diagnostic: 'git_status',
        command: 'git',
      },
      toolResult: { ok: true, exitCode: 0 },
    });
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

  it('records an approved Claude call and tracks its limit independently', async () => {
    const repo = await repository();
    const initial = createInitialState(repo, 'Implement fixture authentication');
    initial.codexCalls = MAX_CODEX_CALLS;
    const execute = vi.fn().mockResolvedValue({
      action: 'CALL_CLAUDE',
      ok: true,
      exitCode: 0,
      durationMs: 12,
      timedOut: false,
      output: 'Implemented authentication.',
      files: [],
      stdout: 'Implemented authentication.',
      stderr: 'Claude progress details.',
    } satisfies ToolResult);

    const result = await runOrchestration(initial, {
      evaluate: async () => clearAssessment('CALL_CLAUDE'),
      approve,
      askForInformation: async () => '',
      execute,
      inspect: async () => ({
        ...repo,
        gitStatus: [' M src/auth.ts'],
      }),
    }, { maxIterations: 1 });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ action: 'CALL_CLAUDE' }));
    expect(result.state).toMatchObject({
      codexCalls: MAX_CODEX_CALLS,
      claudeCalls: 1,
      filesModified: ['src/auth.ts'],
      tests: { ran: false },
      commandsRun: [{ command: 'claude -p', exitCode: 0 }],
    });
    expect(result.state.observations).toContain('Claude completed: Implemented authentication.');
  });

  it('does not execute Claude after the per-run call limit', async () => {
    const repo = await repository();
    const initial = createInitialState(repo, 'Implement fixture authentication');
    initial.claudeCalls = MAX_CLAUDE_CALLS;
    const execute = vi.fn();

    const result = await runOrchestration(initial, {
      evaluate: async () => clearAssessment('CALL_CLAUDE'),
      approve,
      askForInformation: async () => 'Continue manually',
      execute,
    }, { maxIterations: 1 });

    expect(execute).not.toHaveBeenCalled();
    expect(result.state.claudeCalls).toBe(MAX_CLAUDE_CALLS);
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

  it('carries failed validation into an approved repair and requires fresh validation', async () => {
    const repo = await repository();
    let workerCalls = 0;
    let testCalls = 0;
    const execute = vi.fn().mockImplementation(async (proposal): Promise<ToolResult> => {
      if (proposal.action === 'CALL_CODEX') {
        workerCalls += 1;
        return {
          action: 'CALL_CODEX', ok: true, exitCode: 0, durationMs: 1,
          timedOut: false, output: `implementation ${workerCalls}`, files: [],
        };
      }
      testCalls += 1;
      return {
        action: 'RUN_TESTS', ok: testCalls === 2, exitCode: testCalls === 2 ? 0 : 1,
        durationMs: 1, timedOut: false,
        output: testCalls === 2 ? 'all tests passed' : 'Expected 401, received 200', files: [],
      };
    });
    const approvalHistory: string[] = [];
    const result = await runOrchestration(createInitialState(repo, 'Fix authentication'), {
      evaluate: async (state) => {
        if (state.iteration === 1) return clearAssessment('CALL_CODEX');
        if (state.iteration === 3) {
          const request = clearAssessment('CALL_CODEX');
          request.assessment.needsTesting.probability = 0.9;
          return request;
        }
        if (state.iteration === 4) return clearAssessment('ASK_USER');
        if (state.iteration === 2 || state.iteration === 5) return clearAssessment('RUN_TESTS');
        return finishAssessment(0.99);
      },
      approve: async ({ state, proposal }) => {
        approvalHistory.push(`${state.iteration}:${proposal.action}`);
        if (state.iteration === 4 && proposal.action === 'ASK_USER') {
          return { kind: 'alternative', action: 'CALL_CODEX' };
        }
        return { kind: 'approve' };
      },
      askForInformation: async () => 'Expired tokens must return 401.',
      execute,
      inspect: async () => ({ ...repo, gitStatus: [' M src/auth.ts'] }),
    });

    expect(result).toMatchObject({ status: 'finished', iterations: 6 });
    expect(result.state).toMatchObject({
      codexCalls: 2,
      filesModified: ['src/auth.ts'],
      tests: { ran: true, passed: true, summary: 'all tests passed' },
      evidence: { validationGeneration: 2 },
    });
    expect(approvalHistory).toEqual([
      '1:CALL_CODEX', '2:RUN_TESTS', '3:ASK_USER', '4:ASK_USER',
      '4:CALL_CODEX', '5:RUN_TESTS', '6:FINISH',
    ]);
    const repair = execute.mock.calls.filter(([proposal]) => proposal.action === 'CALL_CODEX')[1]?.[0];
    expect(repair.input.context.validation).toMatchObject({
      generation: 1, script: 'test', exitCode: 1, passed: false,
      summary: 'Expected 401, received 200',
    });
    expect(repair.input.context.clarifications).toMatchObject([
      { iteration: 3, text: 'Expired tokens must return 401.' },
    ]);
    const records = (await readFile(result.tracePath, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line));
    expect(records[3]).toMatchObject({
      workerRequest: { validationGeneration: 1, retryReason: 'Repair after failed independent validation.' },
      approval: { history: [{ kind: 'alternative', action: 'CALL_CODEX' }, { kind: 'approve' }] },
    });
  });

  it('blocks an unchanged failed worker even when chosen as an alternative', async () => {
    const repo = await repository();
    const execute = vi.fn().mockResolvedValue({
      action: 'CALL_CODEX', ok: false, exitCode: null, durationMs: 1,
      timedOut: true, output: 'worker timed out', files: [],
    } satisfies ToolResult);
    const proposals: string[] = [];
    const result = await runOrchestration(createInitialState(repo, 'Fix authentication'), {
      evaluate: async (state) => clearAssessment(state.iteration === 1 ? 'CALL_CODEX' : 'ASK_USER'),
      approve: async ({ state, proposal }) => {
        proposals.push(proposal.action);
        return state.iteration === 2 && proposals.length === 2
          ? { kind: 'alternative', action: 'CALL_CODEX' }
          : { kind: 'approve' };
      },
      askForInformation: async () => '',
      execute,
      inspect: async () => repo,
    }, { maxIterations: 2 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(proposals).toEqual(['CALL_CODEX', 'ASK_USER', 'ASK_USER']);
    expect(result.state.codexCalls).toBe(1);
    const records = (await readFile(result.tracePath, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line));
    expect(records[1].proposal.selected.reason).toContain('already failed');
  });

  it('blocks unchanged failed validation, including through an alternative', async () => {
    const repo = await repository();
    const execute = vi.fn().mockResolvedValue({
      action: 'RUN_TESTS', ok: false, exitCode: 1, durationMs: 1,
      timedOut: false, output: 'still failing', files: [],
    } satisfies ToolResult);
    const result = await runOrchestration(createInitialState(repo, 'Check authentication'), {
      evaluate: async (state) => clearAssessment(state.iteration === 1 ? 'RUN_TESTS' : 'ASK_USER'),
      approve: async ({ state, proposal }) => state.iteration === 2 && proposal.action === 'ASK_USER' &&
        (state.observations.at(-1) ?? '').includes('RUN_TESTS failed')
        ? { kind: 'alternative', action: 'RUN_TESTS' }
        : { kind: 'approve' },
      askForInformation: async () => '',
      execute,
    }, { maxIterations: 2 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.state.tests).toMatchObject({ ran: true, passed: false });
  });

  it('does not accept a successful test result with a failing exit status', async () => {
    const repo = await repository();
    const result = await runOrchestration(createInitialState(repo, 'Check authentication'), {
      evaluate: async () => clearAssessment('RUN_TESTS'),
      approve,
      askForInformation: async () => '',
      execute: async () => ({
        action: 'RUN_TESTS', ok: true, exitCode: 1, durationMs: 1,
        timedOut: false, output: 'claimed success', files: [],
      }),
    }, { maxIterations: 1 });
    expect(result.state.tests).toMatchObject({ ran: true, passed: false });
    expect(result.state.failedApproaches).toHaveLength(1);
  });

  it('invalidates passing validation after a worker attempt with no visible file change', async () => {
    const repo = await repository();
    const initial = createInitialState(repo, 'Fix authentication');
    initial.tests = { ran: true, passed: true, summary: 'previous pass' };
    const result = await runOrchestration(initial, {
      evaluate: async () => clearAssessment('CALL_CLAUDE'),
      approve,
      askForInformation: async () => '',
      execute: async () => ({
        action: 'CALL_CLAUDE', ok: true, exitCode: 0, durationMs: 1,
        timedOut: false, output: 'no visible change', files: [],
      }),
      inspect: async () => repo,
    }, { maxIterations: 1 });
    expect(result.state.tests).toEqual({ ran: false });
    expect(result.state.evidence?.validationGeneration).toBe(1);
  });

  it('allows an explicitly approved cross-agent repair with the prior failure as context', async () => {
    const repo = await repository();
    const execute = vi.fn().mockImplementation(async (proposal): Promise<ToolResult> => ({
      action: proposal.action,
      ok: proposal.action === 'CALL_CLAUDE',
      exitCode: proposal.action === 'CALL_CLAUDE' ? 0 : 1,
      durationMs: 1,
      timedOut: false,
      output: proposal.action === 'CALL_CLAUDE' ? 'repair completed' : 'Codex failed',
      files: [],
    }));
    const result = await runOrchestration(createInitialState(repo, 'Fix authentication'), {
      evaluate: async (state) => clearAssessment(state.iteration === 1 ? 'CALL_CODEX' : 'ASK_USER'),
      approve: async ({ state, proposal }) => state.iteration === 2 && proposal.action === 'ASK_USER'
        ? { kind: 'alternative', action: 'CALL_CLAUDE' }
        : { kind: 'approve' },
      askForInformation: async () => '',
      execute,
      inspect: async () => repo,
    }, { maxIterations: 2 });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.state).toMatchObject({ codexCalls: 1, claudeCalls: 1, tests: { ran: false } });
    const claude = execute.mock.calls[1]?.[0];
    expect(claude.input.context.previousWorker).toMatchObject({
      agent: 'codex', ok: false, summary: 'Codex failed',
    });
  });

  it('requires approved user intervention before transient refresh recovery permits validation', async () => {
    const repo = await repository();
    const initial = createInitialState(repo, 'Fix authentication');
    initial.tests = { ran: true, passed: true };
    const events: string[] = [];
    const execute = vi.fn().mockImplementation(async (proposal): Promise<ToolResult> => {
      events.push(proposal.action);
      return {
        action: proposal.action, ok: true, exitCode: 0, durationMs: 1,
        timedOut: false, output: 'success', files: [],
      };
    });
    const inspect = vi.fn().mockImplementation(async () => {
      events.push('inspect');
      if (inspect.mock.calls.length === 1) throw new Error('transient failure');
      return { ...repo, gitStatus: [' M src/auth.ts'] };
    });
    const askForInformation = vi.fn().mockImplementation(async () => {
      events.push('ask');
      return '';
    });
    const proposals: string[] = [];
    const result = await runOrchestration(initial, {
      evaluate: async (state) => clearAssessment(state.iteration === 1 ? 'CALL_CODEX' : 'RUN_TESTS'),
      approve: async ({ proposal, allowedAlternatives }) => {
        proposals.push(proposal.action);
        if (proposal.action === 'ASK_USER') expect(allowedAlternatives).toEqual(['ASK_USER']);
        return { kind: 'approve' };
      },
      askForInformation,
      execute,
      inspect,
    }, { maxIterations: 3 });
    expect(proposals).toEqual(['CALL_CODEX', 'ASK_USER', 'RUN_TESTS']);
    expect(events).toEqual(['CALL_CODEX', 'inspect', 'ask', 'inspect', 'RUN_TESTS']);
    expect(result.state.codexCalls).toBe(1);
    expect(result.state.evidence?.validationGeneration).toBe(1);
    expect(result.state.evidence?.repoRefreshRequired).toBe(false);
    expect(result.state.failedApproaches).toHaveLength(1);
    expect(result.state.evidence?.failures).toHaveLength(1);
    expect(result.state.evidence?.clarifications).toEqual([]);
    expect(buildWorkerContext(result.state).previousWorker?.modifiedFiles).toEqual(['src/auth.ts']);
    const records = (await readFile(result.tracePath, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line));
    expect(records[1].stateBefore.evidence.repoRefreshRequired).toBe(true);
    expect(records[1].stateBefore.tests).toEqual({ ran: false });
    expect(records[1].stateAfter.evidence.repoRefreshRequired).toBe(false);
    expect(records[1].stateAfter.tests).toEqual({ ran: false });
    expect(records[1].stateAfter.observations).toContain('Repository inspection recovered after user intervention.');
    expect(records[2].toolResult.action).toBe('RUN_TESTS');
  });

  it.each<ApprovalDecision>([
    { kind: 'reject' },
    { kind: 'stop' },
    { kind: 'alternative', action: 'RUN_TESTS' },
    { kind: 'alternative', action: 'CALL_CLAUDE' },
  ])('keeps refresh blocked after a $kind decision without approved user input', async (decision) => {
    const repo = await repository();
    const execute = vi.fn().mockResolvedValue({
      action: 'CALL_CODEX', ok: true, exitCode: 0, durationMs: 1,
      timedOut: false, output: 'partial change', files: [],
    } satisfies ToolResult);
    const inspect = vi.fn().mockRejectedValueOnce(new Error('transient failure')).mockResolvedValue(repo);
    const askForInformation = vi.fn().mockResolvedValue('');
    const result = await runOrchestration(createInitialState(repo, 'Fix authentication'), {
      evaluate: async (state) => clearAssessment(state.iteration === 1 ? 'CALL_CODEX' : 'RUN_TESTS'),
      approve: async ({ state, proposal, allowedAlternatives }) => {
        if (state.iteration === 1) return { kind: 'approve' };
        expect(proposal.action).toBe('ASK_USER');
        expect(allowedAlternatives).toEqual(['ASK_USER']);
        return decision;
      },
      askForInformation,
      execute,
      inspect,
    }, { maxIterations: 3 });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(askForInformation).not.toHaveBeenCalled();
    expect(result.state.evidence?.repoRefreshRequired).toBe(true);
    expect(result.state.codexCalls).toBe(1);
    expect(result.state.tests).toEqual({ ran: false });
  });

  it('blocks further execution until repository inspection recovers', async () => {
    const repo = await repository();
    let inspectionCalls = 0;
    const execute = vi.fn().mockResolvedValue({
      action: 'CALL_CODEX', ok: true, exitCode: 0, durationMs: 1,
      timedOut: false, output: 'partial change', files: [],
    } satisfies ToolResult);
    const alternatives: string[][] = [];
    const askForInformation = vi.fn().mockResolvedValue('');
    const result = await runOrchestration(createInitialState(repo, 'Fix authentication'), {
      evaluate: async () => clearAssessment('CALL_CODEX'),
      approve: async ({ allowedAlternatives }) => {
        alternatives.push(allowedAlternatives);
        return { kind: 'approve' };
      },
      askForInformation,
      execute,
      inspect: async () => {
        inspectionCalls += 1;
        throw new Error('inspection failed');
      },
    }, { maxIterations: 3 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.state.evidence?.repoRefreshRequired).toBe(true);
    expect(alternatives[1]).toEqual(['ASK_USER']);
    expect(inspectionCalls).toBe(3);
    expect(askForInformation).toHaveBeenCalledTimes(2);
    expect(result.state.observations).toContain('Repository inspection still requires recovery after user intervention.');
    const records = (await readFile(result.tracePath, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line));
    expect(records[1].policy.reason).toContain('Repository inspection must recover');
  });
});
