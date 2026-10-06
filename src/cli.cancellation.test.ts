import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInterface } from 'node:readline/promises';
import * as inspection from './repo/inspect.js';
import * as evaluation from './ai/evaluate.js';
import { JevEvaluationError } from './ai/errors.js';
import { mockEvaluation } from './mock.js';
import { formatRunSummary, main, runCliOrchestration, runDecision, type CliOptions } from './cli.js';

vi.mock('node:readline/promises', () => ({ createInterface: vi.fn() }));

class Terminal extends EventEmitter {
  close = vi.fn();
  onQuestion: () => void = () => {};
  question = vi.fn(async (_prompt: string, options?: { signal?: AbortSignal }): Promise<string> => {
    this.onQuestion();
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
    });
  });
}

const roots: string[] = [];
let terminal: Terminal;
const originalExitCode = process.exitCode;
beforeEach(() => {
  terminal = new Terminal();
  vi.mocked(createInterface).mockReturnValue(terminal as unknown as ReturnType<typeof createInterface>);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function options(): Promise<CliOptions> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-cli-stop-'));
  roots.push(root);
  await writeFile(path.join(root, 'README.md'), 'fixture');
  return { repoPath: root, task: 'Inspect fixture', mock: true, json: false, noTrace: false, orchestrate: true };
}

describe('CLI interruption lifecycle', () => {
  it('includes initial inspection and prints the stopped-run performance summary', async () => {
    const opts = await options();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const inspect = inspection.inspectRepo;
    vi.spyOn(inspection, 'inspectRepo').mockImplementationOnce(async (root) => {
      now += 125;
      return inspect(root);
    });
    terminal.question.mockImplementationOnce(async () => { now += 1_000; return 'stop'; });
    await main([opts.repoPath, opts.task, '--mock', '--orchestrate']);
    const output = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(output).toContain('Elapsed: 1.13s; active: 0.13s');
    expect(output).toContain('Inspection: 0.13s');
    expect(output).toContain('Approval wait: 1.00s');
    expect(output).toContain('Worker calls: Codex 0, Claude 0; retries: 0');
    expect(output).toContain('Independent checks (generation 0): incomplete. No required checks detected.');
  });

  it('redacts required script names in both the human summary and terminal trace', async () => {
    const opts = await options();
    vi.stubEnv('TYPESAFE_API_KEY', 'test-secret-value');
    await writeFile(path.join(opts.repoPath, 'package.json'), JSON.stringify({ scripts: { 'test:test-secret-value': 'fixture' } }));
    terminal.question.mockResolvedValueOnce('stop');
    const outcome = await runCliOrchestration(opts);
    const summary = formatRunSummary(outcome.summary);
    expect(summary).toContain('test:[REDACTED]: pending');
    expect(summary).not.toContain('test-secret-value');
    const trace = await readFile(outcome.tracePath, 'utf8');
    expect(trace).not.toContain('test-secret-value');
    expect(JSON.parse(trace.trim()).summary.validation.checks).toEqual([{ script: 'test:[REDACTED]', status: 'pending' }]);
  });

  it('retains and reports the network opt-in through both CLI modes', async () => {
    const opts = { ...await options(), workerSelection: 'codex' as const, codexNetworkAccess: true as const };
    expect(await runDecision({ ...opts, noTrace: true })).toMatchObject({ codexNetworkAccess: true });
    terminal.question.mockResolvedValueOnce('stop');
    const result = await runCliOrchestration(opts);
    expect(result.state).toMatchObject({ codexNetworkAccess: true, codexCalls: 0 });
    const record = JSON.parse((await readFile(result.tracePath, 'utf8')).trim());
    expect(record).toMatchObject({ stateBefore: { codexNetworkAccess: true }, stateAfter: { codexNetworkAccess: true }, toolResult: null });
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('Codex command network: enabled');
  });
  it.each(['codex', 'claude'] as const)('wires the %s selection into both CLI modes and rejects the other alias', async (workerSelection) => {
    const opts = { ...await options(), workerSelection };
    const decision = await runDecision({ ...opts, noTrace: true });
    expect(decision).toMatchObject({ status: 'unexecuted', mode: 'mock', workerSelection });
    terminal.question.mockResolvedValueOnce(workerSelection === 'codex' ? 'CLAUDE' : 'CODEX').mockResolvedValueOnce('stop');
    const result = await runCliOrchestration(opts);
    expect(result).toMatchObject({ status: 'stopped', state: { workerSelection, codexCalls: 0, claudeCalls: 0 } });
    expect(terminal.question).toHaveBeenCalledTimes(2);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain(`Worker selection: ${workerSelection}`);
    const record = JSON.parse((await readFile(result.tracePath, 'utf8')).trim());
    expect(record).toMatchObject({ stateBefore: { workerSelection }, stateAfter: { workerSelection }, approval: { kind: 'stop' }, toolResult: null });
  });

  it.each(['SIGINT', 'SIGTERM', 'readline'] as const)('handles %s once and restores signal listeners', async (signal) => {
    const opts = await options();
    const intCount = process.listenerCount('SIGINT');
    const termCount = process.listenerCount('SIGTERM');
    terminal.onQuestion = () => {
      if (signal === 'readline') terminal.emit('SIGINT');
      else process.emit(signal);
      process.emit('SIGINT');
      process.emit('SIGTERM');
    };
    const result = await runCliOrchestration(opts);
    expect(result).toMatchObject({ status: 'stopped', exitCode: signal === 'SIGTERM' ? 143 : 130 });
    const entries = (await readFile(result.tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ approval: null, toolInput: null, toolResult: null, interruption: { phase: 'approval' } });
    expect(terminal.close).toHaveBeenCalledTimes(1);
    expect(terminal.listenerCount('SIGINT')).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(intCount);
    expect(process.listenerCount('SIGTERM')).toBe(termCount);
  });

  it('sets the conventional signal exit code from main', async () => {
    const opts = await options();
    terminal.onQuestion = () => { process.emit('SIGTERM'); };
    await main([opts.repoPath, opts.task, '--mock', '--orchestrate']);
    expect(process.exitCode).toBe(143);
  });

  it('keeps typed stop as a normal stopped run', async () => {
    const opts = await options();
    terminal.question.mockResolvedValueOnce('quit');
    const result = await runCliOrchestration(opts);
    expect(result.status).toBe('stopped');
    expect(result.exitCode).toBeUndefined();
    const entry = JSON.parse((await readFile(result.tracePath, 'utf8')).trim());
    expect(entry.approval.kind).toBe('stop');
    expect(entry).not.toHaveProperty('interruption');
  });

  it('returns exit 1 for exhausted iterations and restores signal listeners', async () => {
    const opts = await options();
    terminal.question.mockResolvedValue('reject');
    const listeners = process.listenerCount('SIGTERM');
    const outcome = await runCliOrchestration(opts);
    expect(outcome).toMatchObject({ status: 'iteration_limit', iterations: 8, exitCode: 1 });
    expect(terminal.question).toHaveBeenCalledTimes(8);
    expect(terminal.close).toHaveBeenCalledOnce();
    expect(process.listenerCount('SIGTERM')).toBe(listeners);
    const entries = (await readFile(outcome.tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(entries).toHaveLength(8);
    expect(entries.every((entry) => entry.toolResult === null)).toBe(true);
    expect(entries[7].stateAfter.currentGoal).not.toBe('Task complete.');
  });

  it('sets the incomplete-run exit code from main and explains the outcome', async () => {
    const opts = await options();
    terminal.question.mockResolvedValue('reject');
    await main([opts.repoPath, opts.task, '--mock', '--orchestrate']);
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('Task completion was not approved before the iteration limit');
  });

  it('drains initial read-only inspection and records interruption without entering evaluation', async () => {
    const opts = await options();
    const inspect = inspection.inspectRepo;
    vi.spyOn(inspection, 'inspectRepo').mockImplementationOnce(async (root) => {
      process.emit('SIGINT');
      return inspect(root);
    });
    const result = await runCliOrchestration(opts);
    expect(result).toMatchObject({ status: 'stopped', iterations: 0, exitCode: 130 });
    expect(terminal.question).not.toHaveBeenCalled();
    const entry = JSON.parse((await readFile(result.tracePath, 'utf8')).trim());
    expect(entry).toMatchObject({ evaluation: null, policy: null, approval: null, interruption: { phase: 'inspection' } });
  });

  it('restores process listeners when inspection fails', async () => {
    const opts = await options();
    const intCount = process.listenerCount('SIGINT');
    const termCount = process.listenerCount('SIGTERM');
    vi.spyOn(inspection, 'inspectRepo').mockRejectedValueOnce(new Error('inspection failed'));
    await expect(runCliOrchestration(opts)).rejects.toThrow('inspection failed');
    expect(process.listenerCount('SIGINT')).toBe(intCount);
    expect(process.listenerCount('SIGTERM')).toBe(termCount);
  });

  it('requires explicit continuation and reviews a new proposal after evaluation rejection', async () => {
    const opts = await options();
    opts.mock = false;
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    vi.stubEnv('JEV_PROVIDER', 'typesafe');
    const evaluate = vi.spyOn(evaluation, 'evaluateAgentState')
      .mockRejectedValueOnce(new JevEvaluationError('invalid_response', 'raw upstream body', { stage: 'distribution', category: 'sum', probabilitySum: 0.99 }))
      .mockResolvedValueOnce(mockEvaluation());
    terminal.question.mockResolvedValueOnce('approve').mockResolvedValueOnce('continue').mockResolvedValueOnce('stop');
    const outcome = await runCliOrchestration(opts);
    expect(outcome).toMatchObject({ status: 'stopped', iterations: 2 });
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(terminal.question).toHaveBeenCalledTimes(3);
    expect(terminal.question.mock.calls[0]?.[0]).toContain('continue');
    expect(terminal.question.mock.calls[2]?.[0]).toContain('approve, reject, stop');
    const output = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(output).not.toContain('raw upstream');
    expect(output).toContain('probability sum 0.99, expected 1 (tolerance 0.001)');
    expect(output).toContain('Continue requests a fresh evaluation within the remaining budget');
    const entries = (await readFile(outcome.tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(entries[0]).toMatchObject({ failure: { code: 'invalid_response', stage: 'distribution', category: 'sum', probabilitySum: 0.99 }, approval: null });
    expect(entries[1]).toMatchObject({ recovery: { decision: 'continue' } });
    expect(entries[2]).toMatchObject({ approval: { kind: 'stop' }, toolResult: null });
  });

  it('returns exit 1 and restores listeners when evaluation recovery is stopped', async () => {
    const opts = await options();
    opts.mock = false;
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    vi.stubEnv('JEV_PROVIDER', 'typesafe');
    vi.spyOn(evaluation, 'evaluateAgentState').mockRejectedValueOnce(new JevEvaluationError('invalid_response', 'invalid'));
    terminal.question.mockResolvedValueOnce('stop');
    const listeners = process.listenerCount('SIGINT');
    const outcome = await runCliOrchestration(opts);
    expect(outcome).toMatchObject({ status: 'evaluation_failed', iterations: 1, exitCode: 1 });
    expect(terminal.close).toHaveBeenCalledOnce();
    expect(process.listenerCount('SIGINT')).toBe(listeners);
  });

  it('cleans up CLI signal listeners after interruption during recovery', async () => {
    const opts = await options();
    opts.mock = false;
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    vi.stubEnv('JEV_PROVIDER', 'typesafe');
    const evaluate = vi.spyOn(evaluation, 'evaluateAgentState').mockRejectedValue(new JevEvaluationError('invalid_response', 'invalid'));
    const listeners = process.listenerCount('SIGTERM');
    terminal.onQuestion = () => { process.emit('SIGTERM'); };
    const outcome = await runCliOrchestration(opts);
    expect(outcome).toMatchObject({ status: 'stopped', exitCode: 143 });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(process.listenerCount('SIGTERM')).toBe(listeners);
    expect(terminal.listenerCount('SIGINT')).toBe(0);
    const entries = (await readFile(outcome.tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(entries.at(-1)).toMatchObject({ interruption: { phase: 'recovery' } });
  });
});
