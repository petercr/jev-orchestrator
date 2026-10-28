import {
  describeSavedEvent, inspectionErrorText, SAVED_RUN_TIMELINE_LIMIT, savedWorkerUsage,
  type SavedRunInspection, type SavedRunListing,
} from '../saved-runs/history.js';
import { terminalText } from './terminal.js';
import { formatWorkerUsage } from './usage.js';

function text(value: string, limit = 4_096): string {
  const safe = terminalText(value).replace(/\s+/gu, ' ').trim();
  return safe.length > limit ? `${safe.slice(0, limit)}… [display shortened]` : safe;
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
