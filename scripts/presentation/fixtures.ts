import { buildWorkerContext } from '../../src/agents/context.js';
import { applyPolicy } from '../../src/policy.js';
import type { ApprovalContext, OrchestrationResult } from '../../src/orchestration/loop.js';
import type { AgentState, EvaluationResult } from '../../src/types.js';

// Display fixtures only. No orchestration loop, repository inspection, or tool runs.
export function createFixtures(): {
  review: ApprovalContext;
  blocked: ApprovalContext;
  outcome: OrchestrationResult;
} {
  const state: AgentState = {
    task: 'Preserve short labels and add boundary regression tests.',
    workerSelection: 'codex',
    iteration: 3,
    currentGoal: 'Implement the bounded label fix.',
    repo: {
      root: '/workspace/example-project', packageManager: 'pnpm',
      scripts: ['test', 'check'], validationScripts: ['test', 'check'],
      gitStatus: [], topLevelFiles: ['AGENTS.md', 'package.json', 'src'],
    },
    filesRead: ['AGENTS.md'], filesModified: [], observations: [], commandsRun: [],
    tests: { ran: false }, failedApproaches: [], codexCalls: 0, claudeCalls: 0,
    evidence: {
      revision: 1, validationGeneration: 0, clarifications: [], findings: [],
      failures: [], validations: [],
    },
  };
  const evaluation: EvaluationResult = {
    provider: 'mock', model: 'synthetic/preview', requestedModel: 'synthetic/preview',
    latencyMs: 0, rawAnswers: {},
    assessment: {
      taskComplete: { probability: 0.01 }, needsMoreInformation: { probability: 0.02 },
      needsTesting: { probability: 0.02 }, stuck: { probability: 0.01 },
      nextAction: { choice: 'CALL_CODEX', confidence: 0.99, probabilities: { CALL_CODEX: 1 } },
    },
  };
  const review: ApprovalContext = {
    state, evaluation, policy: applyPolicy(state, evaluation.assessment),
    proposal: {
      action: 'CALL_CODEX', tool: 'codex_cli',
      input: { root: state.repo.root, task: state.task, context: buildWorkerContext(state) },
    },
    allowedAlternatives: ['ASK_USER', 'RUN_TESTS'],
    review: {
      source: 'policy', requested: 'CALL_CODEX', iterationLimit: 8,
      counts: { approvals: 2, alternatives: 0, evaluationRecoveries: 0 },
    },
  };

  const blockedState = structuredClone(state);
  blockedState.iteration = 7;
  blockedState.codexCalls = 2;
  blockedState.tests = { ran: true, passed: false };
  blockedState.filesModified = ['src/label.ts', 'src/label.test.ts'];
  blockedState.evidence!.validationGeneration = 2;
  blockedState.evidence!.validations = [{
    iteration: 6, generation: 2, script: 'test', exitCode: 1,
    timedOut: false, passed: false, summary: 'The 11-character boundary regression still fails.',
  }];
  const blocked: ApprovalContext = {
    state: blockedState, evaluation, policy: applyPolicy(blockedState, evaluation.assessment),
    proposal: {
      action: 'ASK_USER', tool: null, input: null,
      reason: 'Codex call limit exhausted. Review the saved patch and failed independent check.',
    },
    allowedAlternatives: ['ASK_USER'],
    review: {
      source: 'policy', requested: 'CALL_CODEX', iterationLimit: 8,
      counts: { approvals: 6, alternatives: 0, evaluationRecoveries: 0 },
    },
  };

  const finished = structuredClone(state);
  finished.iteration = 6;
  finished.codexCalls = 1;
  finished.filesModified = ['src/label.ts', 'src/label.test.ts'];
  finished.tests = { ran: true, passed: true };
  finished.evidence!.validationGeneration = 1;
  finished.evidence!.validations = ['test', 'check'].map((script, index) => ({
    iteration: 4 + index, generation: 1, script, exitCode: 0,
    timedOut: false, passed: true, summary: 'Synthetic independent check passed.',
  }));
  const outcome: OrchestrationResult = {
    status: 'finished', state: finished, iterations: 6,
    tracePath: '(synthetic; no trace written)',
    summary: {
      timings: {
        elapsedMs: 54_300, activeMs: 34_300, evaluationMs: 1_600,
        preparationMs: 200, workerMs: 24_000, validationMs: 7_000,
        inspectionMs: 1_000, diagnosticsMs: 0, otherMs: 500,
        approvalWaitMs: 20_000, informationWaitMs: 0, recoveryWaitMs: 0,
      },
      counts: {
        evaluations: 6, evaluationFailures: 0, evaluationRecoveries: 0,
        approvalRequests: 6, approvals: 6, rejections: 0, alternatives: 0,
        codexCalls: 1, claudeCalls: 0, workerRetries: 0, validationRuns: 2,
        validationFailures: 0, failedExecutions: 0, timedOutExecutions: 0,
        cancelledExecutions: 0,
      },
      validation: {
        generation: 1, passed: true, requirementsOmitted: false, repoRefreshRequired: false,
        checks: ['test', 'check'].map((script) => ({ script, status: 'passed' })),
      },
    },
  };
  return { review, blocked, outcome };
}
