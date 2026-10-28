import type { WorkerUsageStats, WorkerUsageSummary } from '../agents/usage.js';

/** Usage is display-only and may cover fewer attempts than the worker-call total. */
export function formatWorkerUsage(usage: WorkerUsageSummary, label = 'Worker tokens'): string {
  const workers = [usage.codex, usage.claude];
  const reported = workers.reduce((sum, worker) => sum + worker.reportedCalls, 0);
  const unavailable = workers.reduce((sum, worker) => sum + worker.unavailableCalls, 0);
  const number = (value: number): string => value.toLocaleString('en-US');
  const detail = (worker: WorkerUsageStats): string =>
    worker.reportedCalls ? `${number(worker.total)} (${number(worker.input)} input, ${number(worker.output)} output)`
      : worker.unavailableCalls ? 'unavailable' : 'no calls';
  if (reported + unavailable === 0) return `${label}: no worker calls.`;
  const total = workers.reduce((sum, worker) => sum + worker.total, 0);
  return `${label}: ${reported ? `${number(total)}${unavailable ? ' reported (partial)' : ' total'}` : 'unavailable'}; ` +
    `Codex ${detail(usage.codex)}; Claude ${detail(usage.claude)}. ` +
    `Usage reported for ${reported}/${reported + unavailable} attempts${unavailable ? `; ${unavailable} unavailable` : ''}.`;
}
