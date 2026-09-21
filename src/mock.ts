import type { Action, AgentState, EvaluationResult } from './types.js';

function probabilitiesFor(choice: Action): Partial<Record<Action, number>> {
  return {
    SEARCH_REPO: choice === 'SEARCH_REPO' ? 0.68 : 0.04,
    READ_FILE: choice === 'READ_FILE' ? 0.68 : 0.04,
    RUN_COMMAND: 0.02,
    RUN_TESTS: choice === 'RUN_TESTS' ? 0.68 : 0.04,
    CALL_CODEX: 0.02,
    CALL_CLAUDE: 0.02,
    ASK_USER: choice === 'ASK_USER' ? 0.68 : 0.03,
    FINISH: choice === 'FINISH' ? 0.68 : 0.01,
  };
}

export function mockEvaluation(state?: AgentState): EvaluationResult {
  let choice: Action = 'SEARCH_REPO';
  let taskComplete = 0.02;
  let needsMoreInformation = 0.08;
  let needsTesting = 0.09;

  if (state?.tests.passed === true) {
    choice = 'FINISH';
    taskComplete = 0.98;
    needsTesting = 0.02;
  } else if (state?.tests.ran === true && state.tests.passed === false) {
    choice = 'ASK_USER';
    needsMoreInformation = 0.95;
    needsTesting = 0.9;
  } else if ((state?.filesRead.length ?? 0) > 0) {
    choice = 'RUN_TESTS';
    needsTesting = 0.9;
  } else if (state?.observations.some((observation) => observation.startsWith('Search completed:'))) {
    choice = 'READ_FILE';
  }

  return {
    assessment: {
      taskComplete: { probability: taskComplete },
      needsMoreInformation: { probability: needsMoreInformation },
      needsTesting: { probability: needsTesting },
      stuck: { probability: 0.01 },
      nextAction: {
        choice,
        probabilities: probabilitiesFor(choice),
        confidence: 0.71,
      },
    },
    model: 'mock/jev',
    latencyMs: 0,
    rawAnswers: { mock: true },
  };
}
