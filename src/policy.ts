import type { AgentAssessment, AgentState, PolicyDecision } from './types.js';
import { hasFailedValidation, hasOmittedValidationRequirements, hasPassedValidation, pendingValidationScripts } from './repo/validation.js';
import { taskPreparation } from './repo/preparation.js';
import { availableWorkerActions, isWorkerActionAllowed } from './agents/selection.js';

export type PolicyThresholds = {
  finish: number;
  test: number;
  askUser: number;
  minChoiceProbability: number;
  minChoiceConfidence: number;
};

export const DEFAULT_THRESHOLDS: PolicyThresholds = {
  finish: 0.95,
  test: 0.8,
  askUser: 0.9,
  minChoiceProbability: 0.55,
  minChoiceConfidence: 0.35,
};

function hasWorkerRepairEvidence(state: AgentState, requested: PolicyDecision['requested']): boolean {
  const evidence = state.evidence;
  if (!evidence?.worker) return false;
  const worker = evidence.worker;
  if (requested !== (worker.agent === 'codex' ? 'CALL_CODEX' : 'CALL_CLAUDE') ||
    !availableWorkerActions(state).some((action) => action === requested) ||
    hasOmittedValidationRequirements(state) || !hasFailedValidation(state)) return false;
  // A worker claim or an old failure cannot justify another attempt. The
  // independent check must follow this worker and belong to its generation.
  const checks = evidence.validations ?? (evidence.validation ? [evidence.validation] : []);
  return checks.some((check) => check.generation === evidence.validationGeneration &&
    check.iteration > worker.iteration && check.iteration < state.iteration &&
    (!check.passed || check.exitCode !== 0 || check.timedOut));
}

function requireValidation(
  state: AgentState,
  requested: PolicyDecision['requested'],
): PolicyDecision {
  if (hasOmittedValidationRequirements(state)) {
    return {
      requested, selected: 'ASK_USER', override: requested !== 'ASK_USER',
      reason: 'The bounded task context omitted validation requirements; more context is needed before completion.',
    };
  }
  if (state.repo.validationScripts.length === 0) {
    return {
      requested,
      selected: 'ASK_USER',
      override: requested !== 'ASK_USER',
      reason: 'No detected validation script can provide the evidence required for completion.',
    };
  }

  if (hasFailedValidation(state)) {
    return {
      requested,
      selected: 'ASK_USER',
      override: requested !== 'ASK_USER',
      reason: 'Validation failed and requires diagnosis before another test run.',
    };
  }

  return {
    requested,
    selected: 'RUN_TESTS',
    override: requested !== 'RUN_TESTS',
    reason: `Policy requires passing independent validation before completion: ${pendingValidationScripts(state).join(', ')}.`,
  };
}

export function applyPolicy(
  state: AgentState,
  assessment: AgentAssessment,
  thresholds: PolicyThresholds = DEFAULT_THRESHOLDS,
): PolicyDecision {
  const requested = assessment.nextAction.choice;
  const selectedProbability = assessment.nextAction.probabilities[requested] ?? 0;
  const confidence = assessment.nextAction.confidence ?? 0;
  const clearRouting = selectedProbability >= thresholds.minChoiceProbability &&
    confidence >= thresholds.minChoiceConfidence;

  if (state.evidence?.repoRefreshRequired) {
    return {
      requested,
      selected: 'ASK_USER',
      override: requested !== 'ASK_USER',
      reason: 'Repository inspection must recover before further execution.',
    };
  }

  if (assessment.needsMoreInformation.probability >= thresholds.askUser) {
    return {
      requested,
      selected: 'ASK_USER',
      override: requested !== 'ASK_USER',
      reason: 'Required external information exceeds the user-question threshold.',
    };
  }

  if (assessment.stuck.probability >= thresholds.askUser) {
    return {
      requested,
      selected: 'ASK_USER',
      override: requested !== 'ASK_USER',
      reason: 'The stuck assessment exceeds the user-question threshold.',
    };
  }

  const preparation = taskPreparation(state);
  if (preparation.nextAction !== null) {
    if (!clearRouting || requested === 'ASK_USER') {
      return {
        requested, selected: 'ASK_USER', override: requested !== 'ASK_USER',
        reason: 'Task context is still pending, but routing requires clarification before a preparatory read.',
      };
    }
    return {
      requested,
      selected: preparation.nextAction,
      override: requested !== preparation.nextAction,
      reason: preparation.nextAction === 'READ_ISSUE'
        ? 'Read the linked issue acceptance criteria before testing or delegation.'
        : preparation.nextAction === 'READ_FILE'
          ? `Read the remaining repository instructions before testing or delegation: ${preparation.unreadInstructions.join(', ')}.`
          : 'The linked issue read failed; ask the user for task context before testing or delegation.',
    };
  }

  if (
    assessment.taskComplete.probability >= thresholds.finish &&
    hasPassedValidation(state)
  ) {
    return {
      requested,
      selected: 'FINISH',
      override: requested !== 'FINISH',
      reason: 'Completion confidence is high and validation has passed.',
    };
  }

  if (!isWorkerActionAllowed(requested, state.workerSelection)) {
    return {
      requested, selected: 'ASK_USER', override: true,
      reason: 'The worker selection for this run excludes the requested coding agent; choose an allowed action.',
    };
  }

  const firstIssueWorker = preparation.issue !== 'not_linked' && clearRouting && !state.tests.ran &&
    state.codexCalls === 0 && state.claudeCalls === 0 && !hasFailedValidation(state) &&
    (requested === 'CALL_CODEX' || requested === 'CALL_CLAUDE');
  if (
    assessment.needsTesting.probability >= thresholds.test &&
    !hasPassedValidation(state) &&
    !firstIssueWorker
  ) {
    if (clearRouting && hasWorkerRepairEvidence(state, requested)) {
      return {
        requested, selected: requested, override: false,
        reason: 'A current-generation independent check failed; the clear recommendation can return to the same worker for repair before fresh validation.',
      };
    }
    return requireValidation(state, requested);
  }

  if (requested === 'FINISH') {
    if (hasPassedValidation(state)) {
      return {
        requested,
        selected: 'ASK_USER',
        override: true,
        reason: 'Completion confidence does not clear the finish threshold.',
        ...(clearRouting ? { completionReview: 'jev_finish' as const } : {}),
      };
    }

    return requireValidation(state, requested);
  }

  if (!clearRouting) {
    return {
      requested,
      selected: 'ASK_USER',
      override: requested !== 'ASK_USER',
      reason: 'The next-action distribution is too ambiguous for autonomous execution.',
    };
  }

  if (requested === 'RUN_TESTS' && hasPassedValidation(state)) {
    return {
      requested,
      selected: 'ASK_USER',
      override: true,
      reason: 'All required independent checks passed for the current generation; review whether the original task acceptance criteria are satisfied.',
      completionReview: 'validation_complete',
    };
  }

  return {
    requested,
    selected: requested,
    override: false,
    reason: 'Evaluator recommendation clears the deterministic policy thresholds.',
  };
}
