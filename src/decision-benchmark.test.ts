import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { boundAgentStateForEvaluation } from './ai/contract.js';
import { EvaluationError, evaluationFailure } from './ai/errors.js';
import { createInitialState } from './orchestration/loop.js';
import { selectCandidate } from './orchestration/candidate.js';
import { applyPolicy } from './policy.js';
import { ACTIONS, type Action, type AgentState, type EvaluationResult } from './types.js';

const load = (name: string) => import(pathToFileURL(path.resolve('scripts/decisions', name)).href);
const fixtures = await load('fixtures.mjs');
const metrics = await load('metrics.mjs');
const harness = await load('run.mjs');
const api = { ACTIONS, applyPolicy, selectCandidate, evaluationFailure };

function result(choice: Action, predicates: Record<string, boolean> = {}): EvaluationResult {
  return { model: 'fixture/model', servedModel: 'fixture/model-v1', latencyMs: 1, rawAnswers: { note: 'never-retain-this-provider-text' },
    assessment: {
      taskComplete: { probability: Number(predicates.taskComplete ?? false) },
      needsMoreInformation: { probability: Number(predicates.needsMoreInformation ?? false) },
      needsTesting: { probability: Number(predicates.needsTesting ?? false) },
      stuck: { probability: Number(predicates.stuck ?? false) },
      nextAction: { choice, confidence: 0.99, probabilities: Object.fromEntries(ACTIONS.map((action) => [action, Number(action === choice)])) },
    } };
}

describe('decision snapshot protocol', () => {
  it('rejects absent live opt-in and excessive repetition arguments before runtime or network access', async () => {
    for (const args of [[], ['--live'], ['--live', '/unused', '4'], ['--live', '/unused', '1.5'], ['--plan', 'extra'], ['--live', '/unused', '1', 'extra']]) {
      await expect(harness.main(args)).rejects.toThrow('Usage:');
    }
  });

  it('freezes fourteen distinct bounded snapshots with labels outside provider input', () => {
    const snapshots = fixtures.buildSnapshots(createInitialState);
    expect(snapshots).toHaveLength(14);
    expect(new Set(snapshots.map((item: { id: string }) => item.id)).size).toBe(14);
    expect(fixtures.buildSnapshots(createInitialState)).toEqual(snapshots);
    for (const item of snapshots) {
      expect(item.label.actions.length).toBeGreaterThan(0);
      expect([...item.label.actions, ...item.label.forbiddenActions].every((action) => ACTIONS.includes(action))).toBe(true);
      const bounded = boundAgentStateForEvaluation(item.state);
      expect(bounded).not.toHaveProperty('label');
      expect(JSON.stringify(bounded)).not.toContain('forbiddenActions');
      expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(6000);
    }
  });

  it('rotates route order and schedules exactly three observations per model/snapshot', () => {
    const snapshots = fixtures.buildSnapshots(createInitialState);
    const jobs = metrics.schedule(snapshots, fixtures.ROUTES, 3);
    expect(jobs).toHaveLength(168);
    for (const snapshot of snapshots) for (const route of fixtures.ROUTES) {
      expect(jobs.filter((job: { snapshotId: string; routeId: string }) => job.snapshotId === snapshot.id && job.routeId === route.id)).toHaveLength(3);
    }
    expect(jobs.slice(0, 4).map((job: { routeId: string }) => job.routeId)).toEqual(['jev', 'clef', 'clef-flash', 'openai']);
    expect(jobs.slice(56, 60).map((job: { routeId: string }) => job.routeId)).toEqual(['clef', 'clef-flash', 'openai', 'jev']);
    for (const invalid of [0, 4, 1.5, NaN]) expect(() => metrics.schedule(snapshots, fixtures.ROUTES, invalid)).toThrow();
  });

  it('labels achievable routes under the unchanged policy and worker guards', async () => {
    for (const snapshot of fixtures.buildSnapshots(createInitialState)) {
      const evaluation = result(snapshot.label.actions[0], snapshot.label.predicates);
      const row = await harness.observation({ routeId: 'fixture', snapshotId: snapshot.id, repetition: 1 }, snapshot, async () => evaluation, api);
      expect(row.outcome, snapshot.id).toBe('normalized');
      expect(row.grade.guardedCorrect, snapshot.id).toBe(true);
      expect(row.grade.forbiddenRecommendation, snapshot.id).toBe(false);
      expect(row.grade.forbiddenGuarded, snapshot.id).toBe(false);
      expect(JSON.stringify(row)).not.toContain('never-retain-this-provider-text');
    }
  });

  it('grades model recommendations separately from policy and candidate budget overrides', async () => {
    const snapshots = fixtures.buildSnapshots(createInitialState);
    const restricted = snapshots.find((item: { id: string }) => item.id === 'implement-codex');
    const wrong = await harness.observation({ routeId: 'fixture', snapshotId: restricted.id }, restricted, async () => result('CALL_CLAUDE'), api);
    expect(wrong).toMatchObject({ requestedAction: 'CALL_CLAUDE', guardedAction: 'ASK_USER',
      grade: { rawCorrect: false, forbiddenRecommendation: true, forbiddenGuarded: false, avoidableAbstention: true, actionBrier: 2 } });
    const exhausted = snapshots.find((item: { id: string }) => item.id === 'worker-limits');
    const budget = await harness.observation({ routeId: 'fixture', snapshotId: exhausted.id }, exhausted, async () => result('CALL_CODEX'), api);
    expect(budget).toMatchObject({ policyAction: 'CALL_CODEX', guardedAction: 'ASK_USER',
      grade: { rawCorrect: false, guardedCorrect: true, candidateOverride: true } });
  });

  it('clones each observation state, excludes set-valued labels from categorical Brier, and preserves absent confidence', async () => {
    const snapshot = fixtures.buildSnapshots(createInitialState).find((item: { id: string }) => item.id === 'failed-validation');
    const before = structuredClone(snapshot.state);
    const evaluation = result('READ_FILE'); delete evaluation.assessment.nextAction.confidence;
    const row = await harness.observation({ routeId: 'fixture', snapshotId: snapshot.id }, snapshot, async (state: AgentState) => {
      state.currentGoal = 'Injected mutation'; return evaluation;
    }, api);
    expect(snapshot.state).toEqual(before);
    expect(row.grade).toMatchObject({ rawCorrect: true, actionBrier: null, confidence: null });
  });

  it('retains safe failure diagnostics and interrupted attempts without scoring or raw errors', async () => {
    const snapshot = fixtures.buildSnapshots(createInitialState)[0];
    const policy = vi.fn(applyPolicy);
    const failure = await harness.observation({ routeId: 'fixture' }, snapshot,
      async () => { throw new EvaluationError('invalid_response', 'never-retain-this-provider-text', { stage: 'distribution', category: 'sum', probabilitySum: 0.99 }); }, { ...api, applyPolicy: policy });
    expect(failure).toMatchObject({ outcome: 'failed', failure: { code: 'invalid_response', probabilitySum: 0.99 } });
    expect(failure).not.toHaveProperty('grade'); expect(policy).not.toHaveBeenCalled();
    expect(JSON.stringify(failure)).not.toContain('never-retain-this-provider-text');
    const controller = new AbortController(); controller.abort();
    const interrupted = await harness.observation({}, snapshot, async () => { throw new Error('private abort cause'); }, api, controller.signal);
    expect(interrupted).toMatchObject({ outcome: 'interrupted', failure: { code: 'interrupted' } });
    expect(JSON.stringify(interrupted)).not.toContain('private abort cause');
  });
});

describe('decision comparison reporting', () => {
  it('keeps only explicitly returned finite integer token usage', () => {
    expect(metrics.reportedUsage({ usage: { input_tokens: 10, output_tokens: 0, cost: 0.1, secret: 'private' } })).toEqual({ inputTokens: 10, outputTokens: 0 });
    expect(metrics.reportedUsage({ result: { usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } } })).toEqual({ inputTokens: 12, outputTokens: 2, totalTokens: 14 });
    expect(metrics.reportedUsage({ usage: { input_tokens: '10', output_tokens: -1, total_tokens: Infinity } })).toBeNull();
    expect(metrics.reportedUsage({})).toBeNull();
  });

  it('computes nearest-rank latency percentiles and reports missing samples as null', () => {
    expect(metrics.statistics([4, 1, 2, 3])).toEqual({ n: 4, mean: 2.5, p50: 2, p90: 4, p95: 4, min: 1, max: 4 });
    expect(metrics.statistics([])).toMatchObject({ n: 0, mean: null, p95: null });
    expect(() => metrics.statistics([NaN])).toThrow();
  });

  it('retains reliability bin counts and keeps confidence separate from action probability', () => {
    const calibrated = metrics.reliability([[0.9, true], [0.5, false]]);
    expect(calibrated.n).toBe(2);
    expect(calibrated.expectedCalibrationError).toBeCloseTo(0.3);
    expect(metrics.reliability([[1, true]]).bins[4]).toMatchObject({ n: 1, mean: 1, accuracy: 1 });
    expect(metrics.reliability([]).expectedCalibrationError).toBeNull();
    expect(() => metrics.reliability([[1.1, true]])).toThrow();
  });

  it('includes failures in denominators/latency and never invents unavailable usage', async () => {
    const snapshot = fixtures.buildSnapshots(createInitialState)[0];
    const good = await harness.observation({ routeId: 'fixture', snapshotId: snapshot.id }, snapshot, async () => result('READ_ISSUE'), api);
    good.durationMs = 100; good.attempts = [{ usage: null, refusal: false }];
    const bad = { routeId: 'fixture', snapshotId: snapshot.id, outcome: 'failed', durationMs: 1000,
      failure: { code: 'invalid_response' }, attempts: [{ usage: { inputTokens: 10 }, refusal: true }] };
    const summary = metrics.summarize([good, bad], [{ id: 'fixture', provider: 'typesafe', model: 'jev-latest' }], 3);
    expect(summary).toMatchObject({ planned: 3, attempted: 2, unstarted: 1 });
    expect(summary.models[0]).toMatchObject({ attempted: 2, normalized: 1, failed: 1, rawCorrect: 1, refusals: 1,
      latencyMs: { n: 2, p95: 1000 }, normalizedLatencyMs: { n: 1, p95: 100 },
      usage: { inputTokens: { responses: 1, sum: 10 }, outputTokens: { responses: 0, sum: null } } });
  });
});
