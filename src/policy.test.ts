import { describe, expect, it } from 'vitest';
import { applyPolicy } from './policy.js';
import type { AgentAssessment, AgentState } from './types.js';

const state: AgentState = {
  task: 'Fix the bug',
  iteration: 1,
  currentGoal: 'Choose next action',
  repo: {
    root: '/repo',
    packageManager: 'pnpm',
    scripts: ['test'],
    validationScripts: ['test'],
    gitStatus: [],
    topLevelFiles: ['package.json'],
  },
  filesRead: [],
  filesModified: [],
  observations: [],
  commandsRun: [],
  tests: { ran: false },
  failedApproaches: [],
  codexCalls: 0,
};

function assessment(overrides: Partial<AgentAssessment> = {}): AgentAssessment {
  return {
    taskComplete: { probability: 0.05 },
    needsMoreInformation: { probability: 0.05 },
    needsTesting: { probability: 0.05 },
    stuck: { probability: 0.05 },
    nextAction: {
      choice: 'SEARCH_REPO',
      probabilities: { SEARCH_REPO: 0.8 },
      confidence: 0.7,
    },
    ...overrides,
  };
}

describe('applyPolicy', () => {
  it('accepts a clear, safe recommendation', () => {
    expect(applyPolicy(state, assessment()).selected).toBe('SEARCH_REPO');
  });

  it('forces tests when the state should be validated', () => {
    const result = applyPolicy(state, assessment({ needsTesting: { probability: 0.92 } }));
    expect(result).toMatchObject({ selected: 'RUN_TESTS', override: true });
  });

  it('blocks premature completion', () => {
    const result = applyPolicy(state, assessment({
      nextAction: {
        choice: 'FINISH',
        probabilities: { FINISH: 0.96 },
        confidence: 0.9,
      },
    }));
    expect(result.selected).toBe('RUN_TESTS');
  });

  it('finishes only after passing validation', () => {
    const validated = { ...state, tests: { ran: true, passed: true } };
    const result = applyPolicy(validated, assessment({
      taskComplete: { probability: 0.98 },
    }));
    expect(result.selected).toBe('FINISH');
  });

  it('asks the user when Jev is ambiguous', () => {
    const result = applyPolicy(state, assessment({
      nextAction: {
        choice: 'READ_FILE',
        probabilities: { READ_FILE: 0.31, SEARCH_REPO: 0.3 },
        confidence: 0.08,
      },
    }));
    expect(result.selected).toBe('ASK_USER');
  });
});
