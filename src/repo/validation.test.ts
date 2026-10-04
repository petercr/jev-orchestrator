import { describe, expect, it } from 'vitest';
import { applyPolicy } from '../policy.js';
import { createInitialState } from '../orchestration/loop.js';
import { selectCandidate } from '../orchestration/candidate.js';
import { mockEvaluation } from '../mock.js';
import { hasPassedValidation, pendingValidationScripts, validationWorkflow } from './validation.js';

function state(comprehensive = false) {
  const scripts = ['test', 'typecheck', 'verify'];
  const initial = createInitialState({
    root: '/repo', packageManager: 'npm', scripts, validationScripts: scripts,
    gitStatus: [], topLevelFiles: [],
    ...validationWorkflow(scripts, { verify: comprehensive ? 'npm run typecheck && npm test' : 'some-custom-check' }, 'npm'),
  }, 'Rename config');
  initial.tests = { ran: true, passed: true };
  return initial;
}

describe('required independent validation', () => {
  it('blocks confident completion and the next candidate advances to a pending check', async () => {
    const initial = state();
    initial.evidence!.validations = [{ iteration: 1, generation: 0, script: 'test', passed: true, timedOut: false, exitCode: 0, summary: 'passed' }];
    const assessment = mockEvaluation().assessment;
    assessment.taskComplete.probability = 0.99;
    assessment.nextAction = { choice: 'FINISH', probabilities: { FINISH: 1 }, confidence: 0.99 };
    expect(pendingValidationScripts(initial)).toEqual(['verify', 'typecheck']);
    expect(applyPolicy(initial, assessment).selected).toBe('RUN_TESTS');
    await expect(selectCandidate('RUN_TESTS', initial)).resolves.toMatchObject({ input: { script: 'verify' } });
    initial.evidence!.validations.push({ iteration: 2, generation: 0, script: 'verify', passed: true, timedOut: false, exitCode: 0, summary: 'passed' });
    expect(hasPassedValidation(initial)).toBe(false);
    await expect(selectCandidate('RUN_TESTS', initial)).resolves.toMatchObject({ input: { script: 'typecheck' } });
    initial.evidence!.validations.push({ iteration: 3, generation: 0, script: 'typecheck', passed: true, timedOut: false, exitCode: 0, summary: 'passed' });
    expect(applyPolicy(initial, assessment).selected).toBe('FINISH');
    initial.evidence!.validationGeneration += 1;
    expect(applyPolicy(initial, assessment).selected).toBe('RUN_TESTS');
  });

  it('credits a passing declared conjunction and requires diagnosis after a subsequent failed check', () => {
    const initial = state(true);
    initial.evidence!.validations = [{ iteration: 1, generation: 0, script: 'verify', passed: true, timedOut: false, exitCode: 0, summary: 'all passed' }];
    expect(pendingValidationScripts(initial)).toEqual([]);
    expect(hasPassedValidation(initial)).toBe(true);
    initial.evidence!.validations.push({ iteration: 2, generation: 0, script: 'test', passed: false, timedOut: false, exitCode: 1, summary: 'failed' });
    expect(pendingValidationScripts(initial)).toEqual(['test']);
    const assessment = mockEvaluation().assessment;
    assessment.nextAction.choice = 'FINISH';
    expect(applyPolicy(initial, assessment).selected).toBe('ASK_USER');
  });

  it('does not propose a passed script again through a manual validation alternative', async () => {
    const initial = state(true);
    initial.evidence!.validations = [{ iteration: 1, generation: 0, script: 'verify', passed: true, timedOut: false, exitCode: 0, summary: 'all passed' }];
    await expect(selectCandidate('RUN_TESTS', initial)).resolves.toMatchObject({ action: 'ASK_USER' });
    initial.evidence!.validationGeneration += 1;
    initial.tests = { ran: false };
    await expect(selectCandidate('RUN_TESTS', initial)).resolves.toMatchObject({ action: 'RUN_TESTS', input: { script: 'verify' } });
  });

  it.each(['npm test || true', 'npm test; npm run typecheck', 'npm run test -- --watch', '$(npm test)', 'pnpm test', 'npm test && echo ok', 'npm test | cat'])('does not infer coverage from %s', (command) => {
    expect(validationWorkflow(['test', 'verify'], { verify: command }, 'npm').validationScriptCoverage?.verify).toEqual(['verify']);
  });

  it('bounds cycles and transitive aliases without counting non-validation scripts', () => {
    expect(validationWorkflow(['verify', 'check', 'test'], { verify: 'npm run check', check: 'npm run verify && npm test && npm run deploy' }, 'npm')
      .validationScriptCoverage?.verify).toEqual(['verify', 'check', 'test']);
  });

  it.each(['bun', 'yarn', 'pnpm'] as const)('does not mistake bare %s builtin commands for declared script calls', (manager) => {
    expect(validationWorkflow(['test', 'verify'], { verify: `${manager} test` }, manager).validationScriptCoverage?.verify).toEqual(['verify']);
    expect(validationWorkflow(['test', 'verify'], { verify: `${manager} run test` }, manager).validationScriptCoverage?.verify).toEqual(['verify', 'test']);
  });

  it('keeps unavailable issue-required checks pending and does not select arbitrary scripts', async () => {
    const initial = createInitialState({ root: '/repo', packageManager: 'npm', scripts: ['deploy'], validationScripts: [], gitStatus: [], topLevelFiles: [] }, 'Task');
    initial.evidence!.issue = { url: 'https://github.com/o/r/issues/1', title: 'Task', body: 'npm run verify', requestedValidationScripts: ['verify'], truncated: false };
    expect(pendingValidationScripts(initial)).toEqual(['verify']);
    await expect(selectCandidate('RUN_TESTS', initial)).resolves.toMatchObject({ action: 'ASK_USER' });
    expect(hasPassedValidation(initial)).toBe(false);
  });

  it('requires context when the issue reader omitted further validation criteria', () => {
    const initial = state(true);
    initial.evidence!.validations = [{ iteration: 1, generation: 0, script: 'verify', passed: true, timedOut: false, exitCode: 0, summary: 'passed' }];
    initial.evidence!.issue = { url: 'https://github.com/o/r/issues/1', title: 'Task', body: '', requestedValidationScripts: [], validationRequirementsTruncated: true, truncated: false };
    const assessment = mockEvaluation().assessment;
    assessment.taskComplete.probability = 0.99;
    assessment.nextAction.choice = 'FINISH';
    expect(hasPassedValidation(initial)).toBe(false);
    expect(applyPolicy(initial, assessment).selected).toBe('ASK_USER');
  });

  it('requires extra checks from supplied context and keeps missing checks pending', async () => {
    const initial = state(true);
    initial.evidence!.clarifications = [{ iteration: 2, text: 'Issue context: fix config and run npm run check:docs; then npm run deploy.' }];
    initial.evidence!.validations = [{ iteration: 3, generation: 0, script: 'verify', passed: true, timedOut: false, exitCode: 0, summary: 'passed' }];
    expect(pendingValidationScripts(initial)).toEqual(['check:docs']);
    expect(hasPassedValidation(initial)).toBe(false);
    await expect(selectCandidate('RUN_TESTS', initial)).resolves.toMatchObject({ action: 'ASK_USER' });
    initial.repo.validationScripts.push('check:docs');
    await expect(selectCandidate('RUN_TESTS', initial)).resolves.toMatchObject({ input: { script: 'check:docs' } });
    initial.evidence!.validations.push({ iteration: 4, generation: 0, script: 'check:docs', passed: true, timedOut: false, exitCode: 0, summary: 'passed' });
    expect(hasPassedValidation(initial)).toBe(true);
  });

  it('cannot complete when bounded supplied context omitted validation requirements', () => {
    const initial = state(true);
    const extraScripts = Array.from({ length: 9 }, (_, index) => `check:extra${index}`);
    initial.evidence!.clarifications = [{ iteration: 2, text: extraScripts.map((script) => `npm run ${script}`).join(', ') }];
    initial.evidence!.validations = ['verify', ...extraScripts].map((script) => ({ iteration: 3, generation: 0, script, passed: true, timedOut: false, exitCode: 0, summary: 'passed' }));
    expect(pendingValidationScripts(initial)).toEqual([]);
    expect(hasPassedValidation(initial)).toBe(false);
    const assessment = mockEvaluation().assessment;
    assessment.taskComplete.probability = 0.99;
    assessment.nextAction = { choice: 'FINISH', probabilities: { FINISH: 1 }, confidence: 0.99 };
    expect(applyPolicy(initial, assessment)).toMatchObject({ selected: 'ASK_USER', reason: expect.stringContaining('omitted validation requirements') });
  });
});
