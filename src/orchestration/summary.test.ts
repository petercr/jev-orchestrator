import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JevEvaluationError } from '../ai/errors.js';
import type { Action, EvaluationResult, RepoSnapshot } from '../types.js';
import { createInitialState, runOrchestration, type ApprovalDecision } from './loop.js';
import type { CandidateProposal } from './candidate.js';
import type { ToolResult } from './execute.js';

const roots: string[] = [];

async function repository(): Promise<RepoSnapshot> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-summary-'));
  roots.push(root);
  await writeFile(path.join(root, 'README.md'), 'Fixture instructions.');
  await writeFile(path.join(root, 'package.json'), '{}');
  return {
    root, packageManager: 'pnpm', scripts: ['test'], validationScripts: ['test'],
    gitStatus: [], topLevelFiles: ['README.md', 'package.json'],
  };
}

function evaluation(action: Action): EvaluationResult {
  return {
    model: 'mock/jev', latencyMs: 999_999, rawAnswers: {},
    assessment: {
      taskComplete: { probability: action === 'FINISH' ? 0.99 : 0.01 },
      needsMoreInformation: { probability: 0.01 },
      needsTesting: { probability: 0.01 },
      stuck: { probability: 0.01 },
      nextAction: { choice: action, probabilities: { [action]: 0.99 }, confidence: 0.99 },
    },
  };
}

function result(proposal: CandidateProposal, overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    action: proposal.action, ok: true, exitCode: 0, durationMs: 999_999, timedOut: false,
    output: 'fixture result', files: proposal.action === 'READ_FILE' ? ['README.md'] : [],
    ...overrides,
  };
}

function clock() {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return (ms: number): void => { now += ms; };
}

async function records(tracePath: string) {
  return (await readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('orchestration run summary', () => {
  it('separates local phase times and reports conjunctive validation in the terminal trace', async () => {
    const repo = await repository();
    repo.scripts = repo.validationScripts = ['verify', 'test', 'typecheck', 'build'];
    repo.requiredValidationScripts = [...repo.validationScripts];
    repo.validationScriptCoverage = { verify: ['verify', 'test', 'typecheck'], build: ['build'] };
    const advance = clock();
    const actions: Action[] = ['SEARCH_REPO', 'READ_FILE', 'CALL_CODEX', 'RUN_TESTS', 'RUN_TESTS', 'FINISH'];
    const outcome = await runOrchestration(createInitialState(repo, 'Fix fixture'), {
      evaluate: async (state) => { advance(10); return evaluation(actions[state.iteration - 1] ?? 'FINISH'); },
      approve: async () => { advance(1_000); return { kind: 'approve' }; },
      askForInformation: async () => '',
      execute: async (proposal) => {
        advance(proposal.action === 'CALL_CODEX' ? 1_000 : proposal.action === 'SEARCH_REPO' ? 20
          : proposal.action === 'READ_FILE' ? 30 : proposal.action === 'RUN_TESTS' && proposal.input.script === 'verify' ? 70 : 80);
        return result(proposal);
      },
      inspect: async () => { advance(20); return repo; },
    }, { initialInspectionMs: 40 });

    expect(outcome.status).toBe('finished');
    expect(outcome.summary.timings).toEqual({
      elapsedMs: 7_320, activeMs: 1_320, evaluationMs: 60, preparationMs: 50,
      workerMs: 1_000, validationMs: 150, approvalWaitMs: 6_000,
      informationWaitMs: 0, recoveryWaitMs: 0, inspectionMs: 60, diagnosticsMs: 0, otherMs: 0,
    });
    expect(outcome.summary.counts).toMatchObject({
      evaluations: 6, approvalRequests: 6, approvals: 6, codexCalls: 1, claudeCalls: 0,
      workerRetries: 0, validationRuns: 2, validationFailures: 0, failedExecutions: 0,
    });
    expect(outcome.summary.validation).toEqual({
      generation: 1, passed: true, requirementsOmitted: false, repoRefreshRequired: false,
      checks: repo.validationScripts.map((script) => ({ script, status: 'passed' })),
    });
    const trace = await records(outcome.tracePath);
    expect(trace).toHaveLength(6);
    expect(trace[0]).not.toHaveProperty('summary');
    expect(trace.at(-1).summary).toEqual(outcome.summary);
    expect(trace.at(-1).metrics).toEqual({ timings: outcome.summary.timings, counts: outcome.summary.counts });
  });

  it('counts alternative prompts once and excludes their waits from active time at the limit', async () => {
    const repo = await repository();
    const advance = clock();
    const decisions: ApprovalDecision[] = [{ kind: 'alternative', action: 'READ_FILE' }, { kind: 'approve' }];
    const outcome = await runOrchestration(createInitialState(repo, 'Inspect fixture'), {
      evaluate: async () => { advance(10); return evaluation('SEARCH_REPO'); },
      approve: async () => { advance(500); return decisions.shift() ?? { kind: 'stop' }; },
      askForInformation: async () => '',
      execute: async (proposal) => { advance(20); return result(proposal); },
    }, { maxIterations: 1 });
    expect(outcome).toMatchObject({ status: 'iteration_limit', exitCode: 1 });
    expect(outcome.summary.timings).toMatchObject({ elapsedMs: 1_030, activeMs: 30, approvalWaitMs: 1_000 });
    expect(outcome.summary.counts).toMatchObject({ approvalRequests: 2, approvals: 1, alternatives: 1, codexCalls: 0 });
    expect((await records(outcome.tracePath)).at(-1).summary).toEqual(outcome.summary);
  });

  it.each(['reject', 'stop'] as const)('keeps %s summaries unexecuted and validation pending', async (kind) => {
    const repo = await repository();
    const advance = clock();
    const execute = vi.fn();
    const outcome = await runOrchestration(createInitialState(repo, 'Fix fixture'), {
      evaluate: async () => { advance(10); return evaluation('CALL_CODEX'); },
      approve: async () => { advance(200); return { kind }; },
      askForInformation: async () => '', execute,
    }, { maxIterations: 1 });
    expect(execute).not.toHaveBeenCalled();
    expect(outcome.summary.timings).toMatchObject({ elapsedMs: 210, activeMs: 10, workerMs: 0 });
    expect(outcome.summary.counts).toMatchObject({ codexCalls: 0, approvals: 0, rejections: kind === 'reject' ? 1 : 0 });
    expect(outcome.summary.validation).toMatchObject({ passed: false, checks: [{ script: 'test', status: 'pending' }] });
    expect((await records(outcome.tracePath)).at(-1).summary).toEqual(outcome.summary);
  });

  it('measures failed evaluation and explicit recovery without double-counting trace records', async () => {
    const repo = await repository();
    const advance = clock();
    const outcome = await runOrchestration(createInitialState(repo, 'Inspect fixture'), {
      evaluate: async (state) => {
        advance(state.iteration === 1 ? 20 : 30);
        if (state.iteration === 1) throw new JevEvaluationError('invalid_response', 'untrusted upstream data');
        return evaluation('SEARCH_REPO');
      },
      recoverEvaluation: async () => { advance(400); return 'continue'; },
      approve: async () => { advance(200); return { kind: 'stop' }; },
      askForInformation: async () => '',
    });
    expect(outcome.iterations).toBe(2);
    expect(outcome.summary.timings).toMatchObject({ elapsedMs: 650, activeMs: 50, evaluationMs: 50, recoveryWaitMs: 400 });
    expect(outcome.summary.counts).toMatchObject({ evaluations: 2, evaluationFailures: 1, evaluationRecoveries: 1, approvalRequests: 1 });
    const trace = await records(outcome.tracePath);
    expect(trace).toHaveLength(3);
    expect(trace[0].metrics.counts.evaluations).toBe(1);
    expect(trace.at(-1).summary).toEqual(outcome.summary);
  });

  it('retains a terminal summary when evaluation cannot recover', async () => {
    const repo = await repository();
    const advance = clock();
    const outcome = await runOrchestration(createInitialState(repo, 'Inspect fixture'), {
      evaluate: async () => { advance(40); throw new JevEvaluationError('invalid_response', 'raw data'); },
      approve: async () => ({ kind: 'approve' }), askForInformation: async () => '',
    });
    expect(outcome).toMatchObject({ status: 'evaluation_failed', exitCode: 1 });
    expect(outcome.summary.timings).toMatchObject({ elapsedMs: 40, evaluationMs: 40, recoveryWaitMs: 0 });
    expect(outcome.summary.counts).toMatchObject({ evaluations: 1, evaluationFailures: 1, approvalRequests: 0 });
    expect((await records(outcome.tracePath)).at(-1).summary).toEqual(outcome.summary);
  });

  it('separates clarification waits from approved Git diagnostic time', async () => {
    const repo = await repository();
    const advance = clock();
    const actions: Action[] = ['ASK_USER', 'RUN_COMMAND', 'SEARCH_REPO'];
    const outcome = await runOrchestration(createInitialState(repo, 'Inspect fixture'), {
      evaluate: async (state) => { advance(10); return evaluation(actions[state.iteration - 1] ?? 'SEARCH_REPO'); },
      approve: async ({ state }) => { advance(50); return { kind: state.iteration === 3 ? 'stop' : 'approve' }; },
      askForInformation: async () => { advance(400); return 'Please inspect the repository status.'; },
      execute: async (proposal) => { advance(70); return result(proposal); },
    });
    expect(outcome.summary.timings).toMatchObject({
      elapsedMs: 650, activeMs: 100, evaluationMs: 30,
      informationWaitMs: 400, approvalWaitMs: 150, diagnosticsMs: 70,
    });
    expect(outcome.state.evidence?.clarifications).toHaveLength(1);
    expect(outcome.summary.counts).toMatchObject({ evaluations: 3, approvals: 2, validationRuns: 0 });
  });

  it('reports failed and unrun required checks without treating an older pass as current', async () => {
    const repo = await repository();
    repo.scripts = repo.validationScripts = ['test', 'build'];
    const state = createInitialState(repo, 'Fix fixture');
    state.tests = { ran: true, passed: true };
    state.evidence!.validations = [{ iteration: 0, generation: 0, script: 'build', exitCode: 0, timedOut: false, passed: true, summary: 'old pass' }];
    const actions: Action[] = ['CALL_CODEX', 'RUN_TESTS', 'SEARCH_REPO'];
    const outcome = await runOrchestration(state, {
      evaluate: async (current) => evaluation(actions[current.iteration - 1] ?? 'SEARCH_REPO'),
      approve: async ({ state: current }) => ({ kind: current.iteration === 3 ? 'stop' : 'approve' }),
      askForInformation: async () => '',
      execute: async (proposal) => result(proposal, proposal.action === 'RUN_TESTS' ? { ok: false, exitCode: 1 } : {}),
      inspect: async () => repo,
    });
    expect(outcome.summary.validation).toMatchObject({
      generation: 1, passed: false,
      checks: [{ script: 'test', status: 'failed' }, { script: 'build', status: 'pending' }],
    });
    expect(outcome.summary.counts).toMatchObject({ validationRuns: 1, validationFailures: 1 });
  });

  it.each(['CALL_CODEX', 'CALL_CLAUDE'] as const)('counts %s repairs and discards validation from older generations', async (worker) => {
    const repo = await repository();
    const advance = clock();
    const actions: Action[] = [worker, 'RUN_TESTS', worker, 'RUN_TESTS', 'FINISH'];
    let validationRuns = 0;
    const outcome = await runOrchestration(createInitialState(repo, 'Fix fixture'), {
      evaluate: async (state) => { advance(10); return evaluation(actions[state.iteration - 1] ?? 'FINISH'); },
      approve: async () => ({ kind: 'approve' }), askForInformation: async () => '',
      execute: async (proposal) => {
        advance(proposal.action === worker ? 100 : 50);
        if (proposal.action === 'RUN_TESTS' && ++validationRuns === 1) {
          return result(proposal, { ok: false, exitCode: null, timedOut: true });
        }
        return result(proposal);
      },
      inspect: async () => repo,
    });
    expect(outcome.status).toBe('finished');
    expect(outcome.summary.counts).toMatchObject({
      workerRetries: 1, codexCalls: worker === 'CALL_CODEX' ? 2 : 0,
      claudeCalls: worker === 'CALL_CLAUDE' ? 2 : 0,
      validationRuns: 2, validationFailures: 1, timedOutExecutions: 1,
    });
    expect(outcome.summary.timings).toMatchObject({ workerMs: 200, validationMs: 100 });
    expect(outcome.summary.validation).toMatchObject({ generation: 2, passed: true, checks: [{ script: 'test', status: 'passed' }] });
    const trace = await records(outcome.tracePath);
    expect(trace[1].stateAfter.tests.passed).toBe(false);
    expect(trace[2].stateAfter.tests.ran).toBe(false);
    expect(trace.at(-1).summary).toEqual(outcome.summary);
  });

  it.each(['evaluation', 'approval'] as const)('measures interrupted %s without fabricated responses or late execution', async (phase) => {
    const repo = await repository();
    const advance = clock();
    const controller = new AbortController();
    let resolveLate: (() => void) | undefined;
    const execute = vi.fn();
    const outcome = await runOrchestration(createInitialState(repo, 'Fix fixture'), {
      evaluate: async () => {
        advance(10);
        if (phase === 'evaluation') {
          controller.abort();
          return new Promise<EvaluationResult>((resolve) => { resolveLate = () => resolve(evaluation('CALL_CODEX')); });
        }
        return evaluation('CALL_CODEX');
      },
      approve: async () => {
        advance(35);
        controller.abort();
        return new Promise<ApprovalDecision>((resolve) => { resolveLate = () => resolve({ kind: 'approve' }); });
      },
      askForInformation: async () => '', execute,
    }, { signal: controller.signal });
    expect(outcome.status).toBe('stopped');
    expect(outcome.summary.timings).toMatchObject({
      elapsedMs: phase === 'approval' ? 45 : 10, activeMs: 10,
      evaluationMs: 10, approvalWaitMs: phase === 'approval' ? 35 : 0,
    });
    expect(outcome.summary.counts).toMatchObject({ evaluations: 1, evaluationFailures: 0, approvals: 0, codexCalls: 0 });
    resolveLate?.();
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    expect((await records(outcome.tracePath)).at(-1).summary).toEqual(outcome.summary);
  });

  it('includes cancelled worker cleanup and inspection while preserving pending validation', async () => {
    const repo = await repository();
    const advance = clock();
    const controller = new AbortController();
    const outcome = await runOrchestration(createInitialState(repo, 'Fix fixture'), {
      evaluate: async () => { advance(10); return evaluation('CALL_CODEX'); },
      approve: async () => { advance(20); return { kind: 'approve' }; },
      askForInformation: async () => '',
      execute: async (proposal) => { advance(100); controller.abort(); advance(15); return result(proposal); },
      inspect: async () => { advance(25); return { ...repo, gitStatus: [' M partial.ts'] }; },
    }, { signal: controller.signal });
    expect(outcome).toMatchObject({ status: 'stopped', state: { filesModified: ['partial.ts'] } });
    expect(outcome.summary.timings).toMatchObject({ elapsedMs: 170, activeMs: 150, workerMs: 115, inspectionMs: 25 });
    expect(outcome.summary.counts).toMatchObject({ codexCalls: 1, cancelledExecutions: 1, failedExecutions: 1 });
    expect(outcome.summary.validation).toMatchObject({ generation: 1, passed: false, checks: [{ script: 'test', status: 'pending' }] });
    expect((await records(outcome.tracePath)).at(-1).summary).toEqual(outcome.summary);
  });
});
