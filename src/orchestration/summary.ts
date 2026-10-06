import type { AgentState } from '../types.js';
import {
  hasOmittedValidationRequirements,
  hasPassedValidation,
  validationChecks,
  type ValidationCheck,
} from '../repo/validation.js';
import type { ApprovalDecision } from './loop.js';
import type { ExecutableAction } from './candidate.js';
import type { ToolResult } from './execute.js';

const TIMING_PHASES = [
  'evaluationMs', 'preparationMs', 'workerMs', 'validationMs',
  'approvalWaitMs', 'informationWaitMs', 'recoveryWaitMs', 'inspectionMs', 'diagnosticsMs',
] as const;

type TimingPhase = typeof TIMING_PHASES[number];

export type RunTimings = Record<TimingPhase, number> & {
  elapsedMs: number;
  activeMs: number;
  otherMs: number;
};

export type RunCounts = {
  evaluations: number;
  evaluationFailures: number;
  evaluationRecoveries: number;
  approvalRequests: number;
  approvals: number;
  rejections: number;
  alternatives: number;
  codexCalls: number;
  claudeCalls: number;
  workerRetries: number;
  validationRuns: number;
  validationFailures: number;
  failedExecutions: number;
  timedOutExecutions: number;
  cancelledExecutions: number;
};

export type RunMetrics = { timings: RunTimings; counts: RunCounts };

export type RunSummary = RunMetrics & {
  validation: {
    generation: number;
    passed: boolean;
    checks: ValidationCheck[];
    requirementsOmitted: boolean;
    repoRefreshRequired: boolean;
  };
};

export function executionTimingPhase(action: ExecutableAction): TimingPhase {
  if (action === 'CALL_CODEX' || action === 'CALL_CLAUDE') return 'workerMs';
  if (action === 'RUN_TESTS') return 'validationMs';
  if (action === 'RUN_COMMAND') return 'diagnosticsMs';
  return 'preparationMs';
}

/** Local elapsed times and counters are reporting data, never policy input. */
export function createRunMetrics(initialInspectionMs: number = 0) {
  if (!Number.isFinite(initialInspectionMs) || initialInspectionMs < 0) {
    throw new Error('Initial inspection duration must be finite and nonnegative.');
  }
  const startedAt = performance.now();
  const durations: Record<TimingPhase, number> = {
    evaluationMs: 0, preparationMs: 0, workerMs: 0, validationMs: 0,
    approvalWaitMs: 0, informationWaitMs: 0, recoveryWaitMs: 0,
    inspectionMs: initialInspectionMs, diagnosticsMs: 0,
  };
  const counts: RunCounts = {
    evaluations: 0, evaluationFailures: 0, evaluationRecoveries: 0,
    approvalRequests: 0, approvals: 0, rejections: 0, alternatives: 0,
    codexCalls: 0, claudeCalls: 0, workerRetries: 0,
    validationRuns: 0, validationFailures: 0, failedExecutions: 0,
    timedOutExecutions: 0, cancelledExecutions: 0,
  };
  const snapshot = (): RunMetrics => {
    const phases = { ...durations };
    for (const phase of TIMING_PHASES) phases[phase] = Math.floor(phases[phase]);
    const elapsedMs = Math.floor(Math.max(0, performance.now() - startedAt) + initialInspectionMs);
    const waitMs = phases.approvalWaitMs + phases.informationWaitMs + phases.recoveryWaitMs;
    return {
      timings: {
        ...phases,
        elapsedMs,
        activeMs: Math.max(0, elapsedMs - waitMs),
        otherMs: Math.max(0, elapsedMs - TIMING_PHASES.reduce((sum, phase) => sum + phases[phase], 0)),
      },
      counts: { ...counts },
    };
  };
  return {
    counts,
    async measure<T>(phase: TimingPhase, operation: () => Promise<T>): Promise<T> {
      const start = performance.now();
      try {
        return await operation();
      } finally {
        durations[phase] += Math.max(0, performance.now() - start);
      }
    },
    recordApproval(decision: ApprovalDecision): void {
      if (decision.kind === 'approve') counts.approvals += 1;
      if (decision.kind === 'reject') counts.rejections += 1;
      if (decision.kind === 'alternative') counts.alternatives += 1;
    },
    recordExecution(action: ExecutableAction): void {
      if (action === 'CALL_CODEX' || action === 'CALL_CLAUDE') {
        const key = action === 'CALL_CODEX' ? 'codexCalls' : 'claudeCalls';
        if (counts[key] > 0) counts.workerRetries += 1;
        counts[key] += 1;
      }
      if (action === 'RUN_TESTS') counts.validationRuns += 1;
    },
    recordResult(result: ToolResult): void {
      if (!result.ok) counts.failedExecutions += 1;
      if (result.action === 'RUN_TESTS' && !result.ok) counts.validationFailures += 1;
      if (result.timedOut) counts.timedOutExecutions += 1;
      if (result.cancelled) counts.cancelledExecutions += 1;
    },
    snapshot,
    summary(state: AgentState): RunSummary {
      return {
        ...snapshot(),
        validation: {
          generation: state.evidence?.validationGeneration ?? 0,
          passed: hasPassedValidation(state),
          checks: validationChecks(state),
          requirementsOmitted: hasOmittedValidationRequirements(state),
          repoRefreshRequired: state.evidence?.repoRefreshRequired === true,
        },
      };
    },
  };
}

export type RunMetricsCollector = ReturnType<typeof createRunMetrics>;
