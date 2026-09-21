export const ACTIONS = [
  'SEARCH_REPO',
  'READ_FILE',
  'RUN_COMMAND',
  'RUN_TESTS',
  'CALL_CODEX',
  'CALL_CLAUDE',
  'ASK_USER',
  'FINISH',
] as const;

export type Action = (typeof ACTIONS)[number];

export type RepoSnapshot = {
  root: string;
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown';
  packageName?: string;
  scripts: string[];
  validationScripts: string[];
  gitBranch?: string;
  gitStatus: string[];
  topLevelFiles: string[];
};

export type AgentState = {
  task: string;
  iteration: number;
  currentGoal: string;
  repo: RepoSnapshot;
  filesRead: string[];
  filesModified: string[];
  observations: string[];
  commandsRun: Array<{
    command: string;
    exitCode: number;
    output: string;
  }>;
  tests: {
    ran: boolean;
    passed?: boolean;
    summary?: string;
  };
  failedApproaches: string[];
  codexCalls: number;
  claudeCalls: number;
};

export type BooleanAssessment = {
  probability: number;
};

export type ChoiceAssessment = {
  choice: Action;
  probabilities: Partial<Record<Action, number>>;
  confidence?: number;
};

export type AgentAssessment = {
  taskComplete: BooleanAssessment;
  needsMoreInformation: BooleanAssessment;
  needsTesting: BooleanAssessment;
  stuck: BooleanAssessment;
  nextAction: ChoiceAssessment;
};

export type EvaluationResult = {
  assessment: AgentAssessment;
  model: string;
  latencyMs: number;
  providerMetadata?: unknown;
  rawAnswers: unknown;
};

export type PolicyDecision = {
  requested: Action;
  selected: Action;
  override: boolean;
  reason: string;
};
