import { describe, expect, it } from 'vitest';
import { applyPolicy, DEFAULT_THRESHOLDS } from './policy.js';
import { ACTIONS, type AgentAssessment, type AgentState, type Action } from './types.js';

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
  claudeCalls: 0,
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
  it.each(ACTIONS.filter((action) => action !== 'FINISH'))(
    'accepts a clear %s recommendation',
    (action) => {
      const result = applyPolicy(state, assessment({
        nextAction: {
          choice: action,
          probabilities: { [action]: 0.8 },
          confidence: 0.7,
        },
      }));

      expect(result).toMatchObject({ selected: action, override: false });
    },
  );

  it('accepts action scores exactly at the ambiguity thresholds', () => {
    const action: Action = 'READ_FILE';
    const result = applyPolicy(state, assessment({
      nextAction: {
        choice: action,
        probabilities: { [action]: DEFAULT_THRESHOLDS.minChoiceProbability },
        confidence: DEFAULT_THRESHOLDS.minChoiceConfidence,
      },
    }));

    expect(result.selected).toBe(action);
  });

  it('asks the user below either ambiguity threshold', () => {
    const lowProbability = applyPolicy(state, assessment({
      nextAction: {
        choice: 'READ_FILE',
        probabilities: {
          READ_FILE: DEFAULT_THRESHOLDS.minChoiceProbability - 0.001,
        },
        confidence: DEFAULT_THRESHOLDS.minChoiceConfidence,
      },
    }));
    const lowConfidence = applyPolicy(state, assessment({
      nextAction: {
        choice: 'READ_FILE',
        probabilities: { READ_FILE: DEFAULT_THRESHOLDS.minChoiceProbability },
        confidence: DEFAULT_THRESHOLDS.minChoiceConfidence - 0.001,
      },
    }));

    expect(lowProbability.selected).toBe('ASK_USER');
    expect(lowConfidence.selected).toBe('ASK_USER');
  });

  it('asks the user when the selected probability or confidence is missing', () => {
    const missingProbability = applyPolicy(state, assessment({
      nextAction: {
        choice: 'READ_FILE',
        probabilities: { SEARCH_REPO: 0.8 },
        confidence: 0.7,
      },
    }));
    const missingConfidence = applyPolicy(state, assessment({
      nextAction: {
        choice: 'READ_FILE',
        probabilities: { READ_FILE: 0.8 },
      },
    }));

    expect(missingProbability.selected).toBe('ASK_USER');
    expect(missingConfidence.selected).toBe('ASK_USER');
  });

  it('forces tests at the testing threshold when validation has not run', () => {
    const result = applyPolicy(state, assessment({
      needsTesting: { probability: DEFAULT_THRESHOLDS.test },
    }));
    expect(result).toMatchObject({ selected: 'RUN_TESTS', override: true });
  });

  it('does not force tests below the testing threshold', () => {
    const result = applyPolicy(state, assessment({
      needsTesting: { probability: DEFAULT_THRESHOLDS.test - 0.001 },
    }));

    expect(result.selected).toBe('SEARCH_REPO');
  });

  it('routes required information to the user at its threshold', () => {
    const result = applyPolicy(state, assessment({
      needsMoreInformation: { probability: DEFAULT_THRESHOLDS.askUser },
    }));

    expect(result).toMatchObject({ selected: 'ASK_USER', override: true });
  });

  it('does not route information just below its threshold to the user', () => {
    const result = applyPolicy(state, assessment({
      needsMoreInformation: { probability: DEFAULT_THRESHOLDS.askUser - 0.001 },
    }));

    expect(result.selected).toBe('SEARCH_REPO');
  });

  it('routes a stuck assessment to the user at its threshold', () => {
    const result = applyPolicy(state, assessment({
      stuck: { probability: DEFAULT_THRESHOLDS.askUser },
    }));

    expect(result).toMatchObject({ selected: 'ASK_USER', override: true });
  });

  it('does not route a stuck assessment just below its threshold to the user', () => {
    const result = applyPolicy(state, assessment({
      stuck: { probability: DEFAULT_THRESHOLDS.askUser - 0.001 },
    }));

    expect(result.selected).toBe('SEARCH_REPO');
  });

  it('blocks premature completion by requesting validation', () => {
    const result = applyPolicy(state, assessment({
      nextAction: {
        choice: 'FINISH',
        probabilities: { FINISH: 0.96 },
        confidence: 0.9,
      },
    }));
    expect(result.selected).toBe('RUN_TESTS');
  });

  it('finishes at the completion threshold after passing validation', () => {
    const validated = { ...state, tests: { ran: true, passed: true } };
    const result = applyPolicy(validated, assessment({
      taskComplete: { probability: DEFAULT_THRESHOLDS.finish },
    }));
    expect(result.selected).toBe('FINISH');
  });

  it('does not finish below the completion threshold', () => {
    const validated = { ...state, tests: { ran: true, passed: true } };
    const result = applyPolicy(validated, assessment({
      taskComplete: { probability: DEFAULT_THRESHOLDS.finish - 0.001 },
    }));

    expect(result.selected).toBe('SEARCH_REPO');
  });

  it('asks the user when finish is requested after failed validation', () => {
    const failed = { ...state, tests: { ran: true, passed: false } };
    const result = applyPolicy(failed, assessment({
      nextAction: {
        choice: 'FINISH',
        probabilities: { FINISH: 0.96 },
        confidence: 0.9,
      },
    }));

    expect(result).toMatchObject({ selected: 'ASK_USER', override: true });
  });

  it('asks the user instead of blindly rerunning failed validation', () => {
    const failed = { ...state, tests: { ran: true, passed: false } };
    const result = applyPolicy(failed, assessment({
      needsTesting: { probability: DEFAULT_THRESHOLDS.test },
    }));

    expect(result).toMatchObject({ selected: 'ASK_USER', override: true });
  });

  it('does not treat an incomplete validation record as a passing result', () => {
    const incomplete = { ...state, tests: { ran: true } };
    const result = applyPolicy(incomplete, assessment({
      nextAction: {
        choice: 'FINISH',
        probabilities: { FINISH: 0.96 },
        confidence: 0.9,
      },
    }));

    expect(result).toMatchObject({ selected: 'RUN_TESTS', override: true });
  });

  it('asks the user when validation is needed but no validation scripts exist', () => {
    const withoutScripts = {
      ...state,
      repo: { ...state.repo, validationScripts: [] },
    };
    const result = applyPolicy(withoutScripts, assessment({
      needsTesting: { probability: DEFAULT_THRESHOLDS.test },
    }));

    expect(result).toMatchObject({ selected: 'ASK_USER', override: true });
  });

  it('asks the user when finish is requested but no validation scripts exist', () => {
    const withoutScripts = {
      ...state,
      repo: { ...state.repo, validationScripts: [] },
      tests: { ran: true, passed: true },
    };
    const result = applyPolicy(withoutScripts, assessment({
      taskComplete: { probability: DEFAULT_THRESHOLDS.finish },
      nextAction: {
        choice: 'FINISH',
        probabilities: { FINISH: 0.96 },
        confidence: 0.9,
      },
    }));

    expect(result).toMatchObject({ selected: 'ASK_USER', override: true });
  });

  it('asks the user when finish is requested without completion confidence', () => {
    const validated = { ...state, tests: { ran: true, passed: true } };
    const result = applyPolicy(validated, assessment({
      nextAction: {
        choice: 'FINISH',
        probabilities: { FINISH: 0.96 },
        confidence: 0.9,
      },
    }));

    expect(result).toMatchObject({ selected: 'ASK_USER', override: true });
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
