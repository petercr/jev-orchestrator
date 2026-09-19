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

  if (
    assessment.taskComplete.probability >= thresholds.finish &&
    state.tests.ran &&
    state.tests.passed === true
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
    state.repo.validationScripts.length > 0
  ) {
    return {
      requested,
      selected: 'RUN_TESTS',
      override: requested !== 'RUN_TESTS',
      reason: 'Testing is indicated and the repository exposes validation scripts.',
    };
  }

  if (requested === 'FINISH') {
    return {
      requested,
      selected: state.repo.validationScripts.length > 0 ? 'RUN_TESTS' : 'ASK_USER',
      override: true,
      reason: 'Policy blocks completion until validation passes.',
    };
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
