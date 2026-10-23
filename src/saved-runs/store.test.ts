import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../orchestration/loop.js';
import type { RepoSnapshot } from '../types.js';
import {
  createSavedRunConfiguration,
  createSavedRunRepository,
  isSavedRunConfiguration,
  parseSavedRunJson,
} from './contract.js';
import { openSavedRunStore, SavedRunStoreError } from './store.js';
import {
  SAVED_RUN_CHECKPOINT_LIMIT_BYTES,
  SAVED_RUN_EVENT_LIMIT_BYTES,
  type SavedRunCheckpointV1,
} from './types.js';

const roots: string[] = [];

async function fixture(options: { workerSelection?: 'codex' | 'claude'; network?: boolean } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'jev-saved-run-'));
  roots.push(parent);
  const repositoryRoot = path.join(parent, 'project with spaces');
  const gitCommonDirectory = path.join(parent, 'git data');
  const storeRoot = path.join(parent, 'user-state');
  await Promise.all([mkdir(repositoryRoot), mkdir(gitCommonDirectory)]);
  const repository: RepoSnapshot = {
    root: repositoryRoot,
    packageManager: 'pnpm',
    scripts: [],
    validationScripts: [],
    gitStatus: [],
    topLevelFiles: [],
  };
  const identity = await createSavedRunRepository(repositoryRoot, gitCommonDirectory, 'a'.repeat(40));
  const state = createInitialState(repository, 'Fix the example task.', options.workerSelection,
    options.network === true ? true : undefined);
  const configuration = createSavedRunConfiguration('live', {
    provider: 'typesafe',
    model: 'jev-latest',
    apiKey: 'test-router-credential-never-store',
  }, options.workerSelection, options.network);
  const store = await openSavedRunStore(storeRoot);
  const checkpoint = await store.create({
    runId: randomUUID(),
    iterationLimit: 8,
    repository: identity,
    configuration,
    state,
  });
  return { parent, repositoryRoot, gitCommonDirectory, storeRoot, identity, state, configuration, store, checkpoint };
}

function expectStoreError(promise: Promise<unknown>, code: SavedRunStoreError['code']) {
  return expect(promise).rejects.toMatchObject({ code });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('saved run contract', () => {
  it('requires valid provider identity and forbids conflicting worker/network settings', () => {
    expect(isSavedRunConfiguration({
      mode: 'live', provider: 'cloudflare', model: 'clef', codexNetworkAccess: false,
    })).toBe(false);
    expect(isSavedRunConfiguration({
      mode: 'live', provider: 'cloudflare', model: 'clef', cloudflareAccountFingerprint: 'a'.repeat(64),
      codexNetworkAccess: false,
    })).toBe(true);
    expect(isSavedRunConfiguration({
      mode: 'live', provider: 'typesafe', model: 'another/model', codexNetworkAccess: false,
    })).toBe(false);
    expect(isSavedRunConfiguration({
      mode: 'live', provider: 'typesafe', model: 'jev-latest', workerSelection: 'claude',
      codexNetworkAccess: true,
    })).toBe(false);
  });

  it('selects user-owned state paths without consulting local value files', async () => {
    expect((await import('./store.js')).defaultSavedRunDirectory(
      { LOCALAPPDATA: 'D:\\Users\\test\\Local' }, 'win32', 'C:\\Users\\test',
    )).toBe('D:\\Users\\test\\Local\\dev-orchestrator\\saved-runs');
    expect((await import('./store.js')).defaultSavedRunDirectory(
      { XDG_STATE_HOME: '/tmp/state' }, 'linux', '/home/test',
    )).toBe('/tmp/state/dev-orchestrator/saved-runs');
    expect((await import('./store.js')).defaultSavedRunDirectory({}, 'darwin', '/Users/test'))
      .toBe('/Users/test/Library/Application Support/dev-orchestrator/saved-runs');
  });

  it('stores a bounded checkpoint and hash-linked event without credential or account values', async () => {
    const accountId = 'abcdef0123456789abcdef0123456789';
    const parent = await mkdtemp(path.join(os.tmpdir(), 'jev-saved-cloudflare-'));
    roots.push(parent);
    const repoRoot = path.join(parent, 'repo');
    const gitRoot = path.join(parent, 'git');
    await Promise.all([mkdir(repoRoot), mkdir(gitRoot)]);
    const state = createInitialState({
      root: repoRoot, packageManager: 'unknown', scripts: [], validationScripts: [], gitStatus: [], topLevelFiles: [],
    }, 'Task includes no secrets.');
    const repo = await createSavedRunRepository(repoRoot, gitRoot, 'b'.repeat(40));
    const config = createSavedRunConfiguration('live', {
      provider: 'cloudflare', model: 'clef', apiKey: 'test-cloudflare-credential-never-store', accountId,
    });
    expect(config.cloudflareAccountFingerprint).toBe(createHash('sha256').update(accountId).digest('hex'));
    const store = await openSavedRunStore(path.join(parent, 'state'));
    const checkpoint = await store.create({ iterationLimit: 8, repository: repo, configuration: config, state });
    const checkpointText = await readFile(path.join(store.directory, 'runs', checkpoint.runId, 'checkpoint.json'), 'utf8');
    const eventText = await readFile(path.join(store.directory, 'runs', checkpoint.runId, 'events.jsonl'), 'utf8');
    expect(checkpointText).not.toContain('test-cloudflare-credential-never-store');
    expect(checkpointText).not.toContain(accountId);
    expect(checkpointText).not.toContain('apiKey');
    expect(eventText).not.toContain(accountId);
    expect((await store.read(checkpoint.runId)).events.map((event) => event.type)).toEqual(['run_created']);
    if (process.platform !== 'win32') {
      expect((await lstat(store.directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(path.join(store.directory, 'runs', checkpoint.runId, 'checkpoint.json'))).mode & 0o777).toBe(0o600);
    }
  });

  it('redacts configured credential values from persisted task context', async () => {
    const context = await fixture();
    vi.stubEnv('TYPESAFE_API_KEY', 'current-test-environment-credential');
    const state = { ...context.state, task: 'Handle this key: current-test-environment-credential' };
    const run = await context.store.create({
      iterationLimit: 8,
      repository: context.identity,
      configuration: context.configuration,
      state,
    });
    const loaded = await context.store.read(run.runId);
    expect(loaded.checkpoint.state.task).toContain('[REDACTED]');
    expect(JSON.stringify(loaded)).not.toContain('current-test-environment-credential');
  });

  it('preserves sequence, task limits, and worker reservations across a clean stop', async () => {
    const context = await fixture({ workerSelection: 'codex' });
    const id = context.checkpoint.runId;
    let state = context.state;
    await context.store.append(id, { type: 'iteration_reserved', iteration: 1 }, state);
    await context.store.append(id, { type: 'evaluation_completed', iteration: 1 }, state);
    await context.store.append(id, { type: 'action_approved', iteration: 1, action: 'CALL_CODEX', decision: 'approve' }, state);
    state = { ...state, codexCalls: 1 };
    await context.store.append(id, {
      type: 'execution_reserved', iteration: 1, attemptId: randomUUID(), action: 'CALL_CODEX',
    }, state);
    const attemptId = (await context.store.read(id)).events.find((event) => event.type === 'execution_reserved');
    if (!attemptId || attemptId.type !== 'execution_reserved') throw new Error('Missing execution reservation fixture.');
    await context.store.append(id, { type: 'execution_outcome', attemptId: attemptId.attemptId, outcome: 'succeeded' }, state);
    await context.store.append(id, { type: 'run_stopped', reason: 'user', resumable: true }, state);
    await context.store.append(id, { type: 'run_resumed', segment: 2 }, state);
    state = { ...state, iteration: 2 };
    const resumed = await context.store.append(id, { type: 'iteration_reserved', iteration: 2 }, state);
    const loaded = await context.store.read(id);
    expect(resumed.status).toBe('active');
    expect(loaded.checkpoint.iterationLimit).toBe(8);
    expect(loaded.checkpoint.state.codexCalls).toBe(1);
    expect(loaded.checkpoint.state.iteration).toBe(2);
    expect(loaded.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('requires a fresh explicit recovery decision after a recorded evaluation failure', async () => {
    const context = await fixture();
    const id = context.checkpoint.runId;
    await expectStoreError(context.store.append(id, {
      type: 'evaluation_failed', iteration: 1, code: 'secret-provider-error', stage: 'raw-response', category: 'body',
    }, context.state), 'invalid_input');
    await context.store.append(id, { type: 'iteration_reserved', iteration: 1 }, context.state);
    await context.store.append(id, {
      type: 'evaluation_failed', iteration: 1, code: 'invalid_response', stage: 'distribution', category: 'sum',
    }, context.state);
    await context.store.append(id, { type: 'run_stopped', reason: 'evaluation_failure', resumable: true }, context.state);
    await expectStoreError(context.store.append(id, { type: 'run_resumed', segment: 2 }, context.state), 'invalid_input');
    const resumed = await context.store.append(id, {
      type: 'run_resumed', segment: 2, evaluationRecoveryApproved: true,
    }, context.state);
    expect(resumed.status).toBe('active');
  });

  it('does not carry an action approval across a stop and resume', async () => {
    const context = await fixture({ workerSelection: 'codex' });
    const id = context.checkpoint.runId;
    await context.store.append(id, { type: 'iteration_reserved', iteration: 1 }, context.state);
    await context.store.append(id, { type: 'evaluation_completed', iteration: 1 }, context.state);
    await context.store.append(id, { type: 'action_approved', iteration: 1, action: 'CALL_CODEX', decision: 'approve' }, context.state);
    await context.store.append(id, { type: 'run_stopped', reason: 'user', resumable: true }, context.state);
    await context.store.append(id, { type: 'run_resumed', segment: 2 }, context.state);
    await expectStoreError(context.store.append(id, {
      type: 'execution_reserved', iteration: 1, attemptId: randomUUID(), action: 'CALL_CODEX',
    }, { ...context.state, codexCalls: 1 }), 'invalid_record');
  });

  it('does not allow skipped iterations, unapproved execution, or a worker budget reset', async () => {
    const context = await fixture({ workerSelection: 'codex' });
    const id = context.checkpoint.runId;
    await expectStoreError(context.store.append(id, { type: 'iteration_reserved', iteration: 2 }, context.state), 'limit_reached');
    await context.store.append(id, { type: 'iteration_reserved', iteration: 1 }, context.state);
    await context.store.append(id, { type: 'evaluation_completed', iteration: 1 }, context.state);
    await expectStoreError(context.store.append(id, {
      type: 'execution_reserved', iteration: 1, attemptId: randomUUID(), action: 'CALL_CODEX',
    }, context.state), 'invalid_record');
    await context.store.append(id, { type: 'action_approved', iteration: 1, action: 'CALL_CODEX', decision: 'approve' }, context.state);
    const used = { ...context.state, codexCalls: 1 };
    await context.store.append(id, {
      type: 'execution_reserved', iteration: 1, attemptId: randomUUID(), action: 'CALL_CODEX',
    }, used);
    const { events } = await context.store.read(id);
    const pending = events.find((event) => event.type === 'execution_reserved');
    if (!pending || pending.type !== 'execution_reserved') throw new Error('Missing execution reservation fixture.');
    await expectStoreError(context.store.append(id,
      { type: 'execution_outcome', attemptId: pending.attemptId, outcome: 'succeeded' },
      { ...used, codexCalls: 2 }), 'invalid_record');
    await context.store.append(id, { type: 'execution_outcome', attemptId: pending.attemptId, outcome: 'succeeded' }, used);
    await context.store.append(id, { type: 'run_stopped', reason: 'user', resumable: true }, used);
    await context.store.append(id, { type: 'run_resumed', segment: 2 }, used);
    const next = { ...used, iteration: 2 };
    await context.store.append(id, { type: 'iteration_reserved', iteration: 2 }, next);
    await context.store.append(id, { type: 'evaluation_completed', iteration: 2 }, next);
    await context.store.append(id, { type: 'action_approved', iteration: 2, action: 'CALL_CODEX', decision: 'approve' }, next);
    await expectStoreError(context.store.append(id, {
      type: 'execution_reserved', iteration: 2, attemptId: randomUUID(), action: 'CALL_CODEX',
    }, { ...next, codexCalls: 3 }), 'invalid_input');
  });

  it('rejects a FINISH status without current-generation independent validation', async () => {
    const context = await fixture();
    const id = context.checkpoint.runId;
    await context.store.append(id, { type: 'iteration_reserved', iteration: 1 }, context.state);
    await context.store.append(id, { type: 'evaluation_completed', iteration: 1 }, context.state);
    await context.store.append(id, { type: 'action_approved', iteration: 1, action: 'FINISH', decision: 'approve' }, context.state);
    await expectStoreError(context.store.append(id, { type: 'run_finished' }, context.state), 'invalid_input');
  });

  it('rejects checkpoint edits even when their local checksum is recomputed', async () => {
    const context = await fixture();
    const file = path.join(context.store.directory, 'runs', context.checkpoint.runId, 'checkpoint.json');
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const checkpoint = parsed as unknown as SavedRunCheckpointV1;
    checkpoint.configuration = { ...checkpoint.configuration, model: 'jev-1.13' };
    delete parsed.checksum;
    parsed.checksum = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
    await writeFile(file, JSON.stringify(parsed));
    await expectStoreError(context.store.read(context.checkpoint.runId), 'integrity_failure');
  });

  it('rejects an older checkpoint after the event ledger advances', async () => {
    const context = await fixture();
    const file = path.join(context.store.directory, 'runs', context.checkpoint.runId, 'checkpoint.json');
    const original = await readFile(file, 'utf8');
    await context.store.append(context.checkpoint.runId, { type: 'iteration_reserved', iteration: 1 }, context.state);
    await writeFile(file, original);
    await expectStoreError(context.store.read(context.checkpoint.runId), 'integrity_failure');
  });

  it('rejects a partial event write and checkpoint/ledger disagreement', async () => {
    const context = await fixture();
    const file = path.join(context.store.directory, 'runs', context.checkpoint.runId, 'events.jsonl');
    const contents = await readFile(file, 'utf8');
    await writeFile(file, `${contents}{"schemaVersion":1`);
    await expectStoreError(context.store.read(context.checkpoint.runId), 'invalid_record');
  });

  it('rejects duplicate keys, unknown versions, and oversized saved files', async () => {
    expect(() => parseSavedRunJson('{"status":"active","status":"finished"}')).toThrow(/duplicate object key/u);
    const context = await fixture();
    const file = path.join(context.store.directory, 'runs', context.checkpoint.runId, 'checkpoint.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 2 }));
    await expectStoreError(context.store.read(context.checkpoint.runId), 'unsupported_version');
    await writeFile(file, 'x'.repeat(SAVED_RUN_CHECKPOINT_LIMIT_BYTES + 1));
    await expectStoreError(context.store.read(context.checkpoint.runId), 'limit_reached');
    const events = path.join(context.store.directory, 'runs', context.checkpoint.runId, 'events.jsonl');
    await writeFile(events, `${'x'.repeat(SAVED_RUN_EVENT_LIMIT_BYTES + 1)}\n`);
    await writeFile(file, JSON.stringify(context.checkpoint));
    await expectStoreError(context.store.read(context.checkpoint.runId), 'limit_reached');
  });

  it('blocks concurrent run/worktree owners and leaves ownership after an unclean exit', async () => {
    const context = await fixture();
    const runOwner = await context.store.acquireRunOwnership(context.checkpoint.runId);
    await expectStoreError(context.store.acquireRunOwnership(context.checkpoint.runId), 'busy');
    await runOwner.release();
    const worktreeOwner = await context.store.acquireWorktreeOwnership(context.repositoryRoot);
    await expectStoreError(context.store.acquireWorktreeOwnership(context.repositoryRoot), 'busy');
    await worktreeOwner.release();
    const owner = await context.store.acquireRunOwnership(context.checkpoint.runId);
    await writeFile(owner.lockPath, JSON.stringify({ kind: 'run', key: owner.key, token: 'changed' }));
    await expectStoreError(owner.release(), 'busy');
    await expectStoreError(context.store.acquireRunOwnership(context.checkpoint.runId), 'busy');
  });

  it('rejects storage inside the worker-writable worktree', async () => {
    const context = await fixture();
    const inRepository = await openSavedRunStore(path.join(context.repositoryRoot, 'state'));
    const state = createInitialState({ ...context.state.repo, root: context.repositoryRoot }, context.state.task);
    await expectStoreError(inRepository.create({
      iterationLimit: 8, repository: context.identity, configuration: context.configuration, state,
    }), 'invalid_input');
  });

  it('rejects symbolic links in saved-run store paths', async () => {
    if (process.platform === 'win32') return;
    const context = await fixture();
    const runDirectory = path.join(context.store.directory, 'runs', context.checkpoint.runId);
    await rm(runDirectory, { recursive: true });
    await symlink(context.repositoryRoot, runDirectory, 'dir');
    await expectStoreError(context.store.read(context.checkpoint.runId), 'invalid_record');
  });

  it('rejects hard-linked checkpoints and event records', async () => {
    if (process.platform === 'win32') return;
    const context = await fixture();
    const checkpointFile = path.join(context.store.directory, 'runs', context.checkpoint.runId, 'checkpoint.json');
    await link(checkpointFile, path.join(context.parent, 'checkpoint-copy.json'));
    await expectStoreError(context.store.read(context.checkpoint.runId), 'limit_reached');
  });
});
