import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { mockEvaluation } from '../mock.js';
import { inspectRepo } from '../repo/inspect.js';
import { pendingValidationScripts } from '../repo/validation.js';
import { executeCandidate, type ProcessRunner } from './execute.js';
import { createInitialState, runOrchestration } from './loop.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(['before', 'during', 'during then restored'] as const)('requires fresh approval and validation for manifest drift %s execution', async (change) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-validation-manifest-'));
  roots.push(root);
  const manifest = path.join(root, 'package.json');
  const writeManifest = (test: string) => writeFile(manifest, JSON.stringify({
    scripts: { verify: 'npm test && npm run build', test, build: 'node build.mjs' },
  }));
  await writeManifest('node original-test.mjs');
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  const initial = createInitialState(await inspectRepo(root), 'Fix the build');
  const approvedHashes: Array<string | undefined> = [];
  const runner = vi.fn<ProcessRunner>(async () => {
    if (runner.mock.calls.length === 1 && change !== 'before') {
      await writeManifest('node replacement-test.mjs');
      if (change === 'during then restored') await writeManifest('node original-test.mjs');
    }
    return { exitCode: 0, stdout: 'checks passed', stderr: '', timedOut: false };
  });
  const result = await runOrchestration(initial, {
    evaluate: async (state) => {
      const evaluation = mockEvaluation(state);
      evaluation.assessment.taskComplete.probability = 0.99;
      evaluation.assessment.nextAction = { choice: 'FINISH', probabilities: { FINISH: 1 }, confidence: 0.99 };
      return evaluation;
    },
    approve: async ({ proposal, state, allowedAlternatives }) => {
      if (state.iteration <= 2) {
        expect(proposal.action).toBe('RUN_TESTS');
        expect(allowedAlternatives).not.toContain('FINISH');
        expect(pendingValidationScripts(state)).toEqual(['verify', 'test', 'build']);
        expect(state.evidence?.validations).toEqual([]);
        if (proposal.action === 'RUN_TESTS') approvedHashes.push(proposal.input.manifestHash);
      }
      if (state.iteration === 1 && change === 'before') await writeManifest('node replacement-test.mjs');
      if (state.iteration === 3) expect(proposal.action).toBe('FINISH');
      return { kind: 'approve' };
    },
    askForInformation: vi.fn(),
    execute: (proposal, _runner, options) => executeCandidate(proposal, runner, options),
  }, { maxIterations: 3 });

  expect(runner).toHaveBeenCalledTimes(change === 'before' ? 1 : 2);
  expect(approvedHashes[0]).toMatch(/^[a-f0-9]{64}$/u);
  expect(approvedHashes[1]).toMatch(/^[a-f0-9]{64}$/u);
  if (change === 'during then restored') expect(approvedHashes[1]).toBe(approvedHashes[0]);
  else expect(approvedHashes[1]).not.toBe(approvedHashes[0]);
  expect(result).toMatchObject({ status: 'finished', summary: { validation: { generation: 1, passed: true } } });
  expect(result.state.evidence?.validations).toEqual([
    expect.objectContaining({ script: 'verify', manifestHash: approvedHashes[1], coveredScripts: ['verify', 'test', 'build'] }),
  ]);
  const entries = (await readFile(result.tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(entries[0]).toMatchObject({
    toolResult: { ok: false, validationManifestChanged: change === 'before' ? 'before' : 'during' },
  });
});
