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

export type EvidenceFinding = {
  iteration: number;
  source: 'search' | 'read' | 'diagnostic';
  paths: string[];
  excerpt?: string;
};

export type AgentEvidence = {
  revision: number;
  lastRevisionSource?: 'user' | 'search' | 'read' | 'diagnostic';
  validationGeneration: number;
  clarifications: Array<{ iteration: number; text: string }>;
  findings: EvidenceFinding[];
  failures: Array<{ iteration: number; action: Action; summary: string }>;
  validation?: {
    iteration: number;
    generation: number;
    script: string;
    exitCode: number | null;
    timedOut: boolean;
    passed: boolean;
    summary: string;
  };
  worker?: {
    iteration: number;
    agent: 'codex' | 'claude';
    evidenceRevision: number;
    exitCode: number | null;
    timedOut: boolean;
    ok: boolean;
    summary: string;
    modifiedFiles: string[];
  };
  repoRefreshRequired?: boolean;
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
  evidence?: AgentEvidence;
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
