import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState, runOrchestration } from '../orchestration/loop.js';
import { createRunMetrics } from '../orchestration/summary.js';
import { inspectGitIdentity, inspectRepo } from '../repo/inspect.js';
import { hasPassedValidation, pendingValidationScripts } from '../repo/validation.js';
import { taskPreparation } from '../repo/preparation.js';
import { applyPolicy } from '../policy.js';
import { selectCandidate } from '../orchestration/candidate.js';
import { mockEvaluation } from '../mock.js';
import * as tracing from '../logging/trace.js';
import { createSavedRunConfiguration, createSavedRunRepository } from './contract.js';
import { captureRepositorySnapshot, changedSnapshotPaths, SNAPSHOT_FILE_BYTES } from './snapshot.js';
import { refreshResumeState, resolveResumeConfiguration, resumePosition, validateSnapshotDrift } from './resume.js';
import { openSavedRunStore } from './store.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'dev-resume-unit-'));
  roots.push(parent);
  const root = path.join(parent, 'project');
  await mkdir(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs', build: 'node check.mjs' } }));
  await writeFile(path.join(root, 'AGENTS.md'), 'Read these instructions before implementing.');
  await writeFile(path.join(root, 'value.txt'), 'original');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: root });
  const git = await inspectGitIdentity(root);
  const repository = await createSavedRunRepository(git.root, git.gitCommonDirectory, git.head);
  const state = createInitialState(await inspectRepo(root), 'Fix value.txt and run pnpm lint.', 'codex');
  const configuration = createSavedRunConfiguration('mock', undefined, 'codex');
  const store = await openSavedRunStore(path.join(parent, 'state'));
  const created = await store.create({ state, repository, configuration, iterationLimit: 5 });
  await store.append(created.runId, { type: 'iteration_reserved', iteration: 1 }, state);
  await store.append(created.runId, { type: 'evaluation_completed', iteration: 1 }, state);
  const snapshot = await captureRepositorySnapshot(repository);
  const checkpoint = await store.append(created.runId, { type: 'run_stopped', reason: 'user', resumable: true }, state, snapshot);
  return { root, parent, repository, state, store, checkpoint, snapshot };
}

// These fixtures perform real Git operations and durable file flushes.
describe('resume content and configuration preflight', { timeout: 15_000 }, () => {
  it('compares actual content for tracked and untracked files, and excludes secret/generated paths', async () => {
    const context = await fixture();
    await writeFile(path.join(context.root, 'value.txt'), 'dirty one');
    await writeFile(path.join(context.root, 'new.txt'), 'untracked one');
    await writeFile(path.join(context.root, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(context.root, 'ignored.txt'), 'ignored one');
    await writeFile(path.join(context.root, '.env'), 'TYPESAFE_API_KEY=never-read-fixture');
    const before = await captureRepositorySnapshot(context.repository);
    const status = (await inspectRepo(context.root)).gitStatus;
    await writeFile(path.join(context.root, 'value.txt'), 'dirty two');
    await writeFile(path.join(context.root, 'new.txt'), 'untracked two');
    await writeFile(path.join(context.root, 'ignored.txt'), 'ignored two');
    const after = await captureRepositorySnapshot(context.repository);
    expect((await inspectRepo(context.root)).gitStatus).toEqual(status);
    expect(changedSnapshotPaths(before, after)).toEqual(['ignored.txt', 'new.txt', 'value.txt']);
    expect(JSON.stringify(after)).not.toContain('never-read-fixture');
    expect(after.files.some((file) => file.path === '.env')).toBe(false);
    vi.stubEnv('TYPESAFE_API_KEY', 'fixture-path-credential');
    await writeFile(path.join(context.root, 'fixture-path-credential'), 'ordinary file');
    await expect(captureRepositorySnapshot(context.repository)).rejects.toThrow('sensitive text');
    await expect(context.store.append(context.checkpoint.runId, { type: 'run_stopped', reason: 'user', resumable: true }, context.state,
      { version: 1, files: [{ path: 'fixture-path-credential', hash: null }] })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await readFile(path.join(context.store.runsDirectory, context.checkpoint.runId, 'repository.json'), 'utf8')).not.toContain('fixture-path-credential');
  });

  it('binds the sidecar to the stopped ledger and rejects altered content without repair', async () => {
    const context = await fixture();
    const record = await context.store.read(context.checkpoint.runId);
    const position = resumePosition(record.checkpoint, record.events);
    expect(position).toMatchObject({ nextIteration: 2, segment: 2, recoveryRequired: false });
    expect(await context.store.readRepositorySnapshot(record.checkpoint.runId, position.repositorySnapshotHash)).toEqual(context.snapshot);
    await writeFile(path.join(context.store.runsDirectory, record.checkpoint.runId, 'repository.json'), JSON.stringify({ version: 1, files: [] }));
    await expect(context.store.readRepositorySnapshot(record.checkpoint.runId, position.repositorySnapshotHash)).rejects.toMatchObject({ code: 'integrity_failure' });
  });

  it('blocks changed HEAD, missing instructions, linked files, and oversized content', async () => {
    const context = await fixture();
    await rm(path.join(context.root, 'AGENTS.md'));
    const changed = await captureRepositorySnapshot(context.repository);
    expect(() => validateSnapshotDrift(context.snapshot, changed)).toThrow('instruction file is unavailable');
    await writeFile(path.join(context.root, 'AGENTS.md'), 'Restored');
    await link(path.join(context.root, 'value.txt'), path.join(context.root, 'hard.txt'));
    await expect(captureRepositorySnapshot(context.repository)).rejects.toThrow('without links');
    await rm(path.join(context.root, 'hard.txt'));
    await writeFile(path.join(context.root, 'large.txt'), Buffer.alloc(SNAPSHOT_FILE_BYTES + 1));
    await expect(captureRepositorySnapshot(context.repository)).rejects.toThrow('bounded regular files');
    await rm(path.join(context.root, 'large.txt'));
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'new head'], { cwd: context.root });
    await expect(captureRepositorySnapshot(context.repository)).rejects.toThrow('HEAD changed');
  });

  it.skipIf(process.platform === 'win32')('refuses symlinked content and ancestor directories', async () => {
    const context = await fixture();
    await symlink(path.join(context.root, 'value.txt'), path.join(context.root, 'alias.txt'));
    await expect(captureRepositorySnapshot(context.repository)).rejects.toThrow('without links');
  });

  it('reloads credentials for the stored provider/model without selecting new defaults', () => {
    const saved = createSavedRunConfiguration('live', { provider: 'openrouter', model: 'openai/gpt-6-luna-decisions', apiKey: 'old' }, 'codex');
    expect(resolveResumeConfiguration(saved, { OPENROUTE_API_KEY: 'replacement' })).toEqual({
      provider: 'openrouter', model: 'openai/gpt-6-luna-decisions', apiKey: 'replacement',
    });
    for (const changed of [
      { ROUTER_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'fixture' },
      { ROUTER_MODEL: 'typesafe/jev-1.13', OPENROUTER_API_KEY: 'fixture' },
      { ROUTER_PROVIDER: '', OPENROUTER_API_KEY: 'fixture' },
      { OPENROUTE_MODEL: 'typesafe/jev-1.13', OPENROUTER_API_KEY: 'fixture' },
    ]) expect(() => resolveResumeConfiguration(saved, changed)).toThrow();
    expect(() => resolveResumeConfiguration(saved, {})).toThrow('required');
    expect(JSON.stringify(saved)).not.toContain('replacement');
  });

  it('rejects Cloudflare account changes while allowing a reloaded token', () => {
    const saved = createSavedRunConfiguration('live', { provider: 'cloudflare', model: 'clef-flash', accountId: 'a'.repeat(32), apiKey: 'old' });
    expect(resolveResumeConfiguration(saved, { CLOUDFLARE_AUTH_TOKEN: 'new', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) })).toMatchObject({ apiKey: 'new' });
    expect(() => resolveResumeConfiguration(saved, { CLOUDFLARE_AUTH_TOKEN: 'new', CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32) })).toThrow('account identity');
  });
});

describe('resumed state and enforcement', { timeout: 15_000 }, () => {
  it.each([
    { agent: 'codex', ok: true, exitCode: 0 }, { agent: 'claude', ok: true, exitCode: 0 },
    { agent: 'codex', ok: false, exitCode: 1 }, { agent: 'claude', ok: false, exitCode: 1 },
  ] as const)('retains the recorded $agent process outcome ($ok) without restoring validation authority', async ({ agent, ok, exitCode }) => {
    const context = await fixture();
    const checkpoint = structuredClone(context.checkpoint);
    checkpoint.configuration.workerSelection = agent;
    checkpoint.state.workerSelection = agent;
    checkpoint.state.codexCalls = Number(agent === 'codex');
    checkpoint.state.claudeCalls = Number(agent === 'claude');
    checkpoint.state.evidence!.worker = {
      iteration: 1, agent, evidenceRevision: 0, exitCode, timedOut: false, ok,
      summary: 'Worker claims task completion and passing tests.', modifiedFiles: ['value.txt'],
    };
    checkpoint.state.tests = { ran: true, passed: true };
    const resumed = refreshResumeState(checkpoint, await inspectRepo(context.root), context.snapshot);
    expect(resumed.evidence?.worker).toMatchObject({ agent, ok, exitCode, modifiedFiles: [],
      summary: 'An earlier segment attempted this worker. Fresh independent validation is required.' });
    expect(resumed.tests).toEqual({ ran: false });
    expect(resumed.workerSelection).toBe(agent);
    expect(resumed.codexCalls + resumed.claudeCalls).toBe(1);
    expect(resumed.evidence?.validations).toEqual([]);
    expect(resumed.filesRead).toEqual([]);
    expect(hasPassedValidation(resumed)).toBe(false);
    expect((await selectCandidate('FINISH', resumed)).action).toBe('ASK_USER');
  });

  it('retains requirements, provenance, failures, and limits while invalidating prior validation and reads', async () => {
    const context = await fixture();
    const before = structuredClone(context.checkpoint);
    before.state.filesRead = ['AGENTS.md'];
    before.state.tests = { ran: true, passed: true };
    before.state.codexCalls = 1;
    before.state.failedApproaches = ['failed-signature'];
    before.state.evidence = {
      revision: 2, validationGeneration: 1, findings: [{ iteration: 1, source: 'read', paths: ['AGENTS.md'], excerpt: 'stale' }],
      clarifications: [{ iteration: 1, text: 'Run pnpm typecheck too.' }],
      failures: [{ iteration: 1, action: 'READ_ISSUE', summary: 'unavailable' }],
      validations: [{ iteration: 1, generation: 1, script: 'test', passed: true, timedOut: false, exitCode: 0, summary: 'old pass' }],
    };
    const current = { ...await inspectRepo(context.root), validationScripts: ['test'], requiredValidationScripts: ['test'] };
    const resumed = refreshResumeState(before, current, context.snapshot);
    expect(resumed).toMatchObject({
      task: before.state.task, workerSelection: 'codex', codexCalls: 1,
      failedApproaches: ['failed-signature'], filesRead: [], tests: { ran: false },
      evidence: { revision: 3, validationGeneration: 2, findings: [], validations: [], requiredInstructionFiles: ['AGENTS.md'] },
    });
    expect(resumed.evidence?.clarifications).toEqual(before.state.evidence.clarifications);
    expect(pendingValidationScripts(resumed)).toEqual(expect.arrayContaining(['test', 'build', 'lint', 'typecheck']));
    expect(hasPassedValidation(resumed)).toBe(false);
    expect(taskPreparation(resumed).nextAction).toBe('READ_FILE');
    const finish = mockEvaluation(before.state).assessment;
    finish.nextAction.choice = 'FINISH'; finish.nextAction.probabilities = { FINISH: 1 }; finish.nextAction.confidence = 0.99;
    expect(applyPolicy(resumed, finish).selected).toBe('READ_FILE');
    expect((await selectCandidate('FINISH', resumed)).action).toBe('ASK_USER');
    expect(before.state.filesRead).toEqual(['AGENTS.md']);
  });

  it('starts the next unused iteration and does not execute an old action approval', async () => {
    const context = await fixture();
    const refreshed = refreshResumeState(context.checkpoint, await inspectRepo(context.root), context.snapshot);
    const execute = vi.fn();
    const result = await runOrchestration(refreshed, {
      evaluate: async () => mockEvaluation(refreshed), approve: async () => ({ kind: 'stop' }),
      askForInformation: async () => '', execute,
    }, { startIteration: 2, maxIterations: 5, savedRunId: context.checkpoint.runId, segment: 2 });
    expect(result.iterations).toBe(2);
    expect(execute).not.toHaveBeenCalled();
    const trace = JSON.parse((await readFile(result.tracePath, 'utf8')).trim());
    expect(trace).toMatchObject({ savedRunId: context.checkpoint.runId, segment: 2, iteration: 2 });
  });

  it('keeps resume review waits outside active time without fabricating action approvals', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
    const metrics = createRunMetrics(25, 500);
    clock.mockReturnValue(20);
    expect(metrics.snapshot()).toMatchObject({ timings: { elapsedMs: 535, activeMs: 35, resumeReviewWaitMs: 500 }, counts: { approvals: 0 } });
  });

  it('cannot create a clean continuation point when the terminal trace write fails', async () => {
    const context = await fixture();
    const state = refreshResumeState(context.checkpoint, await inspectRepo(context.root), context.snapshot);
    await context.store.append(context.checkpoint.runId, { type: 'run_resumed', segment: 2 }, state);
    vi.spyOn(tracing, 'appendOrchestrationTrace').mockRejectedValue(new tracing.TraceWriteError());
    await expect(runOrchestration(state, {
      evaluate: async () => mockEvaluation(state), approve: async () => ({ kind: 'stop' }),
      askForInformation: async () => '',
    }, {
      startIteration: 2, maxIterations: 5,
      persistence: { record: (event, next) => context.store.append(context.checkpoint.runId, event, next) },
    })).rejects.toThrow(tracing.TraceWriteError);
    const record = await context.store.read(context.checkpoint.runId);
    expect(record.checkpoint.status).toBe('active');
    expect(record.events.at(-1)?.type).toBe('evaluation_completed');
    expect(() => resumePosition(record.checkpoint, record.events)).toThrow('durable clean stop');
  });
});
