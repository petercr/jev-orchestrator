import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FORCE_KILL_GRACE_MS, MAX_PROCESS_OUTPUT_BYTES, runProcess } from './process.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitForFile(file: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { return await readFile(file, 'utf8'); } catch { /* Wait for the child readiness marker. */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Child did not become ready.');
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('process cancellation', () => {
  it('does not spawn when already aborted, even for an invalid executable', async () => {
    const controller = new AbortController();
    controller.abort('credential-like arbitrary reason');
    expect(await runProcess({ command: 'not-a-real-executable', args: [], cwd: os.tmpdir(), timeoutMs: 10 }, {
      signal: controller.signal,
    })).toEqual({ exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: true });
  });

  it('cancels an active child, waits for cleanup, and preserves bounded partial output', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jev-cancel-'));
    roots.push(root);
    const ready = path.join(root, 'ready');
    const controller = new AbortController();
    const started = performance.now();
    const running = runProcess({
      command: process.execPath,
      args: ['-e', `process.stdout.write('partial' + 'x'.repeat(20000), () => process.stderr.write('y'.repeat(20000), () => require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)))); setInterval(() => {}, 1000);`],
      cwd: root,
      timeoutMs: 10_000,
    }, { signal: controller.signal });
    const pid = Number(await waitForFile(ready));
    controller.abort();
    controller.abort();
    const result = await running;
    expect(result).toMatchObject({ cancelled: true, timedOut: false });
    expect(result.stdout).toMatch(/^partial/u);
    expect(Buffer.byteLength(result.stdout)).toBe(MAX_PROCESS_OUTPUT_BYTES);
    expect(Buffer.byteLength(result.stderr)).toBe(MAX_PROCESS_OUTPUT_BYTES);
    expect(performance.now() - started).toBeGreaterThanOrEqual(FORCE_KILL_GRACE_MS);
    expect(alive(pid)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('kills a TERM-resistant descendant after its parent exits and closes pipes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jev-group-'));
    roots.push(root);
    const ready = path.join(root, 'descendant');
    const controller = new AbortController();
    const descendant = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'ignore'}); setInterval(() => {}, 1000);`;
    const running = runProcess({ command: process.execPath, args: ['-e', parent], cwd: root, timeoutMs: 10_000 }, { signal: controller.signal });
    const pid = Number(await waitForFile(ready));
    try {
      controller.abort();
      expect(await running).toMatchObject({ cancelled: true, timedOut: false });
      // An orphan zombie can await host reaping, but must no longer execute.
      if (process.platform === 'linux' && alive(pid)) {
        try {
          const status = await readFile(`/proc/${pid}/status`, 'utf8');
          expect(status).toMatch(/State:\s+Z/u);
        } catch (error) {
          // The host can reap the zombie between kill-zero and the proc read.
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ESRCH') throw error;
          expect(alive(pid)).toBe(false);
        }
      } else {
        for (let attempt = 0; attempt < 200 && alive(pid); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(alive(pid)).toBe(false);
      }
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ }
    }
  });

  it('retains the original deadline and distinguishes timeout from cancellation', async () => {
    const started = performance.now();
    const result = await runProcess({ command: process.execPath, args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], cwd: os.tmpdir(), timeoutMs: 200 });
    expect(result).toMatchObject({ timedOut: true });
    expect(result.cancelled).not.toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(200 + FORCE_KILL_GRACE_MS);
  });
});
