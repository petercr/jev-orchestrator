import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectRepo } from '../repo/inspect.js';
import type { Action, EvaluationResult } from '../types.js';
import { createInitialState, runOrchestration } from './loop.js';
import { executeCandidate, type ToolResult } from './execute.js';

const roots: string[] = [];
const issueUrl = 'https://github.com/owner/repo/issues/80';

function evaluation(choice: Action): EvaluationResult {
  return {
    model: 'mock/jev', latencyMs: 0, rawAnswers: {},
    assessment: {
      taskComplete: { probability: 0.2 }, needsMoreInformation: { probability: 0.01 },
      needsTesting: { probability: choice === 'RUN_TESTS' ? 0.95 : 0.01 }, stuck: { probability: 0.01 },
      nextAction: { choice, probabilities: { [choice]: 0.9 }, confidence: 0.8 },
    },
  };
}

function preparedState(repo: Awaited<ReturnType<typeof repository>>) {
  const initial = createInitialState(repo, issueUrl);
  initial.filesRead = ['CONTRIBUTING.md', 'CLAUDE.md'];
  initial.evidence!.issue = {
    url: issueUrl, title: 'Rename config', body: 'Rename config and update references.',
    requestedValidationScripts: ['test', 'typecheck', 'verify'], truncated: false,
  };
  return initial;
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-completion-'));
  roots.push(root);
  await writeFile(path.join(root, 'CONTRIBUTING.md'), 'Use npm ci and npm run verify.');
  await writeFile(path.join(root, 'CLAUDE.md'), 'Run repository checks before completion.');
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  await writeFile(path.join(root, 'vitest.config.ts'), 'export default {};\n');
  await writeFile(path.join(root, 'tsconfig.test.json'), '{"include":["vitest.config.ts"]}\n');
  const commands = { verify: 'npm run lint && npm run typecheck && npm test', lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest run', build: 'tsc' };
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: commands }));
  return await inspectRepo(root);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('completion after independent validation', () => {
  it('finishes the pilot workflow through explicit review when Jev repeats RUN_TESTS', async () => {
    const repo = await repository();
    const runner = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'checks passed', stderr: '', timedOut: false });
    const execute = vi.fn<typeof executeCandidate>().mockImplementation(async (proposal) => {
      if (proposal.action === 'READ_ISSUE') return {
        action: 'READ_ISSUE', ok: true, exitCode: 0, timedOut: false, durationMs: 1, output: 'Rename config', files: [],
        issue: { url: issueUrl, title: 'Rename config', body: 'Rename config and update references. Run npm test, npm run typecheck, npm run verify.', requestedValidationScripts: ['test', 'typecheck', 'verify'], truncated: false },
      } satisfies ToolResult;
      if (proposal.action === 'CALL_CODEX') {
        await rename(path.join(repo.root, 'vitest.config.ts'), path.join(repo.root, 'vitest.config.mts'));
        await writeFile(path.join(repo.root, 'tsconfig.test.json'), '{"include":["vitest.config.mts"]}\n');
        return { action: 'CALL_CODEX', ok: true, exitCode: 0, timedOut: false, durationMs: 1, output: 'Renamed config. Worker tests blocked by listen EPERM.', files: [] } satisfies ToolResult;
      }
      return executeCandidate(proposal, runner);
    });
    const approvalHistory: Array<{ iteration: number; action: string }> = [];
    const askForInformation = vi.fn();
    const result = await runOrchestration(createInitialState(repo, issueUrl), {
      evaluate: async (state) => {
        const request = evaluation(state.iteration <= 4 ? 'CALL_CODEX' : 'RUN_TESTS');
        request.assessment.needsTesting.probability = 0.95;
        return request;
      },
      approve: async ({ state, proposal, policy, allowedAlternatives }) => {
        approvalHistory.push({ iteration: state.iteration, action: proposal.action });
        if (state.iteration === 7 && proposal.action === 'ASK_USER') {
          expect(policy).toMatchObject({ requested: 'RUN_TESTS', selected: 'ASK_USER', completionReview: 'validation_complete' });
          expect(allowedAlternatives).toContain('FINISH');
          expect(allowedAlternatives).not.toContain('RUN_TESTS');
          return { kind: 'alternative', action: 'FINISH' };
        }
        return { kind: 'approve' };
      },
      askForInformation, execute,
      inspect: async () => ({ ...repo, gitStatus: [' M tsconfig.test.json', ' D vitest.config.ts', '?? vitest.config.mts'] }),
    }, { maxIterations: 7 });
    expect(result).toMatchObject({ status: 'finished', iterations: 7, state: { codexCalls: 1, claudeCalls: 0, tests: { ran: true, passed: true }, evidence: { validationGeneration: 1 } } });
    expect(runner.mock.calls.map(([command]) => command.args)).toEqual([['run', 'verify'], ['run', 'build']]);
    expect(askForInformation).not.toHaveBeenCalled();
    expect(approvalHistory.slice(0, 6).map((entry) => entry.action)).toEqual([
      'READ_ISSUE', 'READ_FILE', 'READ_FILE', 'CALL_CODEX', 'RUN_TESTS', 'RUN_TESTS',
    ]);
    expect(approvalHistory.slice(-2)).toEqual([{ iteration: 7, action: 'ASK_USER' }, { iteration: 7, action: 'FINISH' }]);
    expect(await readFile(path.join(repo.root, 'vitest.config.mts'), 'utf8')).toBe('export default {};\n');
    const records = (await readFile(result.tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records).toHaveLength(7);
    expect(records[6]).toMatchObject({
      policy: { requested: 'RUN_TESTS', selected: 'ASK_USER', completionReview: 'validation_complete' },
      proposal: { considered: [{ action: 'ASK_USER' }, { action: 'FINISH' }], selected: { action: 'FINISH' } },
      approval: { kind: 'approve', history: [{ kind: 'alternative', action: 'FINISH' }, { kind: 'approve' }] },
      toolResult: null, stateAfter: { currentGoal: 'Task complete.' },
    });
    expect(result.state.observations).toContain('User explicitly confirmed task acceptance after all required independent validation passed.');
  });

  function recordValidatedWorker(initial: ReturnType<typeof createInitialState>): void {
    initial.tests = { ran: true, passed: true };
    initial.claudeCalls = 1;
    initial.evidence!.validationGeneration = 1;
    initial.evidence!.worker = { agent: 'claude', iteration: 1, evidenceRevision: 0, exitCode: 0, timedOut: false, ok: true, summary: '', modifiedFiles: [] };
    initial.evidence!.validations = ['verify', 'build'].map((script) => ({ iteration: 2, generation: 1, script, exitCode: 0, timedOut: false, passed: true, summary: '' }));
    initial.iteration = 2;
  }

  it('approving a validated inspection still executes only the read and exhausts the unchanged budget', async () => {
    const repo = await repository();
    const initial = preparedState(repo);
    recordValidatedWorker(initial);
    const execute = vi.fn<typeof executeCandidate>().mockImplementation((proposal) => executeCandidate(proposal));
    const result = await runOrchestration(initial, {
      evaluate: async () => evaluation('READ_FILE'),
      approve: async ({ proposal, allowedAlternatives }) => {
        expect(proposal.action).toBe('READ_FILE');
        expect(allowedAlternatives).toContain('FINISH');
        return { kind: 'approve' };
      },
      askForInformation: vi.fn(), execute,
    }, { startIteration: 3, maxIterations: 3 });
    expect(result).toMatchObject({ status: 'iteration_limit', exitCode: 1, iterations: 3, state: { claudeCalls: 1 } });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0].action).toBe('READ_FILE');
    expect(result.state.observations).not.toContain('User explicitly confirmed task acceptance after all required independent validation passed.');
  });

  it.each(['reject', 'stop', 'interrupt', 'invalidate', 'remove_worker'] as const)('does not complete an inspection alternative after %s at final approval', async (condition) => {
    const repo = await repository();
    const initial = preparedState(repo);
    recordValidatedWorker(initial);
    const controller = new AbortController();
    const execute = vi.fn();
    const seen: string[] = [];
    const result = await runOrchestration(initial, {
      evaluate: async () => evaluation('READ_FILE'),
      approve: async ({ proposal, state }) => {
        seen.push(proposal.action);
        if (proposal.action === 'READ_FILE') return { kind: 'alternative', action: 'FINISH' };
        if (condition === 'reject' || condition === 'stop') return { kind: condition };
        if (condition === 'interrupt') controller.abort();
        if (condition === 'invalidate') state.evidence!.validationGeneration += 1;
        if (condition === 'remove_worker') delete state.evidence!.worker;
        return { kind: 'approve' };
      },
      askForInformation: vi.fn(), execute,
    }, { startIteration: 3, maxIterations: 3, signal: controller.signal });
    expect(seen).toEqual(['READ_FILE', 'FINISH']);
    expect(result.status).toBe(condition === 'stop' || condition === 'interrupt' ? 'stopped' : 'iteration_limit');
    expect(result.state.currentGoal).not.toBe('Task complete.');
    expect(execute).not.toHaveBeenCalled();
    const record = JSON.parse((await readFile(result.tracePath, 'utf8')).trim());
    expect(record).toMatchObject({ policy: { selected: 'READ_FILE', completionReview: 'validated_inspection' }, toolInput: null, toolResult: null });
    if (condition === 'interrupt') expect(record.approval.history).toEqual([{ kind: 'alternative', action: 'FINISH' }]);
  });

  it.each(['reject', 'stop'] as const)('does not complete a validation review on %s', async (kind) => {
    const repo = await repository();
    const initial = preparedState(repo);
    initial.tests = { ran: true, passed: true };
    initial.evidence!.validations = ['verify', 'build'].map((script) => ({ iteration: 0, generation: 0, script, exitCode: 0, timedOut: false, passed: true, summary: '' }));
    const execute = vi.fn();
    const seen: string[] = [];
    const result = await runOrchestration(initial, {
      evaluate: async () => evaluation('RUN_TESTS'),
      approve: async ({ proposal }) => {
        seen.push(proposal.action);
        return seen.length === 1 ? { kind: 'alternative', action: 'FINISH' } : { kind };
      },
      askForInformation: vi.fn(), execute,
    }, { maxIterations: 1 });
    expect(seen).toEqual(['ASK_USER', 'FINISH']);
    expect(result.status).toBe(kind === 'stop' ? 'stopped' : 'iteration_limit');
    expect(result.state.currentGoal).not.toBe('Task complete.');
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not fabricate completion approval when the resolved review is interrupted', async () => {
    const repo = await repository();
    const initial = preparedState(repo);
    initial.tests = { ran: true, passed: true };
    initial.evidence!.validations = ['verify', 'build'].map((script) => ({ iteration: 0, generation: 0, script, exitCode: 0, timedOut: false, passed: true, summary: '' }));
    const controller = new AbortController();
    const execute = vi.fn();
    const result = await runOrchestration(initial, {
      evaluate: async () => evaluation('RUN_TESTS'),
      approve: async ({ proposal }) => {
        if (proposal.action === 'ASK_USER') return { kind: 'alternative', action: 'FINISH' };
        controller.abort();
        return { kind: 'approve' };
      },
      askForInformation: vi.fn(), execute,
    }, { signal: controller.signal });
    expect(result.status).toBe('stopped');
    expect(result.state.currentGoal).not.toBe('Task complete.');
    expect(execute).not.toHaveBeenCalled();
    const record = JSON.parse((await readFile(result.tracePath, 'utf8')).trim());
    expect(record).toMatchObject({
      interruption: { phase: 'approval' }, proposal: { selected: { action: 'FINISH' } },
      toolInput: null, toolResult: null,
    });
    expect(record.approval.history).toEqual([{ kind: 'alternative', action: 'FINISH' }]);
  });

  it.each((['RUN_TESTS', 'READ_FILE'] as const).flatMap((route) =>
    (['pending', 'failed', 'new_generation', 'refresh', 'omitted_requirements', 'missing_information', 'stuck', 'ambiguous'] as const)
      .map((condition) => ({ route, condition }))))('withholds $route completion on $condition evidence', async ({ route, condition }) => {
    const repo = await repository();
    const initial = preparedState(repo);
    recordValidatedWorker(initial);
    if (condition === 'pending') initial.evidence!.validations!.pop();
    if (condition === 'failed') initial.evidence!.validations![0]!.passed = false;
    if (condition === 'new_generation') initial.evidence!.validationGeneration += 1;
    if (condition === 'refresh') initial.evidence!.repoRefreshRequired = true;
    if (condition === 'omitted_requirements') initial.evidence!.issue = { url: issueUrl, title: 'Task', body: '', requestedValidationScripts: [], truncated: false, validationRequirementsTruncated: true };
    const request = evaluation(route);
    if (condition === 'missing_information') request.assessment.needsMoreInformation.probability = 0.95;
    if (condition === 'stuck') request.assessment.stuck.probability = 0.95;
    if (condition === 'ambiguous') request.assessment.nextAction.confidence = 0.1;
    const alternatives: string[][] = [];
    const result = await runOrchestration(initial, {
      evaluate: async () => request,
      approve: async ({ allowedAlternatives }) => { alternatives.push(allowedAlternatives); return { kind: 'stop' }; },
      askForInformation: vi.fn(), execute: vi.fn(),
    }, { startIteration: 3 });
    expect(alternatives[0]).not.toContain('FINISH');
    expect(result.status).toBe('stopped');
  });
});
