import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInterface } from 'node:readline/promises';
import * as inspection from './repo/inspect.js';
import { main, runCliOrchestration, type CliOptions } from './cli.js';

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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function options(): Promise<CliOptions> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-cli-stop-'));
  roots.push(root);
  await writeFile(path.join(root, 'README.md'), 'fixture');
  return { repoPath: root, task: 'Inspect fixture', mock: true, json: false, noTrace: false, orchestrate: true };
}

describe('CLI interruption lifecycle', () => {
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
});
