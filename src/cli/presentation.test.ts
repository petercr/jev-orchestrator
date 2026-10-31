import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvaluationError, evaluationFailure } from '../ai/errors.js';
import { applyPolicy } from '../policy.js';
import { selectCandidate } from '../orchestration/candidate.js';
import { executeCandidate } from '../orchestration/execute.js';
import { createInitialState, runOrchestration, type ApprovalContext, type OrchestrationStatus } from '../orchestration/loop.js';
import { createRunMetrics } from '../orchestration/summary.js';
import type { Action, AgentState, EvaluationResult } from '../types.js';
import { formatApprovalLines, formatOutcomeLines, formatProgressLines, formatRecoveryLines } from './presentation.js';

let root: string;
const url = 'https://github.com/workflow-fixture/labels/issues/1';

function state(prepared = true): AgentState {
  const initial = createInitialState({
    root, packageManager: 'npm', scripts: ['test', 'lint'], validationScripts: ['test', 'lint'],
    gitStatus: [], topLevelFiles: ['AGENTS.md'],
  }, url, 'codex');
  if (prepared) {
    initial.filesRead = ['AGENTS.md'];
    initial.evidence!.issue = { url, title: 'Fix labels', body: 'Preserve short labels.', requestedValidationScripts: ['test', 'lint'], truncated: false };
  }
  return initial;
}

function evaluation(action: Action, confidence: number | null = 0.99, complete = 0.02): EvaluationResult {
  return {
    model: 'mock/fixture', latencyMs: 0, rawAnswers: {}, provider: 'mock', requestedModel: 'mock/fixture',
    assessment: {
      taskComplete: { probability: complete }, needsMoreInformation: { probability: 0.02 },
      needsTesting: { probability: 0.02 }, stuck: { probability: 0.02 },
      nextAction: { choice: action, probabilities: { [action]: 1 }, ...(confidence === null ? {} : { confidence }) },
    },
  };
}

async function context(initial: AgentState, result = evaluation('CALL_CODEX'), alternatives: ApprovalContext['allowedAlternatives'] = ['ASK_USER']): Promise<ApprovalContext> {
  const policy = applyPolicy(initial, result.assessment);
  return {
    state: initial, evaluation: result, policy, proposal: await selectCandidate(policy.selected, initial),
    allowedAlternatives: alternatives,
    review: { source: 'policy', requested: policy.selected, iterationLimit: 8,
      counts: { approvals: 0, alternatives: 0, evaluationRecoveries: 0 } },
  };
}

function pass(initial: AgentState, generation = 1): void {
  initial.evidence!.validationGeneration = generation;
  initial.tests = { ran: true, passed: true };
  initial.evidence!.validations = ['test', 'lint'].map((script) => ({
    iteration: 5, generation, script, exitCode: 0, timedOut: false, passed: true, summary: 'Independent check passed.',
  }));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dev-presentation-'));
  await writeFile(path.join(root, 'AGENTS.md'), 'Keep the task bounded.');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'node --check label.mjs' } }));
  await writeFile(path.join(root, 'package-lock.json'), '{}');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('operator explanations from policy and candidate evidence', () => {
  it('distinguishes linked-issue preparation from the requested worker', async () => {
    const view = await context(state(false), evaluation('CALL_CODEX'), ['READ_ISSUE', 'ASK_USER']);
    const output = formatApprovalLines(view).join('\n');
    expect(output).toContain('Evaluator requested: CALL_CODEX');
    expect(output).toContain('Policy selected: READ_ISSUE (override)');
    expect(output).toContain('Safe candidate: READ_ISSUE');
    expect(output).toContain('Issue context: not yet read');
    expect(output).toContain('Required unread instructions: AGENTS.md');
    expect(output).toContain('Allowed alternatives: READ_ISSUE, ASK_USER');
  });

  it('names the unread instruction after the exact issue is prepared', async () => {
    const initial = state(); initial.filesRead = [];
    const output = formatApprovalLines(await context(initial)).join('\n');
    expect(output).toContain('Policy selected: READ_FILE (override)');
    expect(output).toContain('Required unread instructions: AGENTS.md');
    expect(output).toContain('"path":"AGENTS.md"');
  });

  it('explains an unavailable issue without fabricating issue metadata or clarification', async () => {
    const initial = state(false);
    initial.evidence!.failures.push({ iteration: 1, action: 'READ_ISSUE', summary: 'Unavailable.' });
    initial.iteration = 2;
    const output = formatApprovalLines(await context(initial)).join('\n');
    expect(output).toContain('Issue context: unavailable; task context is still required from the operator');
    expect(output).toContain('To provide context, enter approve');
    expect(initial.evidence).not.toHaveProperty('issue');
    expect(initial.evidence?.clarifications).toEqual([]);
  });

  it('attributes replacement issue context to approved clarification', () => {
    const initial = state(false);
    initial.evidence!.failures.push({ iteration: 1, action: 'READ_ISSUE', summary: 'Unavailable.' });
    initial.evidence!.clarifications.push({ iteration: 2, text: 'Preserve short labels.' });
    expect(formatProgressLines(initial).join('\n')).toContain('Issue context: supplied through approved clarification');
    expect(initial.evidence).not.toHaveProperty('issue');
  });

  it.each([0.1, null])('reports confidence %s without promoting the recommendation or choices', async (confidence) => {
    const view = await context(state(), evaluation('CALL_CODEX', confidence));
    const before = structuredClone(view);
    const output = formatApprovalLines(view).join('\n');
    expect(output).toContain('Policy selected: ASK_USER (override)');
    expect(output).toContain(`reported confidence: ${confidence ?? 'not reported'}`);
    expect(output).toContain('Allowed alternatives: ASK_USER');
    expect(view).toEqual(before);
  });

  it('shows failed and pending checks from the current generation', async () => {
    const initial = state(); pass(initial);
    initial.tests.passed = false;
    initial.evidence!.validations = [{ iteration: 4, generation: 1, script: 'test', exitCode: 1, timedOut: false, passed: false, summary: 'Boundary assertion.' }];
    const output = formatApprovalLines(await context(initial, evaluation('FINISH', 0.99, 0.99))).join('\n');
    expect(output).toContain('Policy selected: ASK_USER (override)');
    expect(output).toContain('Validation failed and requires diagnosis');
    expect(output).toContain('Independent checks (generation 1): test: failed, lint: pending');
    expect(output).toContain('Independent test failure: exit 1. Boundary assertion.');
    expect(output).not.toContain('Completion review is available');
  });

  it('clears an earlier failure diagnostic after a later covering check passes', () => {
    const initial = state(); pass(initial);
    initial.repo.validationScriptCoverage = { lint: ['lint', 'test'] };
    initial.evidence!.validations = [
      { iteration: 3, generation: 1, script: 'test', exitCode: 1, timedOut: false, passed: false, summary: 'Previous assertion.' },
      { iteration: 4, generation: 1, script: 'lint', exitCode: 0, timedOut: false, passed: true, summary: 'Both checks passed.' },
    ];
    const output = formatProgressLines(initial).join('\n');
    expect(output).toContain('test: passed, lint: passed');
    expect(output).not.toContain('Previous assertion');
    expect(output).not.toContain('Independent test failure');
  });

  it('explains why earlier passing checks cannot cover a new worker generation', async () => {
    const initial = state(); pass(initial, 0);
    initial.evidence!.validationGeneration = 1;
    initial.tests = { ran: false };
    const output = formatApprovalLines(await context(initial, evaluation('FINISH', 0.99, 0.99))).join('\n');
    expect(output).toContain('Independent checks (generation 1): test: pending, lint: pending');
    expect(output).toContain('Earlier-generation results are stale');
    expect(output).toContain('Safe candidate: RUN_TESTS');
    expect(output).not.toContain('Completion review is available');
  });

  it('uses declared workflow coverage to identify the remaining check', async () => {
    const initial = state(); pass(initial);
    initial.repo.validationScripts = ['verify', 'test', 'lint', 'build'];
    initial.repo.requiredValidationScripts = ['verify', 'test', 'lint', 'build'];
    initial.repo.validationScriptCoverage = { verify: ['verify', 'test', 'lint'], build: ['build'] };
    initial.evidence!.validations = [{ iteration: 5, generation: 1, script: 'verify', exitCode: 0, timedOut: false, passed: true, summary: 'Passed.' }];
    const output = formatApprovalLines(await context(initial, evaluation('FINISH', 0.99, 0.99))).join('\n');
    expect(output).toContain('verify: passed, test: passed, lint: passed, build: pending');
    expect(output).toContain('Completion needs independent checks: build.');
    expect(output).toContain('"script":"build"');
  });

  it('guides explicit acceptance review when validation is complete and tests are redundant', async () => {
    const initial = state(); pass(initial);
    const view = await context(initial, evaluation('RUN_TESTS'), ['ASK_USER', 'FINISH']);
    const output = formatApprovalLines(view).join('\n');
    expect(view.policy.completionReview).toBe('validation_complete');
    expect(output).toContain('Completion review is available. Select FINISH, review its resolved candidate');
    expect(output).toContain('original task acceptance criteria');
    expect(output).toContain('Allowed alternatives: ASK_USER, FINISH');
    expect(output).not.toContain('Enter approve to run only the displayed RUN_TESTS');
  });

  it('explains optional completion review while preserving the proposed file read', async () => {
    const initial = state(); pass(initial);
    await writeFile(path.join(root, 'label.mjs'), 'export const label = "fixed";');
    initial.repo.topLevelFiles.push('label.mjs');
    initial.iteration = 6;
    initial.codexCalls = 1;
    initial.evidence!.worker = { agent: 'codex', iteration: 3, evidenceRevision: 0, exitCode: 0, timedOut: false, ok: true, summary: '', modifiedFiles: [] };
    const view = await context(initial, evaluation('READ_FILE'), ['READ_FILE', 'FINISH']);
    const before = structuredClone(view);
    const output = formatApprovalLines(view).join('\n');
    expect(view.policy.completionReview).toBe('validated_inspection');
    expect(output).toContain('Policy selected: READ_FILE');
    expect(output).toContain('Safe candidate: READ_FILE');
    expect(output).toContain('Enter approve to run only the displayed READ_FILE candidate.');
    expect(output).toContain('Completion review is available. Select FINISH, review its resolved candidate');
    expect(view).toEqual(before);
  });

  it('shows a sub-threshold completion probability exactly', async () => {
    const initial = state(); pass(initial);
    const output = formatApprovalLines(await context(initial, evaluation('FINISH', 0.99, 0.949), ['ASK_USER', 'FINISH'])).join('\n');
    expect(output).toContain('Task-completion probability: 0.949');
    expect(output).toContain('Completion confidence does not clear the finish threshold');
    expect(output).toContain('Safe candidate: ASK_USER');
  });

  it.each([false, true])('reports unsuccessful worker evidence with timeout=%s without claiming the patch is accepted', (timedOut) => {
    const initial = state();
    initial.evidence!.validationGeneration = 1;
    initial.evidence!.worker = { iteration: 3, agent: 'codex', evidenceRevision: 1,
      exitCode: timedOut ? null : 1, timedOut, ok: false, summary: 'Partial edits.', modifiedFiles: ['label.mjs'] };
    const output = formatProgressLines(initial).join('\n');
    expect(output).toContain(`Last codex attempt: ${timedOut ? 'timed out' : 'unsuccessful, exit 1'}`);
    expect(output).toContain('obtain fresh independent validation');
    expect(output).toContain('test: pending, lint: pending');
  });

  it('does not request redundant validation after an unsuccessful worker has independently passed checks', () => {
    const initial = state(); pass(initial);
    initial.evidence!.worker = { iteration: 3, agent: 'codex', evidenceRevision: 1,
      exitCode: 1, timedOut: false, ok: false, summary: 'Partial edits.', modifiedFiles: ['label.mjs'] };
    const output = formatProgressLines(initial).join('\n');
    expect(output).toContain('test: passed, lint: passed');
    expect(output).toContain('Last codex attempt: unsuccessful, exit 1');
    expect(output).toContain('review any saved edits against the independent check outcomes above');
    expect(output).not.toContain('obtain fresh independent validation');
  });

  it('distinguishes a confident worker recommendation from an exhausted candidate', async () => {
    const initial = state(); initial.codexCalls = 2;
    const output = formatApprovalLines(await context(initial)).join('\n');
    expect(output).toContain('Policy selected: CALL_CODEX\n');
    expect(output).toContain('Candidate unavailable: CALL_CODEX');
    expect(output).toContain('Safe candidate: ASK_USER');
    expect(output).toContain('Codex call limit exhausted');
    expect(output).toContain('Worker selection: codex only');
    expect(output).toContain('Allowed alternatives: ASK_USER');
  });

  it('explains an excluded worker without redirecting or promoting its recommendation', async () => {
    const view = await context(state(), evaluation('CALL_CLAUDE'));
    const output = formatApprovalLines(view).join('\n');
    expect(output).toContain('Evaluator requested: CALL_CLAUDE');
    expect(output).toContain('reported confidence: 0.99');
    expect(output).toContain('worker selection for this run excludes');
    expect(output).toContain('Safe candidate: ASK_USER');
    expect(output).toContain('Allowed alternatives: ASK_USER');
  });

  it.each(['needsMoreInformation', 'stuck'] as const)('explains %s even after all checks pass', async (field) => {
    const initial = state(); pass(initial);
    const result = evaluation('FINISH', 0.99, 0.99);
    result.assessment[field].probability = 0.99;
    const output = formatApprovalLines(await context(initial, result)).join('\n');
    expect(output).toContain('Policy selected: ASK_USER (override)');
    expect(output).toContain(field === 'stuck' ? 'stuck: 0.99' : 'Needs information: 0.99');
    expect(output).toContain('To provide context, enter approve');
    expect(output).not.toContain('Completion review is available');
  });

  it.each(['missing_check', 'omitted_requirements', 'unknown_manager', 'inspection'] as const)('explains the %s completion blocker', async (condition) => {
    const initial = state(); pass(initial);
    if (condition === 'missing_check') initial.evidence!.issue!.requestedValidationScripts.push('test:missing');
    if (condition === 'omitted_requirements') initial.evidence!.issue!.validationRequirementsTruncated = true;
    if (condition === 'unknown_manager') { initial.tests = { ran: false }; initial.evidence!.validations = []; initial.repo.packageManager = 'unknown'; }
    if (condition === 'inspection') initial.evidence!.repoRefreshRequired = true;
    const view = await context(initial, evaluation('FINISH', 0.99, 0.99));
    const output = formatApprovalLines(view).join('\n');
    const reason = { missing_check: 'no declared runnable coverage', omitted_requirements: 'omitted validation requirements',
      unknown_manager: 'no supported package manager', inspection: 'repository inspection requires recovery' }[condition];
    expect(output).toContain(reason);
    expect(output).not.toContain('Completion review is available');
    expect(output).toContain('Safe candidate: ASK_USER');
  });

  it('redacts and bounds report text while preserving parseable approval parameters', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'display-test-secret-value');
    const view = await context(state());
    view.policy.reason = '\u001b[2J' + 'display-test-secret-value ' + 'x'.repeat(2_000) + '\nSafe candidate: FINISH';
    view.evaluation.servedModel = 'fixture\nAPPROVED\u001b[2J';
    if (view.proposal.action !== 'CALL_CODEX') throw new Error('Expected worker candidate.');
    view.proposal.input.task = 'Preserve \u009b2J display-test-secret-value\nlines';
    const before = structuredClone(view);
    const lines = formatApprovalLines(view);
    const output = lines.join('\n');
    expect(output).not.toContain('display-test-secret-value');
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u009b');
    expect(lines.find((line) => line.startsWith('Reason: '))!.length).toBeLessThan(450);
    expect(lines).not.toContain('APPROVED');
    const parameterLine = lines.find((line) => line.startsWith('Parameters: '))!;
    expect(JSON.parse(parameterLine.slice('Parameters: '.length)).task).toBe('Preserve \u009b2J [REDACTED]\nlines');
    expect(view).toEqual(before);
  });

  it('bounds the list of checks without suggesting the omitted entries passed', () => {
    const initial = state();
    initial.repo.validationScripts = Array.from({ length: 40 }, (_, index) => `test:case${index}`);
    initial.evidence!.issue!.requestedValidationScripts = [];
    const output = formatProgressLines(initial).join('\n');
    expect(output).toContain('+32 more');
    expect(output).toContain('test:case0: pending');
    expect(output.length).toBeLessThan(2_000);
  });
});

describe('terminal explanations and recovery', () => {
  it.each(['finished', 'stopped', 'iteration_limit', 'evaluation_failed'] as OrchestrationStatus[])('explains the %s boundary without authorizing another action', (status) => {
    const initial = state(); if (status === 'finished' || status === 'iteration_limit') pass(initial);
    const result = { status, iterations: 8, state: initial, tracePath: '/fixture/trace.jsonl', summary: createRunMetrics().summary(initial) };
    const before = structuredClone(result);
    const output = formatOutcomeLines(result).join('\n');
    if (status === 'finished') expect(output).toContain('Task acceptance: approved');
    else expect(output).toContain('A new invocation starts a separate run with its own approvals');
    if (status === 'iteration_limit') expect(output).toContain('All required independent checks passed, but acceptance review did not complete');
    if (status === 'evaluation_failed') expect(output).toContain('no action was approved from the failed evaluation');
    expect(result).toEqual(before);
  });

  it('does not treat older generation validation as a passed terminal result', () => {
    const initial = state(); pass(initial, 0); initial.evidence!.validationGeneration = 1; initial.tests = { ran: false };
    const output = formatOutcomeLines({ status: 'iteration_limit', iterations: 8, state: initial,
      tracePath: '/fixture/trace.jsonl', summary: createRunMetrics().summary(initial) }).join('\n');
    expect(output).toContain('test: pending, lint: pending');
    expect(output).not.toContain('All required independent checks passed');
  });

  it('separates an explicit recovery from action approval and retains limits', () => {
    const initial = state(); initial.codexCalls = 1;
    const output = formatRecoveryLines({ state: initial, remainingIterations: 2, tracePath: '/fixture/trace.jsonl',
      failure: evaluationFailure(new EvaluationError('invalid_response', 'Invalid.')) }).join('\n');
    expect(output).toContain('No candidate or action approval came from the failed evaluation');
    expect(output).toContain('consumes another iteration. 2 iterations remain');
    expect(output).toContain('Codex 1/2');
    expect(output).toContain('Provider/model selection and worker/network permissions remain fixed');
    expect(output).not.toContain('failed the sum check');
    expect(output).toContain('Enter continue to reevaluate, or stop');
  });

  it('explains rejected totals without promising that another evaluation will succeed', () => {
    const output = formatRecoveryLines({ state: state(), remainingIterations: 2, tracePath: '/fixture/trace.jsonl',
      failure: { code: 'invalid_response', stage: 'distribution', category: 'sum', probabilitySum: 0.99 } }).join('\n');
    expect(output).toContain('probabilities failed the sum check; they were not adjusted');
    expect(output).toContain('A fresh evaluation may fail again');
    expect(output).toContain('consumes another iteration. 2 iterations remain');
  });
});

describe('display-only review metadata in the real loop', () => {
  it('tracks recovery, manual routing, and approval separately without changing budgets or trace schemas', async () => {
    const views: ApprovalContext[] = [];
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: 'Implementation ready; validation pending.', stderr: '', timedOut: false }));
    const initial = state();
    const result = await runOrchestration(initial, {
      evaluate: async (current) => {
        if (current.iteration === 1) throw new EvaluationError('invalid_response', 'Invalid.');
        return current.iteration === 2 ? evaluation('CALL_CODEX', 0.1) : evaluation('FINISH', 0.99, 0.99);
      },
      recoverEvaluation: async () => 'continue', askForInformation: vi.fn(),
      approve: async (view) => {
        views.push(structuredClone(view));
        formatApprovalLines(view);
        if (views.length === 1) {
          Object.assign(view.review!, { iterationLimit: 999, requested: 'CALL_CLAUDE' });
          Object.assign(view.review!.counts, { approvals: 999, alternatives: 999, evaluationRecoveries: 999 });
          return { kind: 'alternative', action: 'CALL_CODEX' };
        }
        return { kind: views.length === 2 ? 'approve' : 'stop' };
      },
      execute: (proposal, _runner, options) => executeCandidate(proposal, runner, options),
    }, { maxIterations: 3 });
    expect(views.map((view) => view.review)).toEqual([
      { source: 'policy', requested: 'ASK_USER', iterationLimit: 3, counts: { approvals: 0, alternatives: 0, evaluationRecoveries: 1 } },
      { source: 'alternative', requested: 'CALL_CODEX', iterationLimit: 3, counts: { approvals: 0, alternatives: 1, evaluationRecoveries: 1 } },
      { source: 'policy', requested: 'RUN_TESTS', iterationLimit: 3, counts: { approvals: 1, alternatives: 1, evaluationRecoveries: 1 } },
    ]);
    expect(formatApprovalLines(views[1]!).join('\n')).toContain('Manual alternative requested: CALL_CODEX; original policy selection: ASK_USER');
    expect(result).toMatchObject({ status: 'stopped', iterations: 3, state: { codexCalls: 1, claudeCalls: 0 },
      summary: { counts: { approvals: 1, alternatives: 1, evaluationRecoveries: 1 } } });
    expect(runner).toHaveBeenCalledOnce();
    const trace = (await readFile(result.tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(trace.every((record) => record.schemaVersion === 2)).toBe(true);
    expect(JSON.stringify(trace)).not.toContain('"review":');
    expect(JSON.stringify(result.state)).not.toContain('"review":');
    expect(trace[2].evaluation.assessment.nextAction.confidence).toBe(0.1);
  });

  it('re-presents an unresolved manual alternative with its own blocker and no execution', async () => {
    const outputs: string[] = [];
    const runner = vi.fn();
    const result = await runOrchestration(state(), {
      evaluate: async () => evaluation('CALL_CODEX', 0.1), askForInformation: vi.fn(),
      approve: async (view) => {
        outputs.push(formatApprovalLines(view).join('\n'));
        return outputs.length === 1 ? { kind: 'alternative', action: 'READ_FILE' } : { kind: 'stop' };
      },
      execute: (proposal, _runner, options) => executeCandidate(proposal, runner, options),
    });
    expect(result.status).toBe('stopped');
    expect(outputs[1]).toContain('Manual alternative requested: READ_FILE');
    expect(outputs[1]).toContain('Candidate unavailable: READ_FILE');
    expect(outputs[1]).toContain('No safe unread repository file');
    expect(outputs[1]).toContain('Safe candidate: ASK_USER');
    expect(runner).not.toHaveBeenCalled();
  });
});
