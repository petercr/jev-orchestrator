import {
  describeSavedEvent, inspectionErrorText, SAVED_RUN_TIMELINE_LIMIT, savedWorkerUsage,
  SAVED_RUN_LIST_LIMIT, type SavedRunDetail, type SavedRunInspection, type SavedRunListing,
} from '../saved-runs/history.js';
import type { WorkerUsageSummary } from '../agents/usage.js';
import type { SavedRunConfiguration, SavedRunEvent, SavedRunStatus } from '../saved-runs/types.js';
import type { WorkerSelection } from '../types.js';
import { terminalText } from './terminal.js';
import { formatWorkerUsage } from './usage.js';

function text(value: string, limit = 4_096): string {
  const safe = terminalText(value).replace(/\s+/gu, ' ').trim();
  return safe.length > limit ? `${safe.slice(0, limit)}… [display shortened]` : safe;
}

type WorkerCallReport = { used: number; available: number; excluded: boolean };

/** Reporting only. These objects are never accepted as saved records or approvals. */
export type SavedRunReport = {
  kind: 'unavailable';
  runId: string;
  error: { code: Extract<SavedRunInspection, { kind: 'unavailable' }>['code']; message: string };
} | {
  kind: 'valid';
  runId: string;
  status: SavedRunStatus;
  createdAt: string;
  updatedAt: string;
  task: string;
  repository: { root: string; available: boolean; head?: string; gitCommonDirectory?: string };
  configuration: Pick<SavedRunConfiguration, 'mode' | 'provider' | 'model' | 'codexNetworkAccess'> & {
    workerSelection: WorkerSelection | 'auto';
  };
  iterations: { used: number; limit: number; remaining: number };
  workerCalls: { codex: WorkerCallReport; claude: WorkerCallReport };
  workerUsage: WorkerUsageSummary;
  validation: { generation: number; checks: SavedRunDetail['checks'] };
  continuation: { preflightRequired: true; recoveryRequired: boolean; blockers: string[] };
  lastFailure?: string;
  lastStop?: string;
  segments: number;
  timeline?: {
    total: number;
    recent: Array<{ sequence: number; timestamp: string; type: SavedRunEvent['type']; description: string }>;
  };
};

export type SavedRunListOutput = {
  schemaVersion: 1;
  kind: 'saved-run-list';
  readOnly: true;
  status: 'ok' | 'partial';
  limit: number;
  total: number;
  hiddenRuns: number;
  ignoredEntries: number;
  runs: SavedRunReport[];
};

export type SavedRunDetailOutput = {
  schemaVersion: 1;
  kind: 'saved-run-detail';
  readOnly: true;
  status: 'ok' | 'unavailable';
  run: SavedRunReport;
};

function savedRunReport(run: SavedRunInspection, detail: boolean): SavedRunReport {
  if (run.kind === 'unavailable') {
    return { kind: 'unavailable', runId: run.runId, error: { code: run.code, message: inspectionErrorText(run.code) } };
  }
  const { checkpoint } = run;
  const { state, configuration, repository } = checkpoint;
  const workerCalls = (used: number, excluded: boolean): WorkerCallReport => ({ used, available: excluded ? 0 : 2 - used, excluded });
  return {
    kind: 'valid', runId: checkpoint.runId, status: checkpoint.status,
    createdAt: checkpoint.createdAt, updatedAt: checkpoint.updatedAt,
    task: text(state.task),
    repository: {
      root: text(repository.root), available: run.repositoryAvailable,
      ...(detail ? { head: repository.head, gitCommonDirectory: text(repository.gitCommonDirectory) } : {}),
    },
    configuration: {
      mode: configuration.mode, provider: configuration.provider, model: text(configuration.model),
      workerSelection: configuration.workerSelection ?? 'auto', codexNetworkAccess: configuration.codexNetworkAccess,
    },
    iterations: { used: run.iterationsUsed, limit: checkpoint.iterationLimit, remaining: run.iterationsRemaining },
    workerCalls: {
      codex: workerCalls(state.codexCalls, configuration.workerSelection === 'claude'),
      claude: workerCalls(state.claudeCalls, configuration.workerSelection === 'codex'),
    },
    workerUsage: savedWorkerUsage(run.events),
    validation: {
      generation: state.evidence?.validationGeneration ?? 0,
      checks: run.checks.map((check) => ({ script: text(check.script), status: check.status })),
    },
    continuation: {
      preflightRequired: true, recoveryRequired: run.recoveryRequired,
      blockers: run.blockers.map((blocker) => text(blocker)),
    },
    ...(run.lastFailure === undefined ? {} : { lastFailure: text(run.lastFailure, 1_200) }),
    ...(run.lastStop === undefined ? {} : { lastStop: text(run.lastStop) }),
    segments: 1 + run.events.filter((event) => event.type === 'run_resumed').length,
    ...(detail ? {
      timeline: {
        total: run.events.length,
        recent: run.events.slice(-SAVED_RUN_TIMELINE_LIMIT).map((event) => ({
          sequence: event.sequence, timestamp: event.timestamp, type: event.type, description: text(describeSavedEvent(event)),
        })),
      },
    } : {}),
  };
}

export function createSavedRunListingOutput(listing: SavedRunListing): SavedRunListOutput {
  return {
    schemaVersion: 1, kind: 'saved-run-list', readOnly: true,
    status: listing.ignoredEntries || listing.runs.some((run) => run.kind === 'unavailable') ? 'partial' : 'ok',
    limit: SAVED_RUN_LIST_LIMIT, total: listing.total, hiddenRuns: listing.hiddenRuns, ignoredEntries: listing.ignoredEntries,
    runs: listing.runs.map((run) => savedRunReport(run, false)),
  };
}

export function createSavedRunDetailOutput(run: SavedRunInspection): SavedRunDetailOutput {
  return {
    schemaVersion: 1, kind: 'saved-run-detail', readOnly: true, status: run.kind === 'valid' ? 'ok' : 'unavailable',
    run: savedRunReport(run, true),
  };
}

export function formatSavedRunLines(run: SavedRunInspection, detail = true): string[] {
  if (run.kind === 'unavailable') {
    return [
      `Run: ${run.runId}`,
      `Status: unavailable (${run.code})`,
      `Continuation blocked: ${inspectionErrorText(run.code)}`,
      'Task, budgets, and approvals are unavailable from a trustworthy record.',
    ];
  }
  const { checkpoint, checks } = run;
  const { state, configuration } = checkpoint;
  const budget = (used: number, allowed: boolean): string => `${used}/2 used; ${allowed ? 2 - used : 0} available${allowed ? '' : ' (worker excluded)'}`;
  const pending = checks.filter((check) => check.status !== 'passed');
  const lines = [
    `Run: ${checkpoint.runId}`,
    `Status: ${checkpoint.status}; updated: ${checkpoint.updatedAt}`,
    `Task (saved): ${text(state.task, detail ? 4_096 : 160)}`,
    `Repo (saved): ${text(checkpoint.repository.root)}`,
    `Iterations: ${run.iterationsUsed}/${checkpoint.iterationLimit} consumed; ${run.iterationsRemaining} remaining`,
    `Codex calls: ${budget(state.codexCalls, configuration.workerSelection !== 'claude')}`,
    `Claude calls: ${budget(state.claudeCalls, configuration.workerSelection !== 'codex')}`,
    formatWorkerUsage(savedWorkerUsage(run.events), 'Saved task worker tokens'),
    `Selection: ${configuration.mode}; ${configuration.provider}/${text(configuration.model)}; worker: ${configuration.workerSelection ?? 'Codex or Claude'}; Codex command network: ${configuration.codexNetworkAccess ? 'enabled' : 'disabled'}`,
    `Pending validation (saved generation ${state.evidence?.validationGeneration ?? 0}): ${pending.map((check) => `${text(check.script)} (${check.status})`).join(', ') || (checks.length ? 'none' : 'no required checks recorded')}`,
    `Last failure: ${run.lastFailure ? text(run.lastFailure, detail ? 1_200 : 300) : 'none recorded'}`,
    ...(run.lastStop ? [`Last stop: ${run.lastStop}`] : []),
    ...(run.recoveryRequired ? ['Recovery: explicit evaluation-failure continuation is still required.'] : []),
    ...run.blockers.map((blocker) => `Continuation blocked: ${blocker}`),
    ...(run.blockers.length === 0 ? ['Continuation: clean stop recorded; repository/configuration review and fresh approvals are still required.'] : []),
  ];
  if (detail) {
    lines.push(
      `Created: ${checkpoint.createdAt}; segments: ${1 + run.events.filter((event) => event.type === 'run_resumed').length}`,
      `Git directory (saved): ${text(checkpoint.repository.gitCommonDirectory)}`,
      `HEAD (saved): ${checkpoint.repository.head}`,
      `Repository availability: ${run.repositoryAvailable ? 'canonical directories available' : 'unavailable'}. HEAD, working files, and current configuration have not been rechecked.`,
      `Independent checks (saved): ${checks.map((check) => `${text(check.script)}: ${check.status}`).join(', ') || 'none recorded'}`,
      'Continuation requires a new validation generation; earlier passes cannot approve completion after restart.',
      `Recent events (${Math.min(run.events.length, SAVED_RUN_TIMELINE_LIMIT)}/${run.events.length}):`,
      ...run.events.slice(-SAVED_RUN_TIMELINE_LIMIT).map((event) => `  ${event.sequence}. ${event.timestamp} ${describeSavedEvent(event)}`),
    );
  }
  return lines;
}

export function formatSavedRunListingLines(listing: SavedRunListing): string[] {
  return [
    ...(listing.total === 0 ? ['No saved runs found.'] : [
      `Showing ${listing.runs.length}/${listing.total} saved runs (unreadable records first, then most recently updated).`,
    ]),
    ...(listing.hiddenRuns ? [`${listing.hiddenRuns} older or additional records are outside this listing.`] : []),
    ...(listing.ignoredEntries ? [`${listing.ignoredEntries} unrecognized store entries were ignored.`] : []),
    'Inspect any known ID, including older records: dev-agent --show-run <run-id> [--plain]',
  ];
}
