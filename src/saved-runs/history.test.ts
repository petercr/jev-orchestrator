import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../cli.js';
import { formatSavedRunLines } from '../cli/history.js';
import { createPresentation } from '../cli/terminal.js';
import * as config from '../config.js';
import * as evaluation from '../ai/evaluate.js';
import * as execution from '../orchestration/execute.js';
import * as inspection from '../repo/inspect.js';
import * as traces from '../logging/trace.js';
import { createInitialState } from '../orchestration/loop.js';
import type { AgentState } from '../types.js';
import { createSavedRunConfiguration, createSavedRunRepository } from './contract.js';
import { inspectSavedRun, listSavedRuns, SAVED_RUN_LIST_LIMIT } from './history.js';
import { openSavedRunStore, SavedRunStore } from './store.js';
import { SAVED_RUN_COUNT_LIMIT } from './types.js';

const roots: string[] = [];
const originalExitCode = process.exitCode;

async function parentDirectory() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'dev-run-history-'));
  roots.push(parent);
  return parent;
}

async function fixture(options: { worker?: 'codex' | 'claude'; limit?: number; task?: string } = {}) {
  const parent = await parentDirectory();
  const root = path.join(parent, 'project');
  const git = path.join(root, '.git');
  await mkdir(git, { recursive: true });
  const state = createInitialState({
    root, packageManager: 'pnpm', scripts: ['verify', 'check', 'test', 'build'],
    validationScripts: ['verify', 'check', 'test', 'build'], requiredValidationScripts: ['check', 'test', 'build'],
    validationScriptCoverage: { verify: ['verify', 'check', 'test'] },
    gitStatus: [], topLevelFiles: [],
  }, options.task ?? 'Fix the example.', options.worker);
  const repository = await createSavedRunRepository(root, git, 'a'.repeat(40));
  const configuration = createSavedRunConfiguration('live', {
    provider: 'typesafe', model: 'jev-latest', apiKey: 'test-only-unpersisted-key',
  }, options.worker);
  const store = await openSavedRunStore(path.join(parent, 'state'));
  const input = { state, repository, configuration, iterationLimit: options.limit ?? 8 };
  const checkpoint = await store.create(input);
  return { parent, root, state, input, checkpoint, store, id: checkpoint.runId };
}

async function evaluate(context: Awaited<ReturnType<typeof fixture>>, state = context.state) {
  await context.store.append(context.id, { type: 'iteration_reserved', iteration: state.iteration }, state);
  await context.store.append(context.id, { type: 'evaluation_completed', iteration: state.iteration }, state);
}

async function stop(context: Awaited<ReturnType<typeof fixture>>, state = context.state) {
  await context.store.append(context.id, { type: 'run_stopped', reason: 'user', resumable: true }, state);
}

async function fileSnapshot(directory: string): Promise<unknown[]> {
  const details = await lstat(directory);
  const result: unknown[] = [{ path: directory, mode: details.mode, mtime: details.mtimeMs }];
  if (details.isDirectory()) {
    for (const entry of (await readdir(directory)).sort()) result.push(...await fileSnapshot(path.join(directory, entry)));
  } else if (details.isFile()) {
    result.push(await readFile(directory, 'utf8'));
  }
  return result;
}

afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('read-only saved run history', () => {
  it('reports an empty missing store without creating it', async () => {
    const parent = await parentDirectory();
    const directory = path.join(parent, 'missing-store');
    const store = await SavedRunStore.openForInspection(directory);
    expect(store).toBeUndefined();
    expect(await listSavedRuns(store)).toEqual({ runs: [], total: 0, ignoredEntries: 0, hiddenRuns: 0 });
    expect(await inspectSavedRun(store, randomUUID())).toMatchObject({ kind: 'unavailable', code: 'not_found' });
    expect(await readdir(parent)).toEqual([]);
  });

  it('preserves storage bytes, permissions, ownership, and repository contents', async () => {
    const context = await fixture();
    await evaluate(context);
    await stop(context);
    // Inspection must not silently repair directory permissions.
    if (process.platform !== 'win32') await chmod(context.store.directory, 0o750);
    const before = await fileSnapshot(context.parent);
    const store = await SavedRunStore.openForInspection(context.store.directory);
    const detail = await inspectSavedRun(store, context.id);
    const listing = await listSavedRuns(store);
    expect(detail).toMatchObject({ kind: 'valid', blockers: [], iterationsUsed: 1, iterationsRemaining: 7 });
    expect(listing.runs).toHaveLength(1);
    expect(await fileSnapshot(context.parent)).toEqual(before);
  });

  it('reports charged calls, workflow coverage, stale passes, and clarification requirements', async () => {
    const context = await fixture({ worker: 'codex', task: 'Fix the tests.' });
    await evaluate(context);
    await context.store.append(context.id, { type: 'action_approved', iteration: 1, action: 'CALL_CODEX', decision: 'approve' }, context.state);
    const state: AgentState = {
      ...context.state, codexCalls: 1,
      evidence: {
        revision: 2, validationGeneration: 2, findings: [],
        clarifications: [{ iteration: 1, text: 'Also run pnpm lint.' }],
        failures: [{ iteration: 1, action: 'CALL_CODEX', summary: 'Worker timed out after partial edits.' }],
        validations: [
          { iteration: 1, generation: 1, script: 'lint', exitCode: 0, passed: true, timedOut: false, summary: 'Old pass.' },
          { iteration: 1, generation: 2, script: 'verify', exitCode: 0, passed: true, timedOut: false, summary: 'Passed workflow.' },
          { iteration: 1, generation: 2, script: 'build', exitCode: 1, passed: false, timedOut: false, summary: 'Build failed.' },
        ],
      },
    };
    const attemptId = randomUUID();
    await context.store.append(context.id, { type: 'execution_reserved', iteration: 1, action: 'CALL_CODEX', attemptId }, state);
    await context.store.append(context.id, { type: 'execution_outcome', attemptId, outcome: 'failed' }, state);
    await stop(context, state);
    const detail = await inspectSavedRun(context.store, context.id);
    expect(detail).toMatchObject({
      kind: 'valid', iterationsUsed: 1, iterationsRemaining: 7,
      checks: [
        { script: 'check', status: 'passed' }, { script: 'test', status: 'passed' },
        { script: 'build', status: 'failed' }, { script: 'lint', status: 'pending' },
      ],
      lastFailure: 'Iteration 1: CALL_CODEX failed. Worker timed out after partial edits.',
    });
    const lines = formatSavedRunLines(detail).join('\n');
    expect(lines).toContain('Codex calls: 1/2 used; 1 available');
    expect(lines).toContain('Claude calls: 0/2 used; 0 available (worker excluded)');
    expect(lines).toContain('build (failed), lint (pending)');
    expect(lines).toContain('earlier passes cannot approve completion after restart');
  });

  it('retains the explicit recovery requirement and evaluation diagnostics after a clean stop', async () => {
    const context = await fixture();
    await context.store.append(context.id, { type: 'iteration_reserved', iteration: 1 }, context.state);
    await context.store.append(context.id, {
      type: 'evaluation_failed', iteration: 1, code: 'invalid_response', stage: 'distribution', category: 'sum',
    }, context.state);
    await context.store.append(context.id, { type: 'run_stopped', reason: 'evaluation_failure', resumable: true }, context.state);
    expect(await inspectSavedRun(context.store, context.id)).toMatchObject({
      kind: 'valid', recoveryRequired: true, iterationsRemaining: 7,
      lastFailure: 'Iteration 1: invalid_response at distribution/sum.',
      lastStop: 'evaluation_failure; clean continuation point recorded',
    });
  });

  it.each(['codex', 'claude'] as const)('keeps an unresolved %s attempt charged and explains the missing clean stop', async (worker) => {
    const context = await fixture({ worker });
    await evaluate(context);
    const action = worker === 'codex' ? 'CALL_CODEX' : 'CALL_CLAUDE';
    await context.store.append(context.id, { type: 'action_approved', iteration: 1, action, decision: 'approve' }, context.state);
    const state = { ...context.state, ...(worker === 'codex' ? { codexCalls: 1 } : { claudeCalls: 1 }) };
    await context.store.append(context.id, { type: 'execution_reserved', iteration: 1, action, attemptId: randomUUID() }, state);
    const detail = await inspectSavedRun(context.store, context.id);
    expect(detail).toMatchObject({ kind: 'valid', iterationsUsed: 1, iterationsRemaining: 7 });
    const output = formatSavedRunLines(detail).join('\n');
    expect(output).toContain('No durable clean stop');
    expect(output).toContain('1 reserved execution attempt(s) have no outcome');
    expect(output).toContain(`${worker === 'codex' ? 'Codex' : 'Claude'} calls: 1/2 used; 1 available`);
  });

  it('distinguishes an uncertain execution outcome from a resumable stop', async () => {
    const context = await fixture();
    await evaluate(context);
    await context.store.append(context.id, { type: 'action_approved', iteration: 1, action: 'RUN_COMMAND', decision: 'approve' }, context.state);
    const attemptId = randomUUID();
    await context.store.append(context.id, { type: 'execution_reserved', iteration: 1, action: 'RUN_COMMAND', attemptId }, context.state);
    await context.store.append(context.id, { type: 'execution_outcome', attemptId, outcome: 'uncertain' }, context.state);
    expect(formatSavedRunLines(await inspectSavedRun(context.store, context.id)).join('\n')).toContain('An execution outcome is uncertain');
  });

  it('reports finished and exhausted records as inspection only without extending their limits', async () => {
    const exhausted = await fixture({ limit: 1 });
    await evaluate(exhausted);
    await exhausted.store.append(exhausted.id, { type: 'iteration_limit' }, exhausted.state);
    expect(formatSavedRunLines(await inspectSavedRun(exhausted.store, exhausted.id)).join('\n')).toContain('original iteration budget is exhausted');
    const finished = await fixture();
    const state = {
      ...finished.state, tests: { ran: true, passed: true },
      repo: { ...finished.state.repo, validationScripts: ['test'], requiredValidationScripts: ['test'] },
      evidence: {
        revision: 0, validationGeneration: 0, findings: [], clarifications: [], failures: [],
        validations: [{ iteration: 1, generation: 0, script: 'test', exitCode: 0, passed: true, timedOut: false, summary: 'Passed.' }],
      },
    };
    await evaluate(finished, state);
    await finished.store.append(finished.id, { type: 'action_approved', iteration: 1, action: 'FINISH', decision: 'approve' }, state);
    await finished.store.append(finished.id, { type: 'run_finished' }, state);
    expect(formatSavedRunLines(await inspectSavedRun(finished.store, finished.id)).join('\n')).toContain('Task completion was approved; this run is inspection only');
  }, 20_000);

  it('still inspects a saved task when its repository has been removed', async () => {
    const context = await fixture();
    await stop(context);
    await rm(context.root, { recursive: true });
    const detail = await inspectSavedRun(context.store, context.id);
    expect(detail).toMatchObject({ kind: 'valid', repositoryAvailable: false, iterationsUsed: 0, iterationsRemaining: 8 });
    expect(formatSavedRunLines(detail).join('\n')).toContain('repository or Git directory is unavailable');
  });

  it('reports ownership conservatively and never removes locks', async () => {
    const context = await fixture();
    await stop(context);
    const run = await context.store.acquireRunOwnership(context.id);
    const worktree = await context.store.acquireWorktreeOwnership(context.root);
    const before = await fileSnapshot(context.store.directory);
    const detail = await inspectSavedRun(context.store, context.id);
    const output = formatSavedRunLines(detail).join('\n');
    expect(output).toContain('run ownership lock is present');
    expect(output).toContain('worktree ownership lock is present');
    expect(await fileSnapshot(context.store.directory)).toEqual(before);
    await run.release(); await worktree.release();
    const lockPath = path.join(context.store.locksDirectory, `update-${context.id}.lock`);
    await writeFile(lockPath, 'unresolved owner');
    expect(await inspectSavedRun(context.store, context.id)).toMatchObject({ kind: 'unavailable', code: 'busy' });
    expect(await readFile(lockPath, 'utf8')).toBe('unresolved owner');
  });

  it.each(['unsupported', 'altered', 'malformed', 'partial'] as const)('isolates an %s record and never displays unverified checkpoint text', async (failure) => {
    const context = await fixture();
    const good = await context.store.create(context.input);
    const file = path.join(context.store.runsDirectory, context.id, 'checkpoint.json');
    const checkpoint = JSON.parse(await readFile(file, 'utf8'));
    checkpoint.state.task = 'unverified-password-body';
    if (failure === 'unsupported') checkpoint.schemaVersion = 99;
    if (failure === 'partial') await writeFile(path.join(context.store.runsDirectory, context.id, 'events.jsonl'), 'partial event');
    else await writeFile(file, failure === 'malformed' ? '{"untrusted":"unverified-password-body"' : JSON.stringify(checkpoint));
    const listing = await listSavedRuns(context.store);
    expect(listing.runs[0]).toMatchObject({ kind: 'unavailable', runId: context.id });
    expect(listing.runs[1]).toMatchObject({ kind: 'valid', checkpoint: { runId: good.runId } });
    expect(listing.runs.map((run) => formatSavedRunLines(run).join('\n')).join('\n')).not.toContain('unverified-password-body');
  });

  it('bounds listings and can inspect a known ID omitted from the list', async () => {
    const context = await fixture();
    vi.useFakeTimers();
    for (let index = 0; index < SAVED_RUN_LIST_LIMIT; index += 1) {
      vi.setSystemTime(new Date(Date.now() + 1_000));
      await context.store.create(context.input);
    }
    const listing = await listSavedRuns(context.store);
    expect(listing).toMatchObject({ total: 21, hiddenRuns: 1 });
    expect(listing.runs).toHaveLength(SAVED_RUN_LIST_LIMIT);
    expect(listing.runs.some((run) => run.kind === 'valid' && run.checkpoint.runId === context.id)).toBe(false);
    expect(await inspectSavedRun(context.store, context.id)).toMatchObject({ kind: 'valid', checkpoint: { runId: context.id } });
  }, 20_000);

  it('bounds directory scanning and retains direct inspection for a known ID', async () => {
    const context = await fixture();
    for (let index = 0; index < SAVED_RUN_COUNT_LIMIT; index += 1) {
      await mkdir(path.join(context.store.runsDirectory, `unrecognized-${index}`));
    }
    await expect(listSavedRuns(context.store)).rejects.toMatchObject({ code: 'limit_reached' });
    expect(await inspectSavedRun(context.store, context.id)).toMatchObject({ kind: 'valid' });
  });

  it('counts unrecognized entries without displaying their names', async () => {
    const context = await fixture();
    await writeFile(path.join(context.store.runsDirectory, 'password=do-not-display'), 'ignored');
    expect(await listSavedRuns(context.store)).toMatchObject({ ignoredEntries: 1, total: 1 });
  });

  it('rejects hard-linked checkpoint files during inspection', async () => {
    const context = await fixture();
    await link(path.join(context.store.runsDirectory, context.id, 'checkpoint.json'), path.join(context.parent, 'copy'));
    expect(await inspectSavedRun(context.store, context.id)).toMatchObject({ kind: 'unavailable', code: 'limit_reached' });
  });

  it.skipIf(process.platform === 'win32')('rejects symlinked store, run, and checkpoint paths', async () => {
    const context = await fixture();
    const alias = path.join(context.parent, 'alias');
    await symlink(context.store.directory, alias);
    await expect(SavedRunStore.openForInspection(alias)).rejects.toMatchObject({ code: 'storage_failure' });
    const id = randomUUID();
    await symlink(path.join(context.store.runsDirectory, context.id), path.join(context.store.runsDirectory, id));
    expect(await inspectSavedRun(context.store, id)).toMatchObject({ kind: 'unavailable', code: 'invalid_record' });
    const file = path.join(context.store.runsDirectory, context.id, 'checkpoint.json');
    await rm(file);
    await symlink(path.join(context.parent, 'outside'), file);
    expect(await inspectSavedRun(context.store, context.id)).toMatchObject({ kind: 'unavailable', code: 'invalid_record' });
  });

  it.each([false, true])('sanitizes saved text in plain and styled output (plain=%s)', async (plain) => {
    vi.stubEnv('TYPESAFE_API_KEY', 'fixture-display-secret');
    const context = await fixture({ task: 'Fix\u001b[2J\u001b]8;;https://untrusted.invalid\u0007link\u001b]8;;\u0007\r\u202e fixture-display-secret' });
    const detail = await inspectSavedRun(context.store, context.id);
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 });
    let printed = '';
    output.on('data', (value: Buffer) => { printed += value.toString(); });
    const view = await createPresentation({ input, output, environment: {}, plain });
    view.section('Saved run', formatSavedRunLines(detail));
    view.dispose();
    const readable = stripVTControlCharacters(printed);
    expect(readable).toContain('Fixlink \\u202e [REDACTED]');
    expect(readable).not.toContain('fixture-display-secret');
    expect(printed).not.toContain('\u001b[2J');
    expect(printed).not.toContain('https://untrusted.invalid');
    if (plain) expect(printed).not.toContain('\u001b');
  });
});

describe('CLI local inspection boundaries', () => {
  it('lists and shows runs without credential preflight, evaluation, tools, tracing, or filesystem writes', async () => {
    const context = await fixture();
    await stop(context);
    const open = SavedRunStore.openForInspection.bind(SavedRunStore);
    vi.spyOn(SavedRunStore, 'openForInspection').mockImplementation(() => open(context.store.directory));
    const forbidden = [
      vi.spyOn(config, 'resolveEvaluationConfiguration'), vi.spyOn(evaluation, 'createEvaluator'),
      vi.spyOn(execution, 'executeCandidate'), vi.spyOn(inspection, 'inspectRepo'),
      vi.spyOn(inspection, 'inspectGitIdentity'), vi.spyOn(traces, 'writeTrace'),
      vi.spyOn(SavedRunStore.prototype, 'acquireRunOwnership'),
      vi.spyOn(SavedRunStore.prototype, 'acquireWorktreeOwnership'),
    ];
    vi.stubEnv('ROUTER_PROVIDER', 'invalid-for-live');
    vi.stubEnv('TYPESAFE_API_KEY', undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = await fileSnapshot(context.parent);
    await main(['--list-runs', '--plain']);
    await main(['--show-run', context.id, '--plain']);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Showing 1/1 saved runs');
    expect(output).toContain('Task (saved): Fix the example.');
    expect(output).toContain('Recent events');
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    expect(await fileSnapshot(context.parent)).toEqual(before);
    expect(process.exitCode).toBe(originalExitCode);
  });

  it('returns an inspection error for missing or corrupt records while a valid blocked record exits successfully', async () => {
    const context = await fixture();
    const open = SavedRunStore.openForInspection.bind(SavedRunStore);
    vi.spyOn(SavedRunStore, 'openForInspection').mockImplementation(() => open(context.store.directory));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--show-run', context.id]);
    expect(process.exitCode).toBe(originalExitCode);
    await main(['--show-run', randomUUID()]);
    expect(process.exitCode).toBe(1);
    process.exitCode = originalExitCode;
    await writeFile(path.join(context.store.runsDirectory, context.id, 'checkpoint.json'), 'invalid');
    await main(['--list-runs']);
    expect(process.exitCode).toBe(1);
    expect(log.mock.calls.flat().join('\n')).toContain('Status: unavailable (invalid_record)');
  });
});
