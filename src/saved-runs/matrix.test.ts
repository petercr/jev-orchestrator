import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEvaluator } from '../ai/evaluate.js';
import { JEV_PROVIDERS } from '../config.js';
import { executeCandidate } from '../orchestration/execute.js';
import { createInitialState, runOrchestration, type ApprovalContext } from '../orchestration/loop.js';
import { runProcess, type ProcessRequest } from '../process.js';
import { inspectGitIdentity, inspectRepo } from '../repo/inspect.js';
import { ACTIONS, type Action, type AgentState, type EvaluationProvider } from '../types.js';
import { createSavedRunConfiguration, createSavedRunRepository } from './contract.js';
import { refreshResumeState, resolveResumeConfiguration, resumePosition } from './resume.js';
import { captureRepositorySnapshot } from './snapshot.js';
import { openSavedRunStore } from './store.js';

const routes: { provider: EvaluationProvider; model: string }[] = [
  { provider: 'typesafe', model: JEV_PROVIDERS.typesafe.model },
  { provider: 'vercel', model: JEV_PROVIDERS.vercel.model },
  { provider: 'openrouter', model: JEV_PROVIDERS.openrouter.model },
  { provider: 'openrouter', model: 'openai/gpt-6-luna-decisions' },
  { provider: 'cloudflare', model: 'clef' },
  { provider: 'cloudflare', model: 'clef-flash' },
];
const roots: string[] = [];
const key = 'synthetic-restart-key';
const accountId = 'a'.repeat(32);

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function response(provider: EvaluationProvider, model: string, action: Action): Response {
  const probability = (value: number) => provider === 'vercel'
    ? { type: 'boolean', probability: value } : { type: 'noul', noul: value };
  const payload = {
    model,
    answers: {
      taskComplete: probability(action === 'FINISH' ? 0.94 : 0.01),
      needsMoreInformation: probability(0.01),
      needsTesting: probability(action === 'RUN_TESTS' ? 0.99 : 0.01),
      stuck: probability(0.01),
      nextAction: { type: 'choice', choice: action,
        probabilities: Object.fromEntries(ACTIONS.map((known) => [known, Number(known === action)])),
        ...(provider === 'vercel' ? {} : { confidence: 0.99 }),
      },
    },
    ...(provider === 'vercel' ? { providerMetadata: { typesafe: { confidence: { nextAction: 0.99 } } } } : {}),
  };
  return Response.json(provider === 'cloudflare' ? { success: true, errors: [], result: payload } : payload);
}

// Each segment binds a fresh real evaluator and reconstructs state from durable
// records. HTTP and coding workers are synthetic; Git, policy, approvals, the
// process runner, independent validation, and the saved-run store stay real.
describe.each(routes)('restart enforcement: $provider/$model', ({ provider, model }) => {
  it.each((['codex', 'claude'] as const).flatMap((worker) => [
    { worker, exhausted: false }, { worker, exhausted: true },
  ]))('$worker across three segments (exhausted: $exhausted)', async ({ worker, exhausted }) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'dev-restart-matrix-'));
    roots.push(parent);
    const root = path.join(parent, 'project');
    await mkdir(root);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }));
    await writeFile(path.join(root, 'package-lock.json'), '{}');
    await writeFile(path.join(root, 'AGENTS.md'), 'Read instructions and independently validate the preserved patch.');
    await writeFile(path.join(root, 'value.txt'), 'original');
    await writeFile(path.join(root, 'check.mjs'), "import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';assert.equal(readFileSync('value.txt','utf8'),'patched');\n");
    const git = (args: string[]) => execFileSync('git', ['-c', 'commit.gpgSign=false', ...args], { cwd: root });
    git(['init', '--quiet']); git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    const identity = await inspectGitIdentity(root);
    const repository = await createSavedRunRepository(identity.root, identity.gitCommonDirectory, identity.head);
    const configuration = createSavedRunConfiguration('live', provider === 'cloudflare'
      ? { provider, model, apiKey: key, accountId } : { provider, model, apiKey: key }, worker, worker === 'codex');
    const store = await openSavedRunStore(path.join(parent, 'state'));
    let state = createInitialState(await inspectRepo(root), 'Patch value.txt and pass test.', worker, worker === 'codex' ? true : undefined);
    const iterationLimit = exhausted ? 7 : 8;
    const created = await store.create({ repository, configuration, state, iterationLimit });
    const action = worker === 'codex' ? 'CALL_CODEX' : 'CALL_CLAUDE';
    const excluded = worker === 'codex' ? 'CALL_CLAUDE' : 'CALL_CODEX';
    const runner = vi.fn(async (request: ProcessRequest) => {
      if (request.command === worker) {
        if (worker === 'codex') expect(request.args).toEqual(expect.arrayContaining([
          'workspace-write', 'sandbox_workspace_write.network_access=true', '--ask-for-approval', 'never',
        ]));
        else expect(request.args).toEqual(expect.arrayContaining(['--restricted', '--strict-mcp-config']));
        await writeFile(path.join(root, 'value.txt'), 'patched');
        return { exitCode: 0, timedOut: false, stdout: 'Patch ready; no independent validation performed.', stderr: '' };
      }
      expect(request.command).toBe('npm'); expect(request.args).toEqual(['run', 'test']);
      return runProcess(request);
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const traces: string[] = [];
    const approvals: Action[][] = [];
    // Stop twice, then either independently validate and accept, or prove
    // neither worker calls nor a lower original iteration ceiling can reset.
    const steps: Action[][] = exhausted
      ? [[action, 'RUN_TESTS'], ['RUN_TESTS', action, 'RUN_TESTS'], ['RUN_TESTS', action]]
      : [[action, 'RUN_TESTS'], ['RUN_TESTS', 'RUN_TESTS'], ['RUN_TESTS', 'RUN_TESTS', 'FINISH']];
    for (const [segment, recommendations] of steps.entries()) {
      let startIteration = 1;
      if (segment > 0) {
        const saved = await store.read(created.runId);
        const position = resumePosition(saved.checkpoint, saved.events);
        expect(position).toMatchObject({ nextIteration: steps.slice(0, segment).flat().length + 1, segment: segment + 1 });
        const snapshot = await store.readRepositorySnapshot(created.runId, position.repositorySnapshotHash);
        state = refreshResumeState(saved.checkpoint, await inspectRepo(root), snapshot);
        expect(state.tests).toEqual({ ran: false });
        expect(state.filesRead).toEqual([]);
        expect(state[worker === 'codex' ? 'codexCalls' : 'claudeCalls']).toBe(exhausted ? segment : 1);
        await store.append(created.runId, { type: 'run_resumed', segment: position.segment }, state);
        startIteration = position.nextIteration;
      }
      const environment = provider === 'cloudflare' ? { CLOUDFLARE_AUTH_TOKEN: key, CLOUDFLARE_ACCOUNT_ID: accountId }
        : provider === 'typesafe' ? { TYPESAFE_API_KEY: key }
          : provider === 'vercel' ? { AI_GATEWAY_API_KEY: key } : { OPENROUTER_API_KEY: key };
      const resolved = resolveResumeConfiguration(configuration, environment);
      if (!resolved) throw new Error('Expected a live synthetic configuration.');
      expect(resolved).toMatchObject({ provider, model });
      const evaluate = createEvaluator(resolved);
      let index = 0;
      fetchMock.mockImplementation(async (url, init) => {
        expect(String(url)).toBe(provider === 'cloudflare'
          ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`
          : provider === 'vercel' ? 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model'
            : provider === 'typesafe' ? 'https://api.typesafe.ai/v1/systemone' : 'https://openrouter.ai/api/alpha/decisions');
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}`);
        const next = recommendations[index++];
        if (!next) throw new Error('Unexpected evaluation after scripted segment.');
        return response(provider, model, next);
      });
      const seen: Action[] = [];
      approvals.push(seen);
      const result = await runOrchestration(state, {
        evaluate,
        approve: async (context: ApprovalContext) => {
          expect(context.allowedAlternatives).not.toContain(excluded);
          seen.push(context.proposal.action);
          if (segment < 2 && index === recommendations.length) return { kind: 'stop' };
          if (exhausted && segment === 2 && index === recommendations.length) {
            expect(context.proposal.action).toBe('ASK_USER');
            expect(context.allowedAlternatives).not.toContain(action);
            expect(context.allowedAlternatives).not.toContain('FINISH');
            return { kind: 'reject' };
          }
          if (context.proposal.action === 'ASK_USER') return { kind: 'alternative', action: 'FINISH' };
          return { kind: 'approve' };
        },
        askForInformation: async () => { throw new Error('Unexpected information request.'); },
        execute: (candidate, _runner, options) => executeCandidate(candidate, runner, options),
      }, {
        startIteration, maxIterations: iterationLimit, segment: segment + 1, savedRunId: created.runId,
        persistence: { record: async (event, next: AgentState) => store.append(created.runId, event, next,
          event.type === 'run_stopped' && event.resumable ? await captureRepositorySnapshot(repository) : undefined) },
      });
      expect(result.status).toBe(segment === 2 ? exhausted ? 'iteration_limit' : 'finished' : 'stopped');
      if (exhausted && segment === 2) expect(result.exitCode).toBe(1);
      expect(index).toBe(recommendations.length);
      traces.push(await readFile(result.tracePath, 'utf8'));
    }
    const final = await store.read(created.runId);
    expect(approvals).toEqual(exhausted
      ? [[action, 'RUN_TESTS'], ['READ_FILE', action, 'RUN_TESTS'], ['READ_FILE', 'ASK_USER']]
      : [[action, 'RUN_TESTS'], ['READ_FILE', 'RUN_TESTS'], ['READ_FILE', 'RUN_TESTS', 'ASK_USER', 'FINISH']]);
    expect(final.checkpoint).toMatchObject({ status: exhausted ? 'iteration_limit' : 'finished', configuration, iterationLimit,
      state: { iteration: 7, evidence: { validationGeneration: exhausted ? 4 : 3 }, tests: exhausted ? { ran: false } : { passed: true } } });
    expect(final.events.filter((event) => event.type === 'iteration_reserved').map((event) => event.iteration)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(final.events.filter((event) => event.type === 'execution_reserved' && event.action === action)).toHaveLength(exhausted ? 2 : 1);
    expect(runner.mock.calls.map(([request]) => request.command)).toEqual(exhausted ? [worker, worker] : [worker, 'npm']);
    expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe('patched');
    for (const [segment, trace] of traces.entries()) {
      expect(trace).not.toContain(key);
      expect(trace.trim().split('\n').map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([
        expect.objectContaining({ savedRunId: created.runId, segment: segment + 1 }),
      ]));
    }
    expect(() => resumePosition(final.checkpoint, final.events)).toThrow('durable clean stop');
  }, 25_000);
});
