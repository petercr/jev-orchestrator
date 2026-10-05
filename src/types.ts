export const ACTIONS = [
  'SEARCH_REPO',
  'READ_FILE',
  'READ_ISSUE',
  'RUN_COMMAND',
  'RUN_TESTS',
  'CALL_CODEX',
  'CALL_CLAUDE',
  'ASK_USER',
  'FINISH',
] as const;

export type Action = (typeof ACTIONS)[number];

export type WorkerSelection = 'codex' | 'claude';

export type RepoSnapshot = {
  root: string;
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown';
  packageName?: string;
  scripts: string[];
  validationScripts: string[];
  requiredValidationScripts?: string[];
  validationScriptCoverage?: Record<string, string[]>;
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

export type IssueContext = {
  url: string;
  title: string;
  body: string;
  requestedValidationScripts: string[];
  validationRequirementsTruncated?: boolean;
  truncated: boolean;
};

export type ValidationEvidence = {
  iteration: number;
  generation: number;
  script: string;
  exitCode: number | null;
  timedOut: boolean;
  passed: boolean;
  summary: string;
};

export type AgentEvidence = {
  revision: number;
  lastRevisionSource?: 'user' | 'search' | 'read' | 'diagnostic' | 'issue';
  validationGeneration: number;
  clarifications: Array<{ iteration: number; text: string }>;
  findings: EvidenceFinding[];
  failures: Array<{ iteration: number; action: Action; summary: string }>;
  issue?: IssueContext;
  validation?: ValidationEvidence;
  validations?: ValidationEvidence[];
  worker?: {
    iteration: number;
    agent: 'codex' | 'claude';
    evidenceRevision: number;
    exitCode: number | null;
    timedOut: boolean;
    ok: boolean;
    summary: string;
    modifiedFiles: string[];
    reportedEnvironmentLimitations?: Array<'loopback_bind_denied'>;
  };
  repoRefreshRequired?: boolean;
};

export type AgentState = {
  task: string;
  workerSelection?: WorkerSelection;
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

export type JevProvider = 'vercel' | 'openrouter' | 'typesafe';

export type EvaluationAttribution = {
  provider?: JevProvider | 'mock';
  requestedModel?: string;
  servedModel?: string;
};

export type EvaluationResult = EvaluationAttribution & {
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
  completionReview?: 'jev_finish' | 'validation_complete';
};
