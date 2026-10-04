import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as trace from '../logging/trace.js';
import { inspectRepo } from '../repo/inspect.js';
import type { Action, EvaluationResult } from '../types.js';
import { createInitialState, runOrchestration, type OrchestrationDependencies } from './loop.js';
import { proposalSignature } from './candidate.js';
import type { ToolResult } from './execute.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-interrupt-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  return createInitialState(await inspectRepo(root), 'Implement the task');
}

function evaluation(choice: Action): EvaluationResult {
  return {
    model: 'fixture', latencyMs: 0, rawAnswers: {},
    assessment: {
      taskComplete: { probability: 0.01 }, needsTesting: { probability: 0.01 },
      needsMoreInformation: { probability: 0.01 }, stuck: { probability: 0.01 },
      nextAction: { choice, probabilities: { [choice]: 0.99 }, confidence: 0.99 },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function records(file: string) {
  return (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

function dependencies(action: Action = 'SEARCH_REPO'): OrchestrationDependencies {
  return {
    evaluate: vi.fn(async () => evaluation(action)),
    approve: vi.fn(async () => ({ kind: 'approve' as const })),
    askForInformation: vi.fn(async () => ''),
    execute: vi.fn(async (proposal) => ({ action: proposal.action, ok: true, exitCode: 0, durationMs: 1, timedOut: false, output: 'done', files: [] })),
  };
}

describe('interrupted orchestration', () => {
  it('records a pre-abort without fabricating an iteration, evaluation, or approval', async () => {
    const state = await fixture();
    const controller = new AbortController();
    controller.abort('SECRET arbitrary abort reason');
    const deps = dependencies();
    const result = await runOrchestration(state, deps, { signal: controller.signal });
    expect(result).toMatchObject({ status: 'stopped', iterations: 0 });
    expect(deps.evaluate).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
    const [record] = await records(result.tracePath);
    expect(record).toMatchObject({ evaluation: null, policy: null, approval: null, proposal: null, toolInput: null, toolResult: null });
    expect(JSON.stringify(record)).not.toContain('SECRET');
  });

  it.each(['evaluation', 'approval', 'information'] as const)('interrupts pending %s and fences late responses', async (phase) => {
    const state = await fixture();
    const controller = new AbortController();
    const started = deferred<void>();
    const late = deferred<never>();
    const deps = dependencies(phase === 'information' ? 'ASK_USER' : 'SEARCH_REPO');
    const pending = vi.fn(async () => { started.resolve(); return late.promise; });
    if (phase === 'evaluation') deps.evaluate = pending;
    if (phase === 'approval') deps.approve = pending;
    if (phase === 'information') deps.askForInformation = pending;
    const running = runOrchestration(state, deps, { signal: controller.signal, maxIterations: 1 });
    await started.promise;
    controller.abort('do not leak');
    const result = await running;
    expect(result.status).toBe('stopped');
    const [record] = await records(result.tracePath);
    expect(record.interruption).toEqual({ phase, reason: 'signal' });
    expect(record.toolInput).toBeNull();
    expect(record.toolResult).toBeNull();
    if (phase === 'evaluation') expect(record.evaluation).toBeNull();
    if (phase !== 'information') expect(record.approval).toBeNull();
    late.resolve((phase === 'evaluation' ? evaluation('CALL_CODEX') : phase === 'approval' ? { kind: 'approve' } : 'late answer') as never);
    await new Promise((resolve) => setImmediate(resolve));
    expect(deps.execute).not.toHaveBeenCalled();
    expect(result.state.evidence?.clarifications).toEqual([]);
  });

  it('starts no worker if cancellation arrives as approval returns', async () => {
    const state = await fixture();
    const controller = new AbortController();
    const deps = dependencies('CALL_CODEX');
    deps.approve = async () => { controller.abort(); return { kind: 'approve' }; };
    const result = await runOrchestration(state, deps, { signal: controller.signal });
    expect(result.status).toBe('stopped');
    expect(result.state.codexCalls).toBe(0);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it.each(['CALL_CODEX', 'CALL_CLAUDE'] as const)('drains cancelled %s edits and refreshes exact paths before returning', async (action) => {
    const state = await fixture();
    state.tests = { ran: true, passed: true };
    const controller = new AbortController();
    const cleanup = deferred<ToolResult>();
    const started = deferred<void>();
    const deps = dependencies(action);
    deps.inspect = vi.fn(inspectRepo);
    deps.execute = async (proposal, _runner, options) => {
      expect(options?.signal).toBe(controller.signal);
      expect(JSON.stringify(proposal)).not.toContain('signal');
      await writeFile(path.join(state.repo.root, 'partial.ts'), 'partial edits');
      controller.abort();
      started.resolve();
      return cleanup.promise;
    };
    let settled = false;
    const running = runOrchestration(state, deps, { signal: controller.signal, maxIterations: 1 }).then((result) => { settled = true; return result; });
    await started.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    cleanup.resolve({ action, ok: false, cancelled: true, exitCode: null, durationMs: 1, timedOut: false, output: 'Interrupted', files: [] });
    const result = await running;
    expect(result.status).toBe('stopped');
    expect(result.state.filesModified).toContain('partial.ts');
    expect(result.state[action === 'CALL_CODEX' ? 'codexCalls' : 'claudeCalls']).toBe(1);
    expect(result.state.tests).toEqual({ ran: false });
    expect(result.state.evidence?.validationGeneration).toBe(1);
    expect(deps.inspect).toHaveBeenCalledTimes(1);
    const [record] = await records(result.tracePath);
    expect(record.toolInput.task).toBe(state.task);
    expect(record.toolResult).toMatchObject({ cancelled: true, ok: false });
    expect(record.approval.kind).toBe('approve');
    expect(await readFile(path.join(state.repo.root, 'partial.ts'), 'utf8')).toBe('partial edits');
  });

  it.each([false, true])('stops during worker refresh and invalidates validation even with refresh failure=%s', async (fail) => {
    const state = await fixture();
    state.tests = { ran: true, passed: true };
    const controller = new AbortController();
    const deps = dependencies('CALL_CODEX');
    deps.inspect = async () => {
      controller.abort();
      if (fail) throw new Error('SECRET provider details');
      return { ...state.repo, gitStatus: [' M tracked.ts'] };
    };
    const result = await runOrchestration(state, deps, { signal: controller.signal, maxIterations: 1 });
    expect(result).toMatchObject({ status: 'stopped', state: { codexCalls: 1, tests: { ran: false } } });
    expect(result.state.evidence).toMatchObject({ validationGeneration: 1, repoRefreshRequired: fail });
    const [record] = await records(result.tracePath);
    expect(record.interruption.phase).toBe('refresh');
    expect(JSON.stringify(record)).not.toContain('SECRET');
    if (!fail) expect(result.state.filesModified).toEqual(['tracked.ts']);
  });

  it('never accepts cancelled validation as passing at the final iteration', async () => {
    const state = await fixture();
    const controller = new AbortController();
    const deps = dependencies('RUN_TESTS');
    deps.execute = async () => {
      controller.abort();
      return { action: 'RUN_TESTS', ok: true, exitCode: 0, durationMs: 1, timedOut: false, output: 'partial', files: [] };
    };
    const result = await runOrchestration(state, deps, { signal: controller.signal, maxIterations: 1 });
    expect(result.status).toBe('stopped');
    expect(result.state.tests.passed).toBe(false);
    expect(result.state.observations.join(' ')).not.toContain('iteration limit');
  });

  it('records interruption during trace finalization rather than returning iteration_limit', async () => {
    const state = await fixture();
    const controller = new AbortController();
    const append = trace.appendOrchestrationTrace;
    vi.spyOn(trace, 'appendOrchestrationTrace').mockImplementationOnce(async (...args) => {
      await append(...args);
      controller.abort();
    });
    const result = await runOrchestration(state, dependencies(), { signal: controller.signal, maxIterations: 1 });
    expect(result.status).toBe('stopped');
    const entries = await records(result.tracePath);
    expect(entries.at(-1).interruption).toEqual({ phase: 'trace', reason: 'signal' });
  });
});


it.each([false, true])('preserves approved worker identity and generation when cancelled=%s', async (cancelled) => {
  const state = await fixture();
  const controller = new AbortController();
  const deps = dependencies('CALL_CODEX');
  let approvedId = '';
  deps.execute = async (proposal) => {
    approvedId = proposalSignature(proposal, state);
    if (cancelled) controller.abort();
    return { action: 'CALL_CODEX', ok: false, exitCode: 1, durationMs: 1, timedOut: false, output: 'partial failure', files: [] };
  };
  const result = await runOrchestration(state, deps, { signal: controller.signal, maxIterations: 1 });
  const [record] = await records(result.tracePath);
  expect(record.workerRequest).toMatchObject({ id: approvedId, validationGeneration: 0, evidenceRevision: 0 });
  expect(record.stateAfter.evidence.validationGeneration).toBe(1);
});

it('preserves actual alternative selections while interrupting a later approval prompt', async () => {
  const state = await fixture();
  const controller = new AbortController();
  const pending = deferred<never>();
  const started = deferred<void>();
  const deps = dependencies();
  let prompts = 0;
  deps.approve = async () => {
    prompts += 1;
    if (prompts === 1) return { kind: 'alternative', action: 'CALL_CODEX' };
    started.resolve();
    return pending.promise;
  };
  const running = runOrchestration(state, deps, { signal: controller.signal });
  await started.promise;
  controller.abort();
  const result = await running;
  const [record] = await records(result.tracePath);
  expect(record.approval.history).toEqual([{ kind: 'alternative', action: 'CALL_CODEX' }]);
  expect(record.proposal.considered).toHaveLength(2);
  expect(record.proposal.selected.action).toBe('CALL_CODEX');
  expect(record.toolInput).toBeNull();
  expect(deps.execute).not.toHaveBeenCalled();
});

it('does not claim finish when the completion trace is interrupted', async () => {
  const state = await fixture();
  state.tests = { ran: true, passed: true };
  state.evidence!.validations = [{ iteration: 0, generation: 0, script: 'test', exitCode: 0, timedOut: false, passed: true, summary: 'tests passed' }];
  const controller = new AbortController();
  const deps = dependencies('FINISH');
  const resultEvaluation = evaluation('FINISH');
  resultEvaluation.assessment.taskComplete.probability = 0.99;
  deps.evaluate = async () => resultEvaluation;
  const append = trace.appendOrchestrationTrace;
  vi.spyOn(trace, 'appendOrchestrationTrace').mockImplementationOnce(async (...args) => {
    await append(...args);
    controller.abort();
  });
  const result = await runOrchestration(state, deps, { signal: controller.signal, maxIterations: 1 });
  expect(result.status).toBe('stopped');
  expect(result.state.currentGoal).not.toContain('Task complete');
  expect(deps.execute).not.toHaveBeenCalled();
  const entries = await records(result.tracePath);
  expect(entries.filter((entry) => entry.interruption)).toHaveLength(1);
});
