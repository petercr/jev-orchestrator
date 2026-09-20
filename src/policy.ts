import type { AgentAssessment, AgentState, PolicyDecision } from './types.js';

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

function hasPassedValidation(state: AgentState): boolean {
  return (
    state.repo.validationScripts.length > 0 &&
    state.tests.ran &&
    state.tests.passed === true
  );
}

function requireValidation(
  state: AgentState,
  requested: PolicyDecision['requested'],
): PolicyDecision {
  if (state.repo.validationScripts.length === 0) {
    return {
      requested,
      selected: 'ASK_USER',
      override: requested !== 'ASK_USER',
      reason: 'No detected validation script can provide the evidence required for completion.',
    };
  }

  if (state.tests.ran && state.tests.passed === false) {
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
    reason: 'Policy requires a passing validation run before completion.',
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

  if (
    assessment.needsTesting.probability >= thresholds.test &&
    !hasPassedValidation(state)
  ) {
    return requireValidation(state, requested);
  }

  if (requested === 'FINISH') {
    if (hasPassedValidation(state)) {
      return {
        requested,
        selected: 'ASK_USER',
        override: true,
        reason: 'Completion confidence does not clear the finish threshold.',
      };
    }

    return requireValidation(state, requested);
  }

  if (
    selectedProbability < thresholds.minChoiceProbability ||
    confidence < thresholds.minChoiceConfidence
  ) {
    return {
      requested,
      selected: 'ASK_USER',
      override: requested !== 'ASK_USER',
      reason: 'The next-action distribution is too ambiguous for autonomous execution.',
    };
  }

  return {
    requested,
    selected: requested,
    override: false,
    reason: 'Jev recommendation clears the deterministic policy thresholds.',
  };
}
