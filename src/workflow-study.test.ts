import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/workflows/study.mjs', import.meta.url));
const roots: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function command(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, args[0]!, root, ...args.slice(1)], { encoding: 'utf8', timeout: 15_000 });
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dev-study-offline-'));
  roots.push(root);
  for (const folder of ['repos', 'observations', 'fake-package']) await mkdir(path.join(root, folder));
  const source = "console.log('offline fixture CLI; no providers or workers');\n";
  const entrypoint = path.join(root, 'fake-package', 'cli.mjs');
  const archive = path.join(root, 'fake-archive.txt');
  await writeFile(entrypoint, source);
  await writeFile(archive, 'offline archive fixture');
  const packed = { archive, sha256: hash('offline archive fixture'), entrypoint,
    entrypointSha256: hash(source), installedRoot: path.dirname(entrypoint), installedFiles: { 'cli.mjs': hash(source) } };
  await writeFile(path.join(root, 'inputs.json'), JSON.stringify({ fixtureDate: '2026-10-19T00:10:00Z',
    instrumentSha256: hash(await readFile(script, 'utf8')), packages: { baseline: packed, candidate: packed } }));
  expect(command(root, 'prepare').status).toBe(0);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('offline guards around the opt-in live workflow study', { timeout: 15_000 }, () => {
  it('freezes identical paired tasks without cohort labels in repository data and requires live opt-in', async () => {
    const root = await fixture();
    const protocol = JSON.parse(await readFile(path.join(root, 'protocol.json'), 'utf8'));
    expect(protocol.budget.runs).toBe(8);
    expect(protocol.runs[0].revision).toBe(protocol.runs[1].revision);
    expect(protocol.runs[4].revision).toBe(protocol.runs[5].revision);
    expect(await readFile(path.join(root, 'repos/r01/package.json'), 'utf8')).not.toMatch(/baseline|candidate|typesafe|openrouter/u);
    expect(command(root, 'run', 'r01').status).toBe(1);
    expect(command(root, 'run', 'r02', '--live').status).toBe(1);
    expect(command(root, 'report').stdout).not.toContain('"exitCode": 0');
  });

  it('retains a started observation and refuses replacement even when the fake CLI produced no trace', async () => {
    const root = await fixture();
    expect(command(root, 'run', 'r01', '--live').status).toBe(0);
    const file = path.join(root, 'observations/r01-process.json');
    const original = await readFile(file, 'utf8');
    expect(command(root, 'run', 'r01', '--live').status).toBe(1);
    expect(await readFile(file, 'utf8')).toBe(original);
    const report = JSON.parse(command(root, 'report').stdout);
    expect(report[0]).toMatchObject({ exitCode: 0, completedLoop: false, acceptedPatch: null, counts: null });
  });

  it('refuses a changed frozen package before invoking the fake CLI', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'fake-package/cli.mjs'), "throw new Error('must not run');\n");
    expect(command(root, 'run', 'r01', '--live').status).toBe(1);
    expect(command(root, 'report').stdout).not.toContain('"exitCode": 0');
  });

  it('keeps passing acceptance examples separate from stale independent validation and changed source', async () => {
    const root = await fixture();
    const repo = path.join(root, 'repos/r01');
    await writeFile(path.join(repo, 'tags.mjs'), "export const tags = (value) => [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean))];\n");
    await writeFile(path.join(repo, 'tags.test.mjs'), "import './tags.mjs';\n");
    await mkdir(path.join(repo, 'traces'));
    await writeFile(path.join(repo, 'traces/run.jsonl'), JSON.stringify({
      stateAfter: { tests: { passed: true }, evidence: { validationGeneration: 1,
        validations: ['test', 'lint'].map((scriptName) => ({ script: scriptName, generation: 0, iteration: 1, passed: true, exitCode: 0, timedOut: false })) } },
      summary: { validation: { passed: true } },
    }) + '\n');
    const inspection = JSON.parse(command(root, 'inspect', 'r01').stdout);
    expect(inspection).toMatchObject({ oraclePassed: true, independentlyPassed: false, acceptedPatch: false });
    expect(JSON.parse(command(root, 'report').stdout)[0].acceptedPatch).toBe(false);
    await writeFile(path.join(repo, 'tags.mjs'), "export const tags = (value) => value.split(',');\n");
    expect(JSON.parse(command(root, 'report').stdout)[0].acceptedPatch).toBe(false);
  });
});
