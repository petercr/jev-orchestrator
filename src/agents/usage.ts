/** Reported usage only. Input includes cache reads/writes; output includes reasoning. */
export type WorkerUsage = {
  input: number;
  output: number;
  total: number;
  cachedInput?: number;
  cacheWriteInput?: number;
};

export type WorkerUsageStats = {
  input: number;
  output: number;
  total: number;
  reportedCalls: number;
  unavailableCalls: number;
};

export type WorkerUsageSummary = Record<'codex' | 'claude', WorkerUsageStats>;

const MAX_REPORTED_COUNT = 1_000_000_000_000;
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_REPORTED_COUNT;

export function isWorkerUsage(value: unknown): value is WorkerUsage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  return Object.keys(usage).every((key) => ['input', 'output', 'total', 'cachedInput', 'cacheWriteInput'].includes(key)) &&
    count(usage.input) && count(usage.output) && count(usage.total) && usage.total === usage.input + usage.output &&
    (usage.cachedInput === undefined || (count(usage.cachedInput) && usage.cachedInput <= usage.input)) &&
    (usage.cacheWriteInput === undefined || (count(usage.cacheWriteInput) && usage.cacheWriteInput <= usage.input));
}

export function normalizeWorkerUsage(agent: 'codex' | 'claude', value: unknown): WorkerUsage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  if (!count(usage.input_tokens) || !count(usage.output_tokens)) return undefined;
  // Claude reports cache input separately. Codex already includes it in input_tokens.
  if (agent === 'claude' && (!count(usage.cache_read_input_tokens) || !count(usage.cache_creation_input_tokens))) return undefined;
  const cachedInput = agent === 'claude' ? usage.cache_read_input_tokens : usage.cached_input_tokens;
  const cacheWriteInput = agent === 'claude' ? usage.cache_creation_input_tokens : usage.cache_write_input_tokens;
  if ((cachedInput !== undefined && !count(cachedInput)) || (cacheWriteInput !== undefined && !count(cacheWriteInput))) return undefined;
  const input = usage.input_tokens + (agent === 'claude' ? Number(cachedInput) + Number(cacheWriteInput) : 0);
  const normalized = {
    input, output: usage.output_tokens, total: input + usage.output_tokens,
    ...(cachedInput === undefined ? {} : { cachedInput: Number(cachedInput) }),
    ...(cacheWriteInput === undefined ? {} : { cacheWriteInput: Number(cacheWriteInput) }),
  };
  return isWorkerUsage(normalized) ? normalized : undefined;
}

export function emptyWorkerUsage(): WorkerUsageSummary {
  const empty = (): WorkerUsageStats => ({ input: 0, output: 0, total: 0, reportedCalls: 0, unavailableCalls: 0 });
  return { codex: empty(), claude: empty() };
}

export function addWorkerUsage(summary: WorkerUsageSummary, agent: 'codex' | 'claude', usage?: WorkerUsage): void {
  const stats = summary[agent];
  if (!isWorkerUsage(usage)) {
    stats.unavailableCalls += 1;
    return;
  }
  stats.input += usage.input;
  stats.output += usage.output;
  stats.total += usage.total;
  stats.reportedCalls += 1;
}
