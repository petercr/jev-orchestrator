import type { EvaluationResult } from './types.js';

export function mockEvaluation(): EvaluationResult {
  const probabilities = {
    SEARCH_REPO: 0.68,
    READ_FILE: 0.16,
    RUN_COMMAND: 0.04,
    RUN_TESTS: 0.03,
    CALL_CODEX: 0.05,
    ASK_USER: 0.03,
    FINISH: 0.01,
  } as const;

  return {
    assessment: {
      taskComplete: { probability: 0.02 },
      needsMoreInformation: { probability: 0.08 },
      needsTesting: { probability: 0.09 },
      stuck: { probability: 0.01 },
      nextAction: {
        choice: 'SEARCH_REPO',
        probabilities,
        confidence: 0.71,
      },
    },
    model: 'mock/jev',
    latencyMs: 0,
    rawAnswers: { mock: true },
  };
}
