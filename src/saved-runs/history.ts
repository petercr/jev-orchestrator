import { realpath, stat } from 'node:fs/promises';
import { validationChecks, hasOmittedValidationRequirements } from '../repo/validation.js';
import { SavedRunStore, SavedRunStoreError, type SavedRunStoreErrorCode } from './store.js';
import type { SavedRunCheckpointV1, SavedRunEvent } from './types.js';

export const SAVED_RUN_LIST_LIMIT = 20;
export const SAVED_RUN_TIMELINE_LIMIT = 12;

type SavedRecord = Awaited<ReturnType<SavedRunStore['readForInspection']>>;

/** Reporting data only; continuation must perform its own preflight and approvals. */
export type SavedRunDetail = {
  kind: 'valid';
  checkpoint: SavedRunCheckpointV1;
  iterationsUsed: number;
  iterationsRemaining: number;
  checks: ReturnType<typeof validationChecks>;
  repositoryAvailable: boolean;
  blockers: string[];
  recoveryRequired: boolean;
  lastFailure?: string;
  lastStop?: string;
  events: SavedRunEvent[];
};

export type SavedRunInspectionError = {
  kind: 'unavailable';
  runId: string;
  code: SavedRunStoreErrorCode;
};

export type SavedRunInspection = SavedRunDetail | SavedRunInspectionError;

export function inspectionErrorText(code: SavedRunStoreErrorCode): string {
  switch (code) {
    case 'not_found': return 'No saved record exists for this ID.';
    case 'invalid_input': return 'The run ID or saved input is invalid.';
    case 'unsupported_version': return 'The saved schema version is unsupported; no migration is available.';
    case 'invalid_record': return 'The saved checkpoint or event history is malformed or incomplete.';
    case 'integrity_failure': return 'The checkpoint and event ledger failed integrity checks; saved state is untrusted.';
    case 'limit_reached': return 'Saved storage exceeds its size/count limits or regular-file constraints (including linked or replaced files).';
    case 'busy': return 'An update lock is present; a write may be active or its ownership unresolved. Retry after owner cleanup.';
    case 'storage_failure': return 'Saved storage is unreadable or contains an unsafe path.';
  }
}

async function repositoryAvailable(checkpoint: SavedRunCheckpointV1): Promise<boolean> {
  try {
    for (const directory of [checkpoint.repository.root, checkpoint.repository.gitCommonDirectory]) {
      if (await realpath(directory) !== directory || !(await stat(directory)).isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const BLOCK_REASONS = {
  checkpoint_invalid: 'The checkpoint was recorded as invalid.',
  repository_changed: 'Repository identity or contents changed at the recorded check.',
  configuration_changed: 'The recorded configuration comparison failed.',
  attempt_unresolved: 'An execution attempt has no trustworthy final outcome.',
  lock_stale: 'An ownership lock was recorded as unresolved.',
  storage_failure: 'A required saved-state write failed.',
} as const;

function summarizeRecord(record: SavedRecord, available: boolean): SavedRunDetail {
  const { checkpoint, events, ownership } = record;
  const newestFirst = [...events].reverse();
  const iterationsUsed = events.filter((event) => event.type === 'iteration_reserved').length;
  const iterationsRemaining = checkpoint.iterationLimit - iterationsUsed;
  const blockers: string[] = [];
  const stop = newestFirst.find((event) => event.type === 'run_stopped');
  const lastEvent = events.at(-1);
  const completed = new Set(events.filter((event) => event.type === 'execution_outcome').map((event) => event.attemptId));
  const unresolved = events.filter((event) => event.type === 'execution_reserved' && !completed.has(event.attemptId));
  const uncertain = events.filter((event) => event.type === 'execution_outcome' && event.outcome === 'uncertain');
  if (checkpoint.status === 'finished') blockers.push('Task completion was approved; this run is inspection only.');
  if (checkpoint.status === 'iteration_limit' || iterationsRemaining === 0) {
    blockers.push('The original iteration budget is exhausted; continuation cannot extend it.');
  }
  if (checkpoint.status === 'active' || checkpoint.status === 'evaluation_failed') {
    blockers.push('No durable clean stop is recorded; active or abruptly exited runs cannot continue.');
  }
  if (lastEvent?.type === 'run_blocked') blockers.push(BLOCK_REASONS[lastEvent.reason]);
  if (stop?.type === 'run_stopped' && !stop.resumable && checkpoint.status === 'blocked') {
    blockers.push(`The recorded ${stop.reason} stop was not marked resumable.`);
  }
  if (unresolved.length > 0) {
    blockers.push(`${unresolved.length} reserved execution attempt(s) have no outcome; their allowances stay charged.`);
  }
  if (uncertain.length > 0) blockers.push('An execution outcome is uncertain; do not replay the reserved action.');
  if (ownership.run) blockers.push('A run ownership lock is present; the owner may be active or unresolved.');
  if (ownership.worktree) blockers.push('A worktree ownership lock is present; the owner may be active or unresolved.');
  if (!available) blockers.push('The saved repository or Git directory is unavailable at its canonical path.');
  const evaluationFailure = newestFirst.find((event) => event.type === 'evaluation_failed');
  const recoveryRequired = evaluationFailure !== undefined &&
    !events.some((event) => event.type === 'evaluation_completed' && event.sequence > evaluationFailure.sequence);
  const failedEvent = newestFirst.find((event) => event.type === 'evaluation_failed' ||
    (event.type === 'execution_outcome' && event.outcome !== 'succeeded') || event.type === 'run_blocked');
  let lastFailure: string | undefined;
  if (failedEvent?.type === 'evaluation_failed') {
    lastFailure = `Iteration ${failedEvent.iteration}: ${failedEvent.code} at ${failedEvent.stage}/${failedEvent.category}.`;
  } else if (failedEvent?.type === 'execution_outcome') {
    const attempt = events.find((event) => event.type === 'execution_reserved' && event.attemptId === failedEvent.attemptId);
    const failure = checkpoint.state.evidence?.failures.slice().reverse().find((item) =>
      attempt?.type === 'execution_reserved' && item.iteration === attempt.iteration && item.action === attempt.action);
    lastFailure = `${attempt?.type === 'execution_reserved' ? `Iteration ${attempt.iteration}: ${attempt.action}` : 'Execution'} ${failedEvent.outcome}.${failure ? ` ${failure.summary}` : ''}`;
  } else if (failedEvent?.type === 'run_blocked') {
    lastFailure = BLOCK_REASONS[failedEvent.reason];
  }
  if (checkpoint.state.evidence?.repoRefreshRequired) {
    blockers.push('The saved state requires repository refresh before validation can confirm completion.');
  }
  if (hasOmittedValidationRequirements(checkpoint.state)) {
    blockers.push('Validation requirements were omitted; completion remains blocked.');
  }
  return {
    kind: 'valid', checkpoint, iterationsUsed, iterationsRemaining,
    checks: validationChecks(checkpoint.state), repositoryAvailable: available,
    blockers, recoveryRequired,
    ...(lastFailure === undefined ? {} : { lastFailure }),
    ...(stop?.type === 'run_stopped' ? { lastStop: `${stop.reason}; ${stop.resumable ? 'clean continuation point recorded' : 'not resumable'}` } : {}),
    events,
  };
}

export async function inspectSavedRun(store: SavedRunStore | undefined, runId: string): Promise<SavedRunInspection> {
  if (!store) return { kind: 'unavailable', runId, code: 'not_found' };
  try {
    const record = await store.readForInspection(runId);
    return summarizeRecord(record, await repositoryAvailable(record.checkpoint));
  } catch (error) {
    return { kind: 'unavailable', runId, code: error instanceof SavedRunStoreError ? error.code : 'storage_failure' };
  }
}

export type SavedRunListing = {
  runs: SavedRunInspection[];
  total: number;
  ignoredEntries: number;
  hiddenRuns: number;
};

export async function listSavedRuns(store: SavedRunStore | undefined): Promise<SavedRunListing> {
  if (!store) return { runs: [], total: 0, ignoredEntries: 0, hiddenRuns: 0 };
  const { runIds, ignoredEntries } = await store.listIdsForInspection();
  const runs: SavedRunInspection[] = [];
  // Each record is bounded by the store's byte/event limits. Read sequentially
  // so listing cannot allocate the entire store's raw data at once.
  for (const runId of runIds) runs.push(await inspectSavedRun(store, runId));
  runs.sort((left, right) => {
    // Unreadable records are always visible before recent valid records. Do not
    // trust a malformed checkpoint's timestamp to rank or hide its warning.
    if (left.kind !== right.kind) return left.kind === 'unavailable' ? -1 : 1;
    if (left.kind === 'valid' && right.kind === 'valid') {
      return right.checkpoint.updatedAt.localeCompare(left.checkpoint.updatedAt) ||
        left.checkpoint.runId.localeCompare(right.checkpoint.runId);
    }
    return left.kind === 'unavailable' && right.kind === 'unavailable' ? left.runId.localeCompare(right.runId) : 0;
  });
  return {
    runs: runs.slice(0, SAVED_RUN_LIST_LIMIT), total: runs.length, ignoredEntries,
    hiddenRuns: Math.max(0, runs.length - SAVED_RUN_LIST_LIMIT),
  };
}

export function describeSavedEvent(event: SavedRunEvent): string {
  switch (event.type) {
    case 'iteration_reserved': return `iteration_reserved ${event.iteration}`;
    case 'evaluation_completed': return `evaluation_completed ${event.iteration}`;
    case 'evaluation_failed': return `evaluation_failed ${event.iteration}: ${event.code} at ${event.stage}/${event.category}`;
    case 'action_approved': return `action_approved ${event.iteration}: ${event.action} (${event.decision})`;
    case 'execution_reserved': return `execution_reserved ${event.iteration}: ${event.action}`;
    case 'execution_outcome': return `execution_outcome: ${event.outcome}`;
    case 'clarification_recorded': return `clarification_recorded ${event.iteration}`;
    case 'run_stopped': return `run_stopped: ${event.reason}; resumable=${event.resumable}`;
    case 'run_blocked': return `run_blocked: ${event.reason}`;
    case 'run_resumed': return `run_resumed: segment ${event.segment}`;
    default: return event.type;
  }
}
