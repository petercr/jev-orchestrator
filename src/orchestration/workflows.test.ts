import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvaluator } from '../ai/evaluate.js';
import { JEV_PROVIDERS } from '../config.js';
import { runProcess, type ProcessRequest, type ProcessResult } from '../process.js';
import { inspectRepo } from '../repo/inspect.js';
import { ACTIONS, type Action, type EvaluationProvider, type WorkerSelection } from '../types.js';
import { executeCandidate } from './execute.js';
import {
  createInitialState,
  runOrchestration,
  type ApprovalContext,
  type ApprovalDecision,
  type EvaluationRecoveryContext,
  type OrchestrationResult,
} from './loop.js';

// Protocol v1: keep these tasks and patches fixed when comparing routing changes.
// Responses below are synthetic enforcement fixtures, never live model evidence.
type TaskFixture = {
  id: string;
  acceptance: string;
  original: string;
  existingTests: string;
  regressionTests: string;
  attempts: string[];
};

const bugFix: TaskFixture = {
  id: 'short-label',
  acceptance: 'Preserve labels of length 10 or less; shorten longer labels to their first 10 characters plus "...". Add short and boundary regression tests.',
  original: 'export const label = (value) => value.slice(0, 10) + "...";\n',
  existingTests: 'assert.equal(label("abcdefghijk"), "abcdefghij...");\n',
  regressionTests: 'assert.equal(label(""), "");\nassert.equal(label("abc"), "abc");\nassert.equal(label("abcdefghij"), "abcdefghij");\n',
  attempts: ['export const label = (value) => value.length <= 10 ? value : value.slice(0, 10) + "...";\n'],
};
const feature: TaskFixture = {
  id: 'label-fallback',
  acceptance: 'Add an optional fallback for an empty label, defaulting to "(empty)". Preserve the existing shortening behavior and cover custom/default fallbacks.',
  original: bugFix.attempts[0]!,
  existingTests: bugFix.existingTests + 'assert.equal(label("abc"), "abc");\n',
  regressionTests: 'assert.equal(label(""), "(empty)");\nassert.equal(label("", "missing"), "missing");\nassert.equal(label("", ""), "");\n',
  attempts: ['export const label = (value, fallback = "(empty)") => value.length === 0 ? fallback : value.length <= 10 ? value : value.slice(0, 10) + "...";\n'],
};
const repair: TaskFixture = {
  ...bugFix,
  id: 'short-label-repair',
  attempts: [
    'export const label = (value) => value.length < 10 ? value : value.slice(0, 10) + "...";\n',
    bugFix.attempts[0]!,
  ],
};
const tasks = [bugFix, feature, repair];
const routes: { provider: EvaluationProvider; model: string }[] = [
  { provider: 'typesafe', model: JEV_PROVIDERS.typesafe.model },
  { provider: 'vercel', model: JEV_PROVIDERS.vercel.model },
  { provider: 'openrouter', model: JEV_PROVIDERS.openrouter.model },
  { provider: 'openrouter', model: 'openai/gpt-6-luna-decisions' },
  { provider: 'cloudflare', model: 'clef' },
  { provider: 'cloudflare', model: 'clef-flash' },
];
const workers: WorkerSelection[] = ['codex', 'claude'];
const issueUrl = 'https://github.com/workflow-fixture/labels/issues/1';
const issueEndpoint = 'https://api.github.com/repos/workflow-fixture/labels/issues/1';
const accountId = 'a'.repeat(32);
const syntheticKey = 'synthetic-workflow-credential';
const roots: string[] = [];
const fetchMock = vi.fn<typeof fetch>();

type Recommendation = {
  action: Action;
  confidence?: number;
  taskComplete?: number;
  needsTesting?: number;
  invalid?: true;
};
type WorkerOutcome = 'success' | 'failure' | 'timeout' | 'malformed' | 'cancelled';

function workerAction(worker: WorkerSelection): 'CALL_CODEX' | 'CALL_CLAUDE' {
  return worker === 'codex' ? 'CALL_CODEX' : 'CALL_CLAUDE';
}

function workflow(worker: WorkerSelection, task: TaskFixture): Recommendation[] {
  const implement: Recommendation = { action: workerAction(worker), needsTesting: 0.99 };
  const finish: Recommendation = { action: 'FINISH', taskComplete: 0.99 };
  return [implement, implement, implement, finish,
    ...(task.attempts.length > 1 ? [{ action: workerAction(worker) }, finish] : []),
    finish, finish];
}

function response(provider: EvaluationProvider, model: string, step: Recommendation): Response {
  if (step.invalid) return new Response('not JSON');
  const confidence = step.confidence ?? 0.99;
  const boolean = (probability: number) => provider === 'vercel'
    ? { type: 'boolean', probability } : { type: 'noul', noul: probability };
  const payload = {
    model,
    answers: {
      taskComplete: boolean(step.taskComplete ?? 0.02),
      needsMoreInformation: boolean(0.02),
      needsTesting: boolean(step.needsTesting ?? 0.02),
      stuck: boolean(0.02),
      nextAction: {
        type: 'choice', choice: step.action,
        probabilities: Object.fromEntries(ACTIONS.map((action) => [action, action === step.action ? 1 : 0])),
        ...(provider === 'vercel' ? {} : { confidence }),
      },
    },
    ...(provider === 'vercel' ? { providerMetadata: { typesafe: { confidence: { nextAction: confidence } } } } : {}),
  };
  return Response.json(provider === 'cloudflare' ? { success: true, errors: [], result: payload } : payload);
}

function tests(task: TaskFixture, includeRegression: boolean): string {
  return 'import assert from "node:assert/strict";\nimport { label } from "./label.mjs";\n' +
    task.existingTests + (includeRegression ? task.regressionTests : '');
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [file, contents] of Object.entries(files)) await writeFile(path.join(root, file), contents);
}

async function git(root: string, args: string[]): Promise<void> {
  const result = await runProcess({
    command: 'git', args: ['-c', `core.hooksPath=${path.join(root, '.no-hooks')}`, '-c', 'commit.gpgSign=false', ...args], cwd: root, timeoutMs: 10_000,
  });
  expect(result.exitCode, result.stderr).toBe(0);
}

async function fixture(task: TaskFixture, worker: WorkerSelection, options: {
  extraInstructions?: true;
  outcomes?: WorkerOutcome[];
  controller?: AbortController;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dev-workflow-v04-'));
  roots.push(root);
  const files = {
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test label.test.mjs', lint: 'node --check label.mjs' } }),
    'package-lock.json': '{}\n',
    '.gitignore': 'traces/\n',
    'AGENTS.md': 'Keep changes bounded. Run npm test and npm run lint independently before acceptance.\n',
    'label.mjs': task.original,
    'label.test.mjs': tests(task, false),
    ...(options.extraInstructions ? { 'CONTRIBUTING.md': 'Preserve all label boundary cases.\n' } : {}),
  };
  await writeFiles(root, files);
  await git(root, ['init', '--quiet']);
  await git(root, ['add', '--', '.']);
  await git(root, ['-c', 'user.name=Workflow fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Frozen workflow baseline']);
  const initial = createInitialState(await inspectRepo(root), issueUrl, worker);
  const commands: ProcessRequest[] = [];
  const validationResults: ProcessResult[] = [];
  let calls = 0;
  const runner = vi.fn(async (request: ProcessRequest, executionOptions?: { signal?: AbortSignal }): Promise<ProcessResult> => {
    commands.push(request);
    expect(request.cwd).toBe(root);
    if (request.command === worker) {
      expect(request.args.at(-1)).toContain(JSON.stringify(task.acceptance).slice(1, -1));
      if (worker === 'codex') {
        expect(request.args).toContain('workspace-write');
        expect(request.args).toContain('sandbox_workspace_write.network_access=false');
      } else {
        expect(request.args).toContain('--restricted');
        expect(request.args).toContain('--strict-mcp-config');
      }
      const source = task.attempts[calls];
      expect(source, 'Unexpected extra worker invocation').toBeDefined();
      if (source === undefined) throw new Error('No scripted patch remains.');
      const outcome = options.outcomes?.[calls] ?? 'success';
      calls += 1;
      await writeFiles(root, { 'label.mjs': source, 'label.test.mjs': tests(task, true) });
      if (outcome === 'cancelled') options.controller?.abort();
      return {
        exitCode: outcome === 'timeout' || outcome === 'cancelled' ? null : outcome === 'failure' ? 1 : outcome === 'malformed' ? 0.5 : 0,
        timedOut: outcome === 'timeout',
        ...(outcome === 'cancelled' ? { cancelled: true } : {}),
        stdout: 'Fixture patch written. Validation was not run by this worker.', stderr: '',
      };
    }
    // Only these fixed local Node scripts may run. Never invoke a real worker,
    // dependency installer, or an unexpected command from the test harness.
    expect(request.command).toBe('npm');
    expect([['run', 'test'], ['run', 'lint']]).toContainEqual(request.args);
    if (request.command !== 'npm' || request.args.length !== 2 || request.args[0] !== 'run' ||
      !['test', 'lint'].includes(request.args[1] ?? '')) throw new Error('Unexpected fixture process.');
    const result = await runProcess(request, executionOptions);
    validationResults.push(result);
    return result;
  });
  return { root, initial, runner, commands, validationResults, files };
}

function transport(route: typeof routes[number], task: TaskFixture, steps: Recommendation[], options: {
  issueStatus?: number;
  issueSuffix?: string;
} = {}) {
  const endpoint = route.provider === 'cloudflare'
    ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${route.model}`
    : route.provider === 'vercel' ? 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model'
      : route.provider === 'typesafe' ? 'https://api.typesafe.ai/v1/systemone' : 'https://openrouter.ai/api/alpha/decisions';
  let evaluations = 0;
  fetchMock.mockImplementation(async (url, init) => {
    if (String(url) === issueEndpoint) {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return Response.json({ html_url: issueUrl, number: 1, title: task.id,
        body: `${task.acceptance} Run npm test and npm run lint. ${options.issueSuffix ?? ''}` }, { status: options.issueStatus ?? 200 });
    }
    expect(String(url)).toBe(endpoint);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${syntheticKey}`);
    expect(route.provider === 'vercel' ? new Headers(init?.headers).get('ai-model-id') : JSON.parse(String(init?.body)).model).toBe(route.model);
    const step = steps[evaluations++];
    if (!step) throw new Error('Scripted evaluation sequence exhausted.');
    return response(route.provider, route.model, step);
  });
  const evaluate = createEvaluator(route.provider === 'cloudflare'
    ? { provider: route.provider, model: route.model, apiKey: syntheticKey, accountId }
    : { provider: route.provider, model: route.model, apiKey: syntheticKey });
  return { evaluate, evaluations: () => evaluations };
}

async function records(result: OrchestrationResult) {
  const trace = await readFile(result.tracePath, 'utf8');
  expect(trace).not.toContain(syntheticKey);
  return trace.trim().split('\n').map((line) => JSON.parse(line));
}

function approver(worker: WorkerSelection, seen: Action[], choose?: (context: ApprovalContext) => ApprovalDecision) {
  return async (context: ApprovalContext): Promise<ApprovalDecision> => {
    seen.push(context.proposal.action);
    expect(context.allowedAlternatives).not.toContain(worker === 'codex' ? 'CALL_CLAUDE' : 'CALL_CODEX');
    if (context.proposal.action === 'CALL_CODEX') expect(context.proposal.input).not.toHaveProperty('networkAccess');
    return choose?.(context) ?? { kind: 'approve' };
  };
}

async function preserved(f: Awaited<ReturnType<typeof fixture>>) {
  for (const file of ['package.json', 'package-lock.json', '.gitignore', 'AGENTS.md'] as const) {
    expect(await readFile(path.join(f.root, file), 'utf8')).toBe(f.files[file]);
  }
  const status = await runProcess({ command: 'git', args: ['diff', '--cached', '--exit-code'], cwd: f.root, timeoutMs: 10_000 });
  expect(status.exitCode).toBe(0);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('frozen v0.4 workflow tasks', () => {
  it.each(tasks)('$id regression fails on the original and passes only on the final patch', async (task) => {
    const f = await fixture(task, 'codex');
    const check = () => runProcess({ command: process.execPath, args: ['--test', 'label.test.mjs'], cwd: f.root, timeoutMs: 10_000 });
    expect((await check()).exitCode).toBe(0);
    await writeFile(path.join(f.root, 'label.test.mjs'), tests(task, true));
    expect((await check()).exitCode).toBe(1);
    for (const [index, source] of task.attempts.entries()) {
      await writeFile(path.join(f.root, 'label.mjs'), source);
      expect((await check()).exitCode).toBe(index === task.attempts.length - 1 ? 0 : 1);
    }
  });
});

// Leave headroom for the real Git and npm subprocesses on busy test runners.
describe.each(routes)('v0.4 complete workflows: $provider/$model', { timeout: 15_000 }, (route) => {
  describe.each(workers)('%s worker', (worker) => {
    it.each(tasks)('completes $id with real independent checks and explicit acceptance', async (task) => {
      const f = await fixture(task, worker);
      const t = transport(route, task, workflow(worker, task));
      const seen: Action[] = [];
      const askForInformation = vi.fn();
      const result = await runOrchestration(f.initial, {
        evaluate: t.evaluate, approve: approver(worker, seen), askForInformation,
        execute: (proposal, _runner, options) => executeCandidate(proposal, f.runner, options),
      });
      const isRepair = task.attempts.length > 1;
      expect(result).toMatchObject({ status: 'finished', iterations: isRepair ? 8 : 6,
        state: { workerSelection: worker, codexCalls: worker === 'codex' ? task.attempts.length : 0,
          claudeCalls: worker === 'claude' ? task.attempts.length : 0,
          filesRead: ['AGENTS.md'], filesModified: ['label.mjs', 'label.test.mjs'],
          evidence: { validationGeneration: task.attempts.length } },
        summary: { counts: { approvals: isRepair ? 8 : 6, alternatives: 0, workerRetries: isRepair ? 1 : 0,
          validationRuns: isRepair ? 3 : 2, validationFailures: isRepair ? 1 : 0 },
        validation: { passed: true, checks: [{ script: 'test', status: 'passed' }, { script: 'lint', status: 'passed' }] } } });
      expect(seen).toEqual(['READ_ISSUE', 'READ_FILE', workerAction(worker), 'RUN_TESTS',
        ...(isRepair ? [workerAction(worker), 'RUN_TESTS'] : []), 'RUN_TESTS', 'FINISH']);
      expect(t.evaluations()).toBe(result.iterations);
      expect(askForInformation).not.toHaveBeenCalled();
      expect(f.validationResults.map((item) => item.exitCode)).toEqual(isRepair ? [1, 0, 0] : [0, 0]);
      const trace = await records(result);
      expect(trace.every((record) => record.evaluation.provider === route.provider && record.evaluation.requestedModel === route.model)).toBe(true);
      expect(trace.filter((record) => record.toolResult !== null).every((record) => record.approval.kind === 'approve')).toBe(true);
      const workerRecords = trace.filter((record) => record.proposal.selected.action === workerAction(worker));
      expect(workerRecords[0].stateBefore.tests).toEqual({ ran: false });
      expect(workerRecords.every((record) => record.stateAfter.tests.ran === false)).toBe(true);
      if (isRepair) {
        expect(workerRecords[1]).toMatchObject({ workerRequest: { retryReason: 'Repair after failed independent validation.' } });
        const repairRequest = f.commands.filter((request) => request.command === worker)[1]!;
        const repairContext: unknown = JSON.parse(repairRequest.args.at(-1)!.split('\n').at(-1)!);
        expect(repairContext).toMatchObject({
          validationGeneration: 1,
          validation: {
            iteration: 4, generation: 1, script: 'test', exitCode: 1,
            timedOut: false, passed: false, summary: expect.stringContaining('ERR_ASSERTION'),
          },
          remainingCalls: { codex: worker === 'codex' ? 1 : 2, claude: worker === 'claude' ? 1 : 2 },
        });
      }
      expect(trace.at(-1)).toMatchObject({ approval: { kind: 'approve' }, proposal: { selected: { action: 'FINISH' } }, toolResult: null });
      await preserved(f);
    });

    it('separates manual worker routing and acceptance review from normal approvals', async () => {
      const f = await fixture(bugFix, worker);
      const steps = workflow(worker, bugFix);
      steps[2] = { action: workerAction(worker), confidence: 0.1 };
      steps[5] = { action: 'RUN_TESTS', taskComplete: 0.2 };
      const t = transport(route, bugFix, steps);
      const seen: Action[] = [];
      const result = await runOrchestration(f.initial, {
        evaluate: t.evaluate, askForInformation: vi.fn(),
        approve: approver(worker, seen, ({ state, proposal, allowedAlternatives }) => {
          if (proposal.action !== 'ASK_USER') return { kind: 'approve' };
          const action = state.iteration === 3 ? workerAction(worker) : 'FINISH';
          expect(allowedAlternatives).toContain(action);
          if (action === 'FINISH') expect(allowedAlternatives).not.toContain('RUN_TESTS');
          return { kind: 'alternative', action };
        }),
        execute: (proposal, _runner, options) => executeCandidate(proposal, f.runner, options),
      });
      expect(result).toMatchObject({ status: 'finished', iterations: 6,
        summary: { counts: { approvals: 6, alternatives: 2, approvalRequests: 8, validationRuns: 2 } } });
      expect(seen).toEqual(['READ_ISSUE', 'READ_FILE', 'ASK_USER', workerAction(worker), 'RUN_TESTS', 'RUN_TESTS', 'ASK_USER', 'FINISH']);
      const trace = await records(result);
      expect(trace[2]).toMatchObject({ evaluation: { assessment: { nextAction: { confidence: 0.1 } } },
        policy: { selected: 'ASK_USER' }, approval: { history: [{ kind: 'alternative', action: workerAction(worker) }, { kind: 'approve' }] } });
      expect(trace.at(-1)).toMatchObject({ policy: { completionReview: 'validation_complete' },
        approval: { history: [{ kind: 'alternative', action: 'FINISH' }, { kind: 'approve' }] } });
    });

    it('continues an evaluation failure after a worker without resetting evidence or limits', async () => {
      const f = await fixture(bugFix, worker);
      const steps = workflow(worker, bugFix);
      steps.splice(3, 0, { action: 'FINISH', invalid: true });
      const t = transport(route, bugFix, steps);
      const seen: Action[] = [];
      const recoverEvaluation = vi.fn(async ({ state, remainingIterations }: EvaluationRecoveryContext) => {
        expect(remainingIterations).toBe(4);
        expect(state).toMatchObject({ workerSelection: worker, evidence: { validationGeneration: 1 }, tests: { ran: false } });
        vi.stubEnv('ROUTER_PROVIDER', 'invalid-after-recovery');
        vi.stubEnv('ROUTER_MODEL', 'invalid-after-recovery');
        return 'continue' as const;
      });
      const result = await runOrchestration(f.initial, {
        evaluate: t.evaluate, approve: approver(worker, seen), askForInformation: vi.fn(), recoverEvaluation,
        execute: (proposal, _runner, options) => executeCandidate(proposal, f.runner, options),
      });
      expect(result).toMatchObject({ status: 'finished', iterations: 7,
        summary: { counts: { evaluations: 7, evaluationFailures: 1, evaluationRecoveries: 1, approvals: 6, validationRuns: 2, workerRetries: 0 } } });
      expect(recoverEvaluation).toHaveBeenCalledOnce();
      const trace = await records(result);
      expect(trace.filter((record) => record.iteration === 4)).toEqual([
        expect.objectContaining({ failure: expect.objectContaining({ code: 'invalid_response' }), approval: null, toolResult: null }),
        expect.objectContaining({ recovery: { available: true, decision: 'continue' }, approval: null, toolResult: null }),
      ]);
      expect(t.evaluations()).toBe(7);
    });

    it('stops for genuine missing issue context without delegation or fabricated metadata', async () => {
      const f = await fixture(bugFix, worker);
      const t = transport(route, bugFix, workflow(worker, bugFix).slice(0, 3), { issueStatus: 404 });
      const seen: Action[] = [];
      const askForInformation = vi.fn(async () => '');
      const result = await runOrchestration(f.initial, {
        evaluate: t.evaluate, askForInformation,
        approve: approver(worker, seen, ({ state, allowedAlternatives }) => {
          if (state.iteration > 1) {
            expect(allowedAlternatives).not.toContain(workerAction(worker));
            expect(allowedAlternatives).not.toContain('FINISH');
          }
          return { kind: state.iteration === 3 ? 'stop' : 'approve' };
        }),
        execute: (proposal, _runner, options) => executeCandidate(proposal, f.runner, options),
      });
      expect(result).toMatchObject({ status: 'stopped', iterations: 3, state: { codexCalls: 0, claudeCalls: 0 },
        summary: { counts: { validationRuns: 0 } } });
      expect(seen).toEqual(['READ_ISSUE', 'ASK_USER', 'ASK_USER']);
      expect(result.state.evidence).not.toHaveProperty('issue');
      expect(result.state.evidence?.clarifications).toEqual([]);
      expect(askForInformation).toHaveBeenCalledOnce();
      expect(f.runner).not.toHaveBeenCalled();
      await records(result);
    });

    it('invalidates passing baseline checks and requires both checks after implementation', async () => {
      const f = await fixture(bugFix, worker);
      const implement: Recommendation = { action: workerAction(worker) };
      const finish: Recommendation = { action: 'FINISH', taskComplete: 0.99 };
      const t = transport(route, bugFix, [implement, implement, { action: 'RUN_TESTS' }, { action: 'RUN_TESTS' }, implement, finish, finish, finish]);
      const seen: Action[] = [];
      const result = await runOrchestration(f.initial, {
        evaluate: t.evaluate, approve: approver(worker, seen), askForInformation: vi.fn(),
        execute: (proposal, _runner, options) => executeCandidate(proposal, f.runner, options),
      });
      expect(result).toMatchObject({ status: 'finished', iterations: 8,
        summary: { counts: { validationRuns: 4 }, validation: { generation: 1, passed: true } } });
      expect(seen).toEqual(['READ_ISSUE', 'READ_FILE', 'RUN_TESTS', 'RUN_TESTS', workerAction(worker), 'RUN_TESTS', 'RUN_TESTS', 'FINISH']);
      const trace = await records(result);
      expect(trace[4]).toMatchObject({ stateBefore: { tests: { passed: true } }, stateAfter: { tests: { ran: false }, evidence: { validationGeneration: 1 } } });
      expect(result.state.evidence?.validations?.every((check) => check.generation === 1)).toBe(true);
      expect(f.validationResults.map((item) => item.exitCode)).toEqual([0, 0, 0, 0]);
    });

    it('retains an accepted repair but returns iteration_limit when preparation uses the last review iteration', async () => {
      const f = await fixture(repair, worker, { extraInstructions: true });
      const steps = workflow(worker, repair);
      steps.splice(2, 0, { action: workerAction(worker) });
      const t = transport(route, repair, steps.slice(0, 8));
      const seen: Action[] = [];
      const result = await runOrchestration(f.initial, {
        evaluate: t.evaluate, approve: approver(worker, seen), askForInformation: vi.fn(),
        execute: (proposal, _runner, options) => executeCandidate(proposal, f.runner, options),
      });
      expect(result).toMatchObject({ status: 'iteration_limit', exitCode: 1, iterations: 8,
        summary: { counts: { approvals: 8, workerRetries: 1, validationRuns: 3, validationFailures: 1 }, validation: { passed: true } } });
      expect(seen).toEqual(['READ_ISSUE', 'READ_FILE', 'READ_FILE', workerAction(worker), 'RUN_TESTS', workerAction(worker), 'RUN_TESTS', 'RUN_TESTS']);
      expect(await readFile(path.join(f.root, 'label.mjs'), 'utf8')).toBe(repair.attempts[1]);
      const trace = await records(result);
      expect(trace.at(-1)).toMatchObject({ proposal: { selected: { action: 'RUN_TESTS' } }, summary: { validation: { passed: true } } });
      expect(result.state.currentGoal).not.toBe('Task complete.');
      expect(t.evaluations()).toBe(8);
      await preserved(f);
    });

    it('withholds a third worker call after two independently failed patches', async () => {
      const broken: TaskFixture = { ...repair, attempts: [repair.attempts[0]!, repair.attempts[0]!] };
      const f = await fixture(broken, worker);
      const steps = workflow(worker, repair);
      steps[6] = { action: workerAction(worker) };
      const t = transport(route, broken, steps.slice(0, 7));
      const seen: Action[] = [];
      const result = await runOrchestration(f.initial, {
        evaluate: t.evaluate, askForInformation: vi.fn(),
        approve: approver(worker, seen, ({ proposal, allowedAlternatives }) => {
          if (proposal.action !== 'ASK_USER') return { kind: 'approve' };
          expect(proposal.reason).toContain('call limit');
          expect(allowedAlternatives).not.toContain(workerAction(worker));
          expect(allowedAlternatives).not.toContain('FINISH');
          return { kind: 'stop' };
        }),
        execute: (proposal, _runner, options) => executeCandidate(proposal, f.runner, options),
      });
      expect(result).toMatchObject({ status: 'stopped', iterations: 7,
        state: { codexCalls: worker === 'codex' ? 2 : 0, claudeCalls: worker === 'claude' ? 2 : 0 },
        summary: { counts: { workerRetries: 1, validationRuns: 2, validationFailures: 2 }, validation: { passed: false } } });
      expect(f.commands.filter((command) => command.command === worker)).toHaveLength(2);
      expect(seen.at(-1)).toBe('ASK_USER');
      await records(result);
    });

    it.each(['missing', 'omitted'] as const)('withholds completion when task checks are %s from runnable coverage', async (condition) => {
      const f = await fixture(bugFix, worker);
      const suffix = condition === 'missing' ? 'Run npm run test:missing.'
        : Array.from({ length: 9 }, (_, index) => `Run npm run test:extra${index}.`).join(' ');
      const steps = workflow(worker, bugFix);
      steps[3] = { action: 'RUN_TESTS' };
      steps[4] = { action: 'RUN_TESTS' };
      const t = transport(route, bugFix, steps, { issueSuffix: suffix });
      const seen: Action[] = [];
      const result = await runOrchestration(f.initial, {
        evaluate: t.evaluate, askForInformation: vi.fn(),
        approve: approver(worker, seen, ({ state, proposal, allowedAlternatives }) => {
          expect(allowedAlternatives).not.toContain('FINISH');
          if (state.iteration < 6) return { kind: 'approve' };
          expect(proposal.action).toBe('ASK_USER');
          return { kind: 'stop' };
        }),
        execute: (proposal, _runner, options) => executeCandidate(proposal, f.runner, options),
      });
      expect(result).toMatchObject({ status: 'stopped', iterations: 6,
        summary: { validation: { passed: false, requirementsOmitted: condition === 'omitted' } } });
      expect(f.validationResults.map((item) => item.exitCode)).toEqual([0, 0]);
      expect(result.summary.validation.checks).toContainEqual({ script: condition === 'missing' ? 'test:missing' : 'test:extra0', status: 'pending' });
      await records(result);
    });

    it.each(['failure', 'timeout', 'malformed', 'cancelled'] as const)('preserves partial edits and requires independent checks after worker %s', async (outcome) => {
      const controller = new AbortController();
      const f = await fixture(bugFix, worker, { outcomes: [outcome], controller });
      const t = transport(route, bugFix, workflow(worker, bugFix));
      const seen: Action[] = [];
      const result = await runOrchestration(f.initial, {
        evaluate: t.evaluate, askForInformation: vi.fn(),
        approve: approver(worker, seen, ({ state, proposal, allowedAlternatives }) => {
          expect(allowedAlternatives).not.toContain('FINISH');
          if (state.iteration < 4) return { kind: 'approve' };
          expect(proposal.action).not.toBe('FINISH');
          return { kind: 'stop' };
        }),
        execute: (proposal, _runner, options) => executeCandidate(proposal, f.runner, options),
      }, { signal: controller.signal });
      expect(result).toMatchObject({ status: 'stopped', iterations: outcome === 'cancelled' ? 3 : 4,
        state: { tests: { ran: false }, filesModified: ['label.mjs', 'label.test.mjs'],
          evidence: { validationGeneration: 1, worker: { ok: false } } },
        summary: { counts: { approvals: 3, validationRuns: 0, failedExecutions: 1,
          timedOutExecutions: outcome === 'timeout' ? 1 : 0, cancelledExecutions: outcome === 'cancelled' ? 1 : 0 },
          validation: { passed: false } } });
      expect(await readFile(path.join(f.root, 'label.mjs'), 'utf8')).toBe(bugFix.attempts[0]);
      expect(f.commands).toHaveLength(1);
      const trace = await records(result);
      if (outcome === 'cancelled') {
        expect(t.evaluations()).toBe(3);
        expect(trace.at(-1)).toMatchObject({ interruption: { phase: 'execution' }, toolResult: { cancelled: true } });
      }
      await preserved(f);
    });
  });
});
