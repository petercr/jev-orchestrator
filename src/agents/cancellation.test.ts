import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCodexAdapter } from './codex.js';
import { createClaudeAdapter } from './claude.js';
import type { ProcessRunner } from '../process.js';
import { executeCandidate } from '../orchestration/execute.js';
import { selectCandidate } from '../orchestration/candidate.js';
import { createInitialState } from '../orchestration/loop.js';
import { inspectRepo } from '../repo/inspect.js';

describe.each([
  ['codex', createCodexAdapter],
  ['claude', createClaudeAdapter],
] as const)('%s adapter cancellation', (agent, createAdapter) => {
  it('passes cancellation separately and normalizes a cancelled zero exit as unsuccessful', async () => {
    const controller = new AbortController();
    const runner: ProcessRunner = vi.fn(async (_request, options) => {
      expect(options?.signal).toBe(controller.signal);
      return { exitCode: 0, stdout: 'partial output', stderr: '', timedOut: false, cancelled: true };
    });
    expect(await createAdapter(runner)({ root: '/repo', task: 'Implement fixture' }, { signal: controller.signal }))
      .toMatchObject({ agent, ok: false, cancelled: true, timedOut: false, exitCode: 0 });
  });

  it('never invokes its runner when pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = vi.fn();
    await expect(createAdapter(runner)({ root: '/repo', task: 'Implement fixture' }, { signal: controller.signal })).rejects.toThrow('Run interrupted.');
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects malformed cancellation fields', async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: 'bad' })) as unknown as ProcessRunner;
    await expect(createAdapter(runner)({ root: '/repo', task: 'Implement fixture' })).rejects.toThrow('malformed');
  });
});

it('propagates cancellation to validation without accepting a successful exit', async () => {
  const controller = new AbortController();
  const runner = vi.fn<ProcessRunner>(async () => ({ exitCode: 0, stdout: 'partial', stderr: '', timedOut: false, cancelled: true }));
  const root = await mkdtemp(path.join(os.tmpdir(), 'validation-cancellation-'));
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    await writeFile(path.join(root, 'pnpm-lock.yaml'), '');
    const proposal = await selectCandidate('RUN_TESTS', createInitialState(await inspectRepo(root), 'Fix the fixture'));
    const result = await executeCandidate(proposal, runner, { signal: controller.signal });
    expect(runner.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
    expect(result).toMatchObject({ cancelled: true, ok: false, timedOut: false });
    expect(result).not.toHaveProperty('coveredScripts');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
