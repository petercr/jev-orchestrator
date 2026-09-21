import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, runDecision } from './cli.js';
import { TraceWriteError } from './logging/trace.js';

const roots: string[] = [];

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-cli-integration-'));
  roots.push(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture-repository',
    scripts: {
      test: 'vitest run',
      lint: 'eslint .',
      deploy: 'not-an-allowed-validation-script',
    },
  }));
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  await writeFile(path.join(root, 'index.ts'), 'export const fixture = true;\n');
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('offline CLI integration', () => {
  it('prints the v0.2 package version', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main(['--version']);

    expect(log).toHaveBeenCalledExactlyOnceWith('0.2.0');
  });

  it('inspects a temporary repository and emits one JSON decision in mock mode', async () => {
    const root = await temporaryRepository();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main([root, 'Inspect the fixture repository', '--mock', '--no-trace', '--json']);

    expect(log).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(output).toMatchObject({
      schemaVersion: 1,
      status: 'unexecuted',
      mode: 'mock',
      task: 'Inspect the fixture repository',
      repo: {
        root,
        packageManager: 'pnpm',
        packageName: 'fixture-repository',
        validationScripts: ['lint', 'test'],
      },
      policy: { selected: 'SEARCH_REPO' },
    });
    expect(output).not.toHaveProperty('tracePath');
    expect(output).not.toHaveProperty('rawAnswers');
    expect(output).not.toHaveProperty('providerMetadata');
  });

  it('writes a versioned trace for an offline decision', async () => {
    const root = await temporaryRepository();
    const decision = await runDecision({
      repoPath: root,
      task: 'Inspect the fixture repository',
      mock: true,
      noTrace: false,
    }, root);
    const tracePath = decision.tracePath;

    expect(tracePath).toMatch(/^traces\/.+\.jsonl$/);
    const record = JSON.parse(await readFile(path.join(root, tracePath ?? ''), 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({
      schemaVersion: 1,
      state: { repo: { root } },
      evaluation: {
        assessment: { nextAction: { choice: 'SEARCH_REPO' } },
      },
      policy: { selected: 'SEARCH_REPO' },
    });
    expect((record.evaluation as Record<string, unknown>)).not.toHaveProperty('providerMetadata');
  });

  it('fails before live evaluation when the gateway key is missing', async () => {
    const root = await temporaryRepository();
    vi.stubEnv('AI_GATEWAY_API_KEY', '');

    await expect(runDecision({
      repoPath: root,
      task: 'Inspect the fixture repository',
      mock: false,
      noTrace: true,
    }, root)).rejects.toThrow('AI_GATEWAY_API_KEY is required');
  });

  it('returns the safe trace error when an otherwise valid decision cannot be recorded', async () => {
    const root = await temporaryRepository();
    const blockedTraceRoot = path.join(root, 'blocked-trace-root');
    await writeFile(blockedTraceRoot, 'not a directory');

    await expect(runDecision({
      repoPath: root,
      task: 'Inspect the fixture repository',
      mock: true,
      noTrace: false,
    }, blockedTraceRoot)).rejects.toEqual(expect.objectContaining({
      name: 'TraceWriteError',
      message: expect.stringContaining('--no-trace'),
    } satisfies Partial<TraceWriteError>));
  });
});
