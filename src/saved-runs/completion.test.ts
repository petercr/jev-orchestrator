import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvaluationError } from '../ai/errors.js';
import { executeCandidate } from '../orchestration/execute.js';
import { createInitialState, runOrchestration, type OrchestrationOptions } from '../orchestration/loop.js';
import { runProcess, type ProcessRequest } from '../process.js';
import { inspectGitIdentity, inspectRepo } from '../repo/inspect.js';
import type { Action, EvaluationResult } from '../types.js';
import { createSavedRunConfiguration, createSavedRunRepository } from './contract.js';
import { refreshResumeState, resumePosition } from './resume.js';
import { captureRepositorySnapshot } from './snapshot.js';
import { openSavedRunStore } from './store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function evaluation(action: Action): EvaluationResult {
  return {
    model: 'mock/jev', latencyMs: 0, rawAnswers: {},
    assessment: {
      taskComplete: { probability: 0.28 }, needsMoreInformation: { probability: 0.22 },
      needsTesting: { probability: 0.24 }, stuck: { probability: 0.27 },
      nextAction: { choice: action, probabilities: { [action]: 0.78 }, confidence: 0.75 },
    },
  };
}

// Retain the failed live sequence with deterministic provider/worker boundaries.
// Git, saved records, resume refresh, reads, and independent validation are real.
describe('explicit task acceptance during inspection after restart', () => {
  it.each(['codex', 'claude'] as const)('accepts the %s patch on iteration 8 after recovery and resume', async (worker) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'dev-completion-resume-'));
    roots.push(parent);
    const root = path.join(parent, 'project');
    await mkdir(root);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }));
    await writeFile(path.join(root, 'package-lock.json'), '{}');
    await writeFile(path.join(root, '.gitignore'), 'traces/\n');
    await writeFile(path.join(root, 'AGENTS.md'), 'Implement only; separately approve npm test before acceptance.');
    await writeFile(path.join(root, 'value.txt'), 'original');
    await writeFile(path.join(root, 'check.mjs'), "import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';assert.equal(readFileSync('value.txt','utf8'),'original');\n");
    const git = (args: string[]) => execFileSync('git', ['-c', 'commit.gpgSign=false', ...args], { cwd: root });
    git(['init', '--quiet']);
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    const identity = await inspectGitIdentity(root);
    const repository = await createSavedRunRepository(identity.root, identity.gitCommonDirectory, identity.head);
    const initial = createInitialState(await inspectRepo(root), 'Update value.txt to patched and check.mjs to cover it. Read AGENTS.md. Run npm test.', worker);
    initial.evidence!.requiredInstructionFiles = ['AGENTS.md'];
    const store = await openSavedRunStore(path.join(parent, 'state'));
    const configuration = createSavedRunConfiguration('mock', undefined, worker);
    const created = await store.create({ repository, configuration, state: initial, iterationLimit: 8 });
    const persistence: OrchestrationOptions['persistence'] = {
      record: async (event, next) => store.append(created.runId, event, next,
        event.type === 'run_stopped' && event.resumable ? await captureRepositorySnapshot(repository) : undefined),
    };
    const runner = vi.fn(async (request: ProcessRequest) => {
      if (request.command === worker) {
        await writeFile(path.join(root, 'value.txt'), 'patched');
        await writeFile(path.join(root, 'check.mjs'), "import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';assert.equal(readFileSync('value.txt','utf8'),'patched');\n");
        return { exitCode: 0, timedOut: false, stdout: 'Patch prepared. No independent checks ran.', stderr: '' };
      }
      expect(request.command).toBe('npm');
      expect(request.args).toEqual(['run', 'test']);
      return runProcess(request);
    });
    const execute: typeof executeCandidate = (proposal, _runner, options) => executeCandidate(proposal, runner, options);
    const workerAction = worker === 'codex' ? 'CALL_CODEX' : 'CALL_CLAUDE';
    const recovery = vi.fn(async () => 'continue' as const);
    const first = await runOrchestration(initial, {
      evaluate: async (state) => {
        if (state.iteration === 3) throw new EvaluationError('invalid_response', 'Rejected distribution.', { stage: 'distribution', category: 'sum', probabilitySum: 0.99 });
        return evaluation(state.iteration === 1 ? 'READ_FILE' : state.iteration === 2 ? workerAction : 'RUN_TESTS');
      },
      recoverEvaluation: recovery,
      approve: async ({ state }) => ({ kind: state.iteration === 4 ? 'stop' : 'approve' }),
      askForInformation: vi.fn(), execute,
    }, { savedRunId: created.runId, persistence });
    expect(first).toMatchObject({ status: 'stopped', iterations: 4 });
    expect(recovery).toHaveBeenCalledOnce();
    const saved = await store.read(created.runId);
    const position = resumePosition(saved.checkpoint, saved.events);
    expect(position).toMatchObject({ nextIteration: 5, segment: 3, recoveryRequired: false });
    const snapshot = await store.readRepositorySnapshot(created.runId, position.repositorySnapshotHash);
    const resumed = refreshResumeState(saved.checkpoint, await inspectRepo(root), snapshot);
    expect(resumed.tests).toEqual({ ran: false });
    expect(resumed.filesRead).toEqual([]);
    await store.append(created.runId, { type: 'run_resumed', segment: position.segment }, resumed);
    const approvals: Array<{ iteration: number; action: Action }> = [];
    const second = await runOrchestration(resumed, {
      evaluate: async (state) => evaluation(state.iteration === 6 ? 'RUN_TESTS' : 'READ_FILE'),
      approve: async ({ state, proposal, policy, allowedAlternatives }) => {
        approvals.push({ iteration: state.iteration, action: proposal.action });
        expect(allowedAlternatives).not.toContain(worker === 'codex' ? 'CALL_CLAUDE' : 'CALL_CODEX');
        if (state.iteration <= 6) expect(allowedAlternatives).not.toContain('FINISH');
        if (state.iteration === 8 && proposal.action === 'READ_FILE') {
          expect(policy).toMatchObject({ selected: 'READ_FILE', override: false, completionReview: 'validated_inspection' });
          expect(allowedAlternatives).toContain('FINISH');
          expect(allowedAlternatives).not.toContain('RUN_TESTS');
          expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe('patched');
          return { kind: 'alternative', action: 'FINISH' };
        }
        return { kind: 'approve' };
      },
      askForInformation: vi.fn(), execute,
    }, { startIteration: position.nextIteration, savedRunId: created.runId, segment: position.segment, persistence });
    expect(second).toMatchObject({ status: 'finished', iterations: 8, state: {
      workerSelection: worker, codexCalls: Number(worker === 'codex'), claudeCalls: Number(worker === 'claude'), tests: { ran: true, passed: true },
    } });
    expect(approvals).toEqual([
      { iteration: 5, action: 'READ_FILE' }, { iteration: 6, action: 'RUN_TESTS' },
      { iteration: 7, action: 'READ_FILE' }, { iteration: 8, action: 'READ_FILE' }, { iteration: 8, action: 'FINISH' },
    ]);
    expect(runner.mock.calls.map(([request]) => request.command)).toEqual([worker, 'npm']);
    const final = await store.read(created.runId);
    expect(final.checkpoint).toMatchObject({ status: 'finished', configuration, iterationLimit: 8 });
    expect(final.events.filter((event) => event.type === 'iteration_reserved').map((event) => event.iteration)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(final.events.filter((event) => event.type === 'action_approved' && event.iteration === 3)).toEqual([]);
    expect(final.events.filter((event) => event.type === 'execution_reserved' && event.action === workerAction)).toHaveLength(1);
    const records = (await readFile(second.tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({
      iteration: 8, segment: 3, policy: { selected: 'READ_FILE', completionReview: 'validated_inspection' },
      proposal: { considered: [{ action: 'READ_FILE' }, { action: 'FINISH' }], selected: { action: 'FINISH' } },
      approval: { kind: 'approve', history: [{ kind: 'alternative', action: 'FINISH' }, { kind: 'approve' }] },
      toolInput: null, toolResult: null,
    });
    expect(() => resumePosition(final.checkpoint, final.events)).toThrow('durable clean stop');
  }, 45_000);
});
