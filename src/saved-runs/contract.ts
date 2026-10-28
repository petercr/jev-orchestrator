import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isWorkerUsage } from '../agents/usage.js';
import { validateCloudflareAccountId, validateEvaluationModel, type EvaluationConfiguration } from '../config.js';
import { redactSensitiveText } from '../logging/trace.js';
import { MAX_TASK_LENGTH } from '../limits.js';
import { isIssueContext } from '../repo/issue.js';
import { ACTIONS, type AgentState, type EvaluationProvider, type WorkerSelection } from '../types.js';
import type {
  SavedRunConfiguration,
  SavedRunMode,
  SavedRunProvider,
  SavedRunRepository,
} from './types.js';

const MAX_NESTING_DEPTH = 16;
const MAX_JSON_ITEMS = 256;
const MAX_JSON_STRING_LENGTH = 16_384;
const SENSITIVE_KEY = /api[-_ ]?key|authorization|token|secret|password|credential|cookie/iu;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const PROVIDERS: readonly SavedRunProvider[] = ['mock', 'vercel', 'openrouter', 'typesafe', 'cloudflare'];
const WORKERS: readonly WorkerSelection[] = ['codex', 'claude'];
const EVALUATION_ERROR_CODES = [
  'timeout', 'authentication', 'authorization', 'billing', 'rate_limit', 'model_unavailable',
  'invalid_response', 'service_unavailable', 'request_failed',
] as const;
const EVALUATION_STAGES = ['transport', 'json', 'answers', 'next_action', 'distribution', 'confidence', 'metadata', 'model'] as const;
const EVALUATION_CATEGORIES = ['request', 'shape', 'value', 'sum', 'choice', 'missing_action', 'unknown_action', 'size'] as const;

export function isSavedRunId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function isBoundedString(value: unknown, maximum = MAX_JSON_STRING_LENGTH): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

function isStringArray(value: unknown, maximumItems: number, maximumLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems &&
    value.every((item) => isBoundedString(item, maximumLength));
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isJsonTree(value: unknown, depth = 0, seen = new WeakSet<object>()): boolean {
  if (depth > MAX_NESTING_DEPTH) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return isBoundedString(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.length <= MAX_JSON_ITEMS && value.every((item) => isJsonTree(item, depth + 1, seen));
  }
  if (!isRecord(value) || Object.keys(value).length > MAX_JSON_ITEMS) return false;
  return Object.entries(value).every(([key, item]) =>
    isBoundedString(key, 128) && !SENSITIVE_KEY.test(key) && isJsonTree(item, depth + 1, seen));
}

function isRepoSnapshot(value: unknown): boolean {
  if (!isRecord(value) || !isBoundedString(value.root, 4_096) || !path.isAbsolute(value.root) ||
      !['pnpm', 'npm', 'yarn', 'bun', 'unknown'].includes(String(value.packageManager)) ||
      !isStringArray(value.scripts, 100, 200) || !isStringArray(value.validationScripts, 100, 200) ||
      !isStringArray(value.gitStatus, 100, 500) || !isStringArray(value.topLevelFiles, 80, 512)) return false;
  if (value.packageName !== undefined && !isBoundedString(value.packageName, 200)) return false;
  if (value.requiredValidationScripts !== undefined && !isStringArray(value.requiredValidationScripts, 100, 200)) return false;
  if (value.gitBranch !== undefined && !isBoundedString(value.gitBranch, 500)) return false;
  if (value.validationScriptCoverage !== undefined &&
      (!isRecord(value.validationScriptCoverage) || Object.keys(value.validationScriptCoverage).length > 100 ||
        !Object.entries(value.validationScriptCoverage).every(([key, scripts]) =>
          isBoundedString(key, 200) && isStringArray(scripts, 100, 200)))) return false;
  return true;
}

function isEvidence(value: unknown): boolean {
  if (!isRecord(value) || !isIntegerInRange(value.revision, 0, 1_000_000) ||
      !isIntegerInRange(value.validationGeneration, 0, 1_000_000) ||
      !Array.isArray(value.clarifications) || value.clarifications.length > 8 ||
      !Array.isArray(value.findings) || value.findings.length > 8 ||
      !Array.isArray(value.failures) || value.failures.length > 8) return false;
  if (value.lastRevisionSource !== undefined &&
      !['user', 'search', 'read', 'diagnostic', 'issue'].includes(String(value.lastRevisionSource))) return false;
  if (!value.clarifications.every((item) => isRecord(item) && isIntegerInRange(item.iteration, 1, 8) &&
      isBoundedString(item.text, 2_000))) return false;
  if (!value.findings.every((item) => isRecord(item) && isIntegerInRange(item.iteration, 1, 8) &&
      ['search', 'read', 'diagnostic'].includes(String(item.source)) && isStringArray(item.paths, 8, 512) &&
      (item.excerpt === undefined || isBoundedString(item.excerpt, 1_000)))) return false;
  if (!value.failures.every((item) => isRecord(item) && isIntegerInRange(item.iteration, 1, 8) &&
      ACTIONS.includes(item.action as (typeof ACTIONS)[number]) && isBoundedString(item.summary, 1_000))) return false;
  if (value.issue !== undefined && !isIssueContext(value.issue)) return false;
  const validations = value.validations;
  const validation = value.validation;
  const validationRecords = validations === undefined ? (validation === undefined ? [] : [validation]) : validations;
  if (!Array.isArray(validationRecords) || validationRecords.length > 8 ||
      !validationRecords.every((item) => isRecord(item) && isIntegerInRange(item.iteration, 1, 8) &&
        isIntegerInRange(item.generation, 0, 1_000_000) && isBoundedString(item.script, 200) &&
        (item.exitCode === null || (typeof item.exitCode === 'number' && Number.isInteger(item.exitCode))) &&
        typeof item.timedOut === 'boolean' && typeof item.passed === 'boolean' &&
        isBoundedString(item.summary, 1_000))) return false;
  if (value.worker !== undefined && (!isRecord(value.worker) ||
      !isIntegerInRange(value.worker.iteration, 1, 8) || !WORKERS.includes(value.worker.agent as WorkerSelection) ||
      !isIntegerInRange(value.worker.evidenceRevision, 0, 1_000_000) ||
      (value.worker.exitCode !== null && (typeof value.worker.exitCode !== 'number' || !Number.isInteger(value.worker.exitCode))) ||
      typeof value.worker.timedOut !== 'boolean' || typeof value.worker.ok !== 'boolean' ||
      !isBoundedString(value.worker.summary, 500) || !isStringArray(value.worker.modifiedFiles, 8, 512) ||
      (value.worker.reportedEnvironmentLimitations !== undefined &&
        (!Array.isArray(value.worker.reportedEnvironmentLimitations) ||
          !value.worker.reportedEnvironmentLimitations.every((item) => item === 'loopback_bind_denied'))))) return false;
  if (value.repoRefreshRequired !== undefined && typeof value.repoRefreshRequired !== 'boolean') return false;
  if (value.requiredInstructionFiles !== undefined && (!isStringArray(value.requiredInstructionFiles, 3, 32) ||
      !value.requiredInstructionFiles.every((file) => ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md'].includes(file)))) return false;
  return isJsonTree(value);
}

export function isSavedAgentState(value: unknown): value is AgentState {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'task', 'workerSelection', 'codexNetworkAccess', 'iteration', 'currentGoal', 'repo', 'filesRead',
    'filesModified', 'observations', 'commandsRun', 'tests', 'failedApproaches', 'codexCalls', 'claudeCalls', 'evidence',
  ]) || !isBoundedString(value.task, MAX_TASK_LENGTH) || !isIntegerInRange(value.iteration, 1, 8) ||
      !isBoundedString(value.currentGoal, 2_000) || !isRepoSnapshot(value.repo) ||
      !isStringArray(value.filesRead, 100, 4_096) || !isStringArray(value.filesModified, 100, 4_096) ||
      !isStringArray(value.observations, 64, 2_000) || !Array.isArray(value.commandsRun) || value.commandsRun.length > 16 ||
      !isStringArray(value.failedApproaches, 8, 2_000) || !isIntegerInRange(value.codexCalls, 0, 2) ||
      !isIntegerInRange(value.claudeCalls, 0, 2) || (value.workerSelection !== undefined &&
        !WORKERS.includes(value.workerSelection as WorkerSelection)) ||
      (value.codexNetworkAccess !== undefined && value.codexNetworkAccess !== true) ||
      !isRecord(value.tests) || !hasOnlyKeys(value.tests, ['ran', 'passed', 'summary']) ||
      typeof value.tests.ran !== 'boolean' || (value.tests.passed !== undefined && typeof value.tests.passed !== 'boolean') ||
      (value.tests.summary !== undefined && !isBoundedString(value.tests.summary, 2_000)) ||
      !value.commandsRun.every((command) => isRecord(command) && hasOnlyKeys(command, ['command', 'exitCode', 'output']) &&
        isBoundedString(command.command, 512) && typeof command.exitCode === 'number' && Number.isInteger(command.exitCode) &&
        isBoundedString(command.output, 2_000)) || (value.evidence !== undefined && !isEvidence(value.evidence))) return false;
  return isJsonTree(value);
}

function cleanJson(value: unknown, depth = 0): unknown {
  if (depth > MAX_NESTING_DEPTH) throw new Error('Saved run state exceeds the nesting limit.');
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map((item) => cleanJson(item, depth + 1));
  if (!isRecord(value)) throw new Error('Saved run state must contain only JSON values.');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanJson(item, depth + 1)]));
}

export function redactAndValidateAgentState(state: AgentState): AgentState {
  const cleaned = cleanJson(state) as unknown;
  if (!isSavedAgentState(cleaned)) throw new Error('Saved run state does not match the bounded v1 contract.');
  return cleaned;
}

export function createSavedRunConfiguration(
  mode: SavedRunMode,
  configuration: EvaluationConfiguration | undefined,
  workerSelection?: WorkerSelection,
  codexNetworkAccess = false,
): SavedRunConfiguration {
  if (mode === 'mock') {
    if (workerSelection === 'claude' && codexNetworkAccess) {
      throw new Error('Codex networking cannot be enabled for a Claude-only run.');
    }
    return {
      mode,
      provider: 'mock',
      model: 'mock',
      ...(workerSelection === undefined ? {} : { workerSelection }),
      codexNetworkAccess,
    };
  }
  if (!configuration) throw new Error('Live saved runs require a selected provider configuration.');
  if (workerSelection === 'claude' && codexNetworkAccess) throw new Error('Codex networking cannot be enabled for a Claude-only run.');
  validateEvaluationModel(configuration.provider, configuration.model);
  const result: SavedRunConfiguration = {
    mode,
    provider: configuration.provider,
    model: configuration.model,
    ...(workerSelection === undefined ? {} : { workerSelection }),
    codexNetworkAccess,
  };
  if (configuration.provider === 'cloudflare') {
    validateCloudflareAccountId(configuration.accountId);
    result.cloudflareAccountFingerprint = createHash('sha256').update(configuration.accountId.toLowerCase()).digest('hex');
  }
  if (!isSavedRunConfiguration(result)) throw new Error('Provider configuration does not match the saved run contract.');
  return result;
}

export function isSavedRunConfiguration(value: unknown): value is SavedRunConfiguration {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'mode', 'provider', 'model', 'cloudflareAccountFingerprint', 'workerSelection', 'codexNetworkAccess',
  ]) || !['mock', 'live'].includes(String(value.mode)) || !PROVIDERS.includes(value.provider as SavedRunProvider) ||
      !isBoundedString(value.model, 256) || value.model.trim().length === 0 || typeof value.codexNetworkAccess !== 'boolean' ||
      (value.workerSelection !== undefined && !WORKERS.includes(value.workerSelection as WorkerSelection)) ||
      (value.cloudflareAccountFingerprint !== undefined && !HASH_PATTERN.test(String(value.cloudflareAccountFingerprint))) ||
      (value.provider === 'cloudflare' ? value.cloudflareAccountFingerprint === undefined : value.cloudflareAccountFingerprint !== undefined) ||
      (value.codexNetworkAccess && value.workerSelection === 'claude') ||
      (value.mode === 'mock' && (value.provider !== 'mock' || value.model !== 'mock')) ||
      (value.mode === 'live' && value.provider === 'mock')) return false;
  if (value.mode === 'live') {
    try {
      validateEvaluationModel(value.provider as EvaluationProvider, value.model);
    } catch {
      return false;
    }
  }
  return true;
}

export async function createSavedRunRepository(
  root: string,
  gitCommonDirectory: string,
  head: string,
): Promise<SavedRunRepository> {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(head)) {
    throw new Error('Saved runs require a full Git commit ID.');
  }
  const [canonicalRoot, canonicalGitDirectory] = await Promise.all([
    realpath(root), realpath(gitCommonDirectory),
  ]);
  const [rootStat, gitStat] = await Promise.all([stat(canonicalRoot), stat(canonicalGitDirectory)]);
  if (!rootStat.isDirectory() || !gitStat.isDirectory()) throw new Error('Saved runs require a Git worktree.');
  const identity = process.platform === 'win32'
    ? [canonicalRoot.toLowerCase(), canonicalGitDirectory.toLowerCase()]
    : [canonicalRoot, canonicalGitDirectory];
  return {
    root: canonicalRoot,
    gitCommonDirectory: canonicalGitDirectory,
    head: head.toLowerCase(),
    worktreeFingerprint: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
  };
}

export function isSavedRunRepository(value: unknown): value is SavedRunRepository {
  if (!isRecord(value) || !hasOnlyKeys(value, ['root', 'gitCommonDirectory', 'head', 'worktreeFingerprint']) ||
      !isBoundedString(value.root, 4_096) || !path.isAbsolute(value.root) ||
      !isBoundedString(value.gitCommonDirectory, 4_096) || !path.isAbsolute(value.gitCommonDirectory) ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(String(value.head)) || !HASH_PATTERN.test(String(value.worktreeFingerprint))) return false;
  const identity = process.platform === 'win32'
    ? [value.root.toLowerCase(), value.gitCommonDirectory.toLowerCase()]
    : [value.root, value.gitCommonDirectory];
  return value.worktreeFingerprint === createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export function isSavedRunEventData(value: unknown): value is import('./types.js').SavedRunEventData {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  const iteration = () => isIntegerInRange(value.iteration, 1, 8);
  switch (value.type) {
    case 'run_created':
    case 'run_finished':
    case 'iteration_limit':
      return Object.keys(value).length === 1;
    case 'run_resumed':
      return hasOnlyKeys(value, ['type', 'segment', 'evaluationRecoveryApproved']) &&
        isIntegerInRange(value.segment, 2, 128) &&
        (value.evaluationRecoveryApproved === undefined || value.evaluationRecoveryApproved === true);
    case 'iteration_reserved':
    case 'evaluation_completed':
    case 'clarification_recorded':
      return hasOnlyKeys(value, ['type', 'iteration']) && iteration();
    case 'evaluation_failed':
      return hasOnlyKeys(value, ['type', 'iteration', 'code', 'stage', 'category']) && iteration() &&
        EVALUATION_ERROR_CODES.includes(value.code as (typeof EVALUATION_ERROR_CODES)[number]) &&
        EVALUATION_STAGES.includes(value.stage as (typeof EVALUATION_STAGES)[number]) &&
        EVALUATION_CATEGORIES.includes(value.category as (typeof EVALUATION_CATEGORIES)[number]);
    case 'action_approved':
      return hasOnlyKeys(value, ['type', 'iteration', 'action', 'decision']) && iteration() &&
        ACTIONS.includes(value.action as (typeof ACTIONS)[number]) && ['approve', 'alternative'].includes(String(value.decision));
    case 'execution_reserved':
      return hasOnlyKeys(value, ['type', 'iteration', 'attemptId', 'action']) && iteration() &&
        typeof value.attemptId === 'string' && isSavedRunId(value.attemptId) &&
        ACTIONS.includes(value.action as (typeof ACTIONS)[number]) &&
        !['ASK_USER', 'FINISH'].includes(String(value.action));
    case 'execution_outcome':
      return hasOnlyKeys(value, ['type', 'attemptId', 'outcome', 'usage']) &&
        typeof value.attemptId === 'string' && isSavedRunId(value.attemptId) &&
        ['succeeded', 'failed', 'cancelled', 'uncertain'].includes(String(value.outcome)) &&
        (value.usage === undefined || isWorkerUsage(value.usage));
    case 'run_stopped':
      return hasOnlyKeys(value, ['type', 'reason', 'resumable', 'repositorySnapshotHash']) &&
        ['user', 'signal', 'evaluation_failure', 'storage_error'].includes(String(value.reason)) &&
        typeof value.resumable === 'boolean' && (value.repositorySnapshotHash === undefined ||
          (typeof value.repositorySnapshotHash === 'string' && HASH_PATTERN.test(value.repositorySnapshotHash)));
    case 'run_blocked':
      return hasOnlyKeys(value, ['type', 'reason']) &&
        ['checkpoint_invalid', 'repository_changed', 'configuration_changed', 'attempt_unresolved', 'lock_stale', 'storage_failure'].includes(String(value.reason));
    default:
      return false;
  }
}

export function parseSavedRunJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const contexts: Array<Set<string> | null> = [];
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]]/gu)) {
    const token = match[0];
    if (token === '{') contexts.push(new Set());
    else if (token === '[') contexts.push(null);
    else if (token === '}' || token === ']') contexts.pop();
    else {
      let next = (match.index ?? 0) + token.length;
      while (/\s/u.test(text[next] ?? '')) next += 1;
      if (text[next] !== ':') continue;
      const keys = contexts.at(-1);
      const key: string = JSON.parse(token);
      if (!keys || keys.has(key)) throw new Error('Saved run JSON contains a duplicate object key.');
      keys.add(key);
    }
  }
  return value;
}

export function timestampString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function evaluationProvider(value: SavedRunProvider): value is EvaluationProvider {
  return value !== 'mock';
}
