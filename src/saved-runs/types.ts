import type { EvaluationProvider, AgentState, Action, WorkerSelection } from '../types.js';
import type { WorkerUsage } from '../agents/usage.js';

export const SAVED_RUN_SCHEMA_VERSION = 1 as const;
export const SAVED_RUN_CHECKPOINT_LIMIT_BYTES = 1_048_576;
export const SAVED_RUN_EVENT_LIMIT_BYTES = 4_096;
export const SAVED_RUN_EVENT_LIMIT = 128;
export const SAVED_RUN_COUNT_LIMIT = 128;

export type SavedRunMode = 'mock' | 'live';
export type SavedRunProvider = EvaluationProvider | 'mock';
export type SavedRunStatus =
  | 'active'
  | 'stopped'
  | 'evaluation_failed'
  | 'finished'
  | 'iteration_limit'
  | 'blocked';

export type SavedRunConfiguration = {
  mode: SavedRunMode;
  provider: SavedRunProvider;
  model: string;
  /** SHA-256 of Cloudflare's account identifier; the identifier itself is never stored. */
  cloudflareAccountFingerprint?: string;
  workerSelection?: WorkerSelection;
  codexNetworkAccess: boolean;
};

export type SavedRunRepository = {
  root: string;
  gitCommonDirectory: string;
  head: string;
  worktreeFingerprint: string;
};

export type SavedRunEventData =
  | { type: 'run_created' }
  | { type: 'run_resumed'; segment: number; evaluationRecoveryApproved?: true }
  | { type: 'iteration_reserved'; iteration: number }
  | { type: 'evaluation_completed'; iteration: number }
  | { type: 'evaluation_failed'; iteration: number; code: string; stage: string; category: string }
  | { type: 'action_approved'; iteration: number; action: Action; decision: 'approve' | 'alternative' }
  | { type: 'execution_reserved'; iteration: number; attemptId: string; action: Action }
  | { type: 'execution_outcome'; attemptId: string; outcome: 'succeeded' | 'failed' | 'cancelled' | 'uncertain'; usage?: WorkerUsage }
  | { type: 'clarification_recorded'; iteration: number }
  | { type: 'run_stopped'; reason: 'user' | 'signal' | 'evaluation_failure' | 'storage_error'; resumable: boolean; repositorySnapshotHash?: string }
  | { type: 'run_finished' }
  | { type: 'iteration_limit' }
  | { type: 'run_blocked'; reason: 'checkpoint_invalid' | 'repository_changed' | 'configuration_changed' | 'attempt_unresolved' | 'lock_stale' | 'storage_failure' };

export type SavedRunEvent = SavedRunEventData & {
  schemaVersion: typeof SAVED_RUN_SCHEMA_VERSION;
  sequence: number;
  timestamp: string;
  previousHash: string | null;
  identityHash: string;
  stateHash: string;
  hash: string;
};

export type SavedRunCheckpointV1 = {
  schemaVersion: typeof SAVED_RUN_SCHEMA_VERSION;
  runId: string;
  createdAt: string;
  updatedAt: string;
  sequence: number;
  ledgerHead: string;
  status: SavedRunStatus;
  iterationLimit: number;
  repository: SavedRunRepository;
  configuration: SavedRunConfiguration;
  state: AgentState;
  checksum: string;
};

export type SavedRunCreateInput = {
  runId?: string;
  createdAt?: Date;
  iterationLimit: number;
  repository: SavedRunRepository;
  configuration: SavedRunConfiguration;
  state: AgentState;
};

export type SavedRunEventInput = SavedRunEventData;

export type SavedRunOwnership = {
  kind: 'run' | 'worktree';
  key: string;
  token: string;
  lockPath: string;
  release(): Promise<void>;
};
