import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const temporaryDirectories: string[] = [];
const proxy = path.resolve('scripts/benchmarks/worker-proxy.mjs');

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(command: 'codex' | 'claude', events: unknown[], exitCode = 0) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jev-benchmark-'));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, 'logging'));
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(directory, 'logging/trace.js'), 'export const redactSensitiveText = (text) => text.replaceAll("fixture-secret", "[REDACTED]");');
  const executable = path.join(directory, 'fake-cli.mjs');
  await writeFile(executable, `#!/usr/bin/env node\nfor (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));\nprocess.exitCode = ${exitCode};\n`, { mode: 0o700 });
  const args = command === 'codex'
    ? ['--ask-for-approval', 'never', '--model', 'gpt-5.6-terra', 'exec', '--sandbox', 'workspace-write', '--', 'fixture task']
    : ['-p', '--model', 'sonnet', '--output-format', 'text', '--restricted', '--tools', 'Read,Write,Edit,Glob,Grep', '--', 'fixture task'];
  const outcome = await run(process.execPath, [proxy, command, ...args], {
    env: { ...process.env, BENCH_CASE_DIR: directory, BENCH_PACKAGE_ENTRY: path.join(directory, 'cli.js'), [`BENCH_REAL_${command.toUpperCase()}`]: executable },
  }).then((result) => ({ ...result, exitCode: 0 })).catch((error: { code: number; stdout: string; stderr: string }) => ({ ...error, exitCode: error.code }));
  const metadataFile = (await readdir(directory)).find((name) => name.startsWith(command + '-') && name.endsWith('.json'));
  if (!metadataFile) throw new Error('Missing process receipt.');
  return { directory, outcome, metadata: JSON.parse(await readFile(path.join(directory, metadataFile), 'utf8')) };
}

describe('benchmark worker instrumentation', () => {
  it('preserves Codex permissions and records reported usage while returning its plain summary', async () => {
    const result = await fixture('codex', [
      { type: 'item.completed', item: { type: 'agent_message', text: 'Edited fixture-secret; validation pending.' } },
      { type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 3 } },
    ]);
    expect(result.outcome.exitCode).toBe(0);
    expect(result.outcome.stdout).toBe('Edited [REDACTED]; validation pending.\n');
    expect(result.metadata.args).toContain('--json');
    expect(result.metadata.args).toContain('workspace-write');
    expect(result.metadata.args).toContain('never');
    expect(result.metadata.usage).toEqual({ input_tokens: 12, cached_input_tokens: 4, output_tokens: 3 });
    const events = (await readdir(result.directory)).find((name) => name.endsWith('.events.jsonl'));
    expect(await readFile(path.join(result.directory, events ?? ''), 'utf8')).not.toContain('fixture-secret');
  });

  it('records Claude attribution and actual reported cost with the same restricted tools', async () => {
    const result = await fixture('claude', [
      { type: 'assistant', message: { model: 'claude-sonnet-5-5' } },
      { type: 'result', is_error: false, result: 'Ready for review.', usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.01, num_turns: 3 },
    ]);
    expect(result.outcome.exitCode).toBe(0);
    expect(result.outcome.stdout).toBe('Ready for review.\n');
    expect(result.metadata.servedModels).toEqual(['claude-sonnet-5-5']);
    expect(result.metadata.reportedCostUsd).toBe(0.01);
    expect(result.metadata.args).toContain('--restricted');
    expect(result.metadata.args).toContain('Read,Write,Edit,Glob,Grep');
    expect(result.metadata.args).not.toContain('Bash');
  });

  it('does not treat an incomplete or failed structured turn as a successful worker', async () => {
    const incomplete = await fixture('codex', [{ type: 'turn.failed', error: { message: 'Failure' } }]);
    expect(incomplete.outcome.exitCode).toBe(1);
    expect(incomplete.metadata.completed).toBe(false);
    expect(incomplete.metadata.usage).toBeUndefined();
    const failed = await fixture('claude', [{ type: 'result', is_error: true, result: 'Blocked.' }]);
    expect(failed.outcome.exitCode).toBe(1);
    expect(failed.metadata.reportedFailure).toBe(true);
  });

  it('retains a nonzero child exit status without inventing usage or cost', async () => {
    const result = await fixture('codex', [{ type: 'turn.completed' }], 7);
    expect(result.outcome.exitCode).toBe(7);
    expect(result.metadata.exitCode).toBe(7);
    expect(result.metadata.usage).toBeUndefined();
    expect(result.metadata.reportedCostUsd).toBeUndefined();
  });
});
