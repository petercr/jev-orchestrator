import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openSavedRunStore } from './store.js';

const roots: string[] = [];
const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));
const tsx = new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
const choose = 'Choose approve, reject, stop, or an allowed action name: ';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function invoke(args: string[], cwd: string, environment: NodeJS.ProcessEnv,
  steps: Array<{ prompt: string; answer: string }>): Promise<{ code: number | null; output: string; error: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsx, cli, ...args], {
      cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    let output = '';
    let error = '';
    let cursor = 0;
    let index = 0;
    const timer = setTimeout(() => {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    }, 25_000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const step = steps[index];
      if (!step) return;
      const position = output.indexOf(step.prompt, cursor);
      if (position >= 0) {
        cursor = position + step.prompt.length;
        index += 1;
        child.stdin.write(`${step.answer}\n`);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString(); });
    child.on('error', (failure) => { clearTimeout(timer); reject(failure); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (index !== steps.length) reject(new Error(`Fixture prompts incomplete (${index}/${steps.length}): ${output}\n${error}`));
      else resolve({ code, output, error });
    });
  });
}

// The subprocess store is isolated through XDG_STATE_HOME. Native platform
// storage and terminal verification is completed in the next milestone.
describe.skipIf(process.platform !== 'linux')('two-process saved task continuation', () => {
  it.each(['codex', 'claude'] as const)('preserves the %s patch and charged call, then independently validates and accepts', async (worker) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'dev-restart-'));
    roots.push(parent);
    const root = path.join(parent, 'project');
    const bin = path.join(parent, 'bin');
    await Promise.all([mkdir(root), mkdir(bin)]);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node verify.mjs' } }));
    await writeFile(path.join(root, 'package-lock.json'), '{}');
    await writeFile(path.join(root, 'AGENTS.md'), 'Read the task and validate with npm test.');
    await writeFile(path.join(root, 'value.txt'), 'original');
    await writeFile(path.join(root, 'verify.mjs'), `import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
assert.equal(readFileSync('value.txt', 'utf8'), 'patched');
writeFileSync('validation-count', '1');
`);
    // Both adapter names resolve to a known local process fixture. No coding
    // agent or live evaluation is launched by these integration tests.
    await writeFile(path.join(bin, worker), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync('value.txt', 'patched');
fs.writeFileSync('worker-args.json', JSON.stringify(process.argv.slice(2)));
fs.writeFileSync('worker-count', '1');
console.log('Fixture patch ready; independent validation was not run by this worker.');
`, { mode: 0o755 });
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: root });
    const environment = {
      ...process.env, XDG_STATE_HOME: path.join(parent, 'state'), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      NO_COLOR: '1', ROUTER_PROVIDER: 'deliberately-invalid-for-live',
      npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
    };
    const first = await invoke([root, 'Patch value.txt', '--orchestrate', '--save-run', '--mock', '--worker', worker,
      ...(worker === 'codex' ? ['--plain'] : [])], parent, environment, [
      { prompt: choose, answer: worker }, { prompt: choose, answer: 'approve' }, { prompt: choose, answer: 'stop' },
    ]);
    expect(first.code, first.error + first.output).toBe(0);
    const runId = first.output.match(/Saved run: ([a-f0-9-]{36}) \(stopped\)/u)?.[1];
    expect(runId).toBeDefined();
    const store = await openSavedRunStore(path.join(parent, 'state', 'dev-orchestrator', 'saved-runs'));
    const stopped = await store.read(runId!);
    expect(stopped.checkpoint.state[worker === 'codex' ? 'codexCalls' : 'claudeCalls']).toBe(1);
    expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe('patched');
    expect(await readdir(root)).not.toContain('validation-count');
    const declined = await invoke(['--resume', runId!, '--plain'], parent, environment, [
      { prompt: 'Enter continue to resume', answer: 'stop' },
    ]);
    expect(declined.code, declined.error).toBe(0);
    expect((await store.read(runId!)).checkpoint.sequence).toBe(stopped.checkpoint.sequence);
    const resumed = await invoke(['--resume', runId!, '--plain'], parent, environment, [
      { prompt: 'Enter continue to resume', answer: 'continue' },
      { prompt: choose, answer: 'approve' }, // freshly read AGENTS.md
      { prompt: choose, answer: 'approve' }, // independent npm test
      { prompt: choose, answer: 'approve' }, // explicit task acceptance
    ]);
    expect(resumed.code, resumed.error + resumed.output).toBe(0);
    expect(resumed.output).toContain('Next iteration: 3/8');
    expect(resumed.output).toContain('Loop status: finished');
    const finished = await store.read(runId!);
    expect(finished.checkpoint).toMatchObject({
      status: 'finished', iterationLimit: 8, configuration: { workerSelection: worker, codexNetworkAccess: false },
      state: { evidence: { validationGeneration: 2 } },
    });
    expect(finished.checkpoint.state[worker === 'codex' ? 'codexCalls' : 'claudeCalls']).toBe(1);
    expect(finished.events.filter((event) => event.type === 'iteration_reserved').map((event) => event.iteration)).toEqual([1, 2, 3, 4, 5]);
    expect(finished.events.filter((event) => event.type === 'execution_reserved' && event.action === (worker === 'codex' ? 'CALL_CODEX' : 'CALL_CLAUDE'))).toHaveLength(1);
    expect(await readFile(path.join(root, 'worker-count'), 'utf8')).toBe('1');
    expect(await readFile(path.join(root, 'validation-count'), 'utf8')).toBe('1');
    const args: string[] = JSON.parse(await readFile(path.join(root, 'worker-args.json'), 'utf8'));
    expect(args).toContain(worker === 'codex' ? 'workspace-write' : '--restricted');
    if (worker === 'codex') expect(args).toContain('sandbox_workspace_write.network_access=false');
    const traces = await readdir(path.join(root, 'traces'));
    expect(traces).toHaveLength(2);
    const records = (await Promise.all(traces.map((file) => readFile(path.join(root, 'traces', file), 'utf8'))))
      .flatMap((text) => text.trim().split('\n').map((line) => JSON.parse(line)));
    expect(records.every((record) => record.savedRunId === runId)).toBe(true);
    expect(new Set(records.map((record) => record.segment))).toEqual(new Set([1, 2]));
    expect(await readdir(store.locksDirectory)).toEqual([]);
  }, 35_000);
});
