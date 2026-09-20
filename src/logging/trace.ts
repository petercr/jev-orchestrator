import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentState, EvaluationResult, PolicyDecision } from '../types.js';

export const TRACE_SCHEMA_VERSION = 1;
export const ORCHESTRATION_TRACE_SCHEMA_VERSION = 2;
export const MAX_TRACE_VALUE_BYTES = 8 * 1024;

const MAX_TRACE_DEPTH = 6;
const MAX_TRACE_ARRAY_ITEMS = 32;
const MAX_TRACE_OBJECT_ENTRIES = 32;
const MAX_TRACE_STRING_LENGTH = 1_024;
const MAX_TRACE_TEXT_BUDGET = 6_000;
const MAX_TRACE_WRITE_ATTEMPTS = 3;
const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';
const SENSITIVE_KEY = /api[-_ ]?key|authorization|token|secret|password|credential|cookie|session/i;
const KEY_VALUE_SECRET = /((?:api[-_ ]?key|authorization|token|secret|password|credential|cookie|session)\s*[:=]\s*)(?:(?:Bearer\s+)[^\s,;]+|"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER_TOKEN = /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi;

export type TraceValue =
  | null
  | boolean
  | number
  | string
  | TraceValue[]
  | { [key: string]: TraceValue };

export type TraceRecord = {
  schemaVersion: typeof TRACE_SCHEMA_VERSION;
  runId: string;
  timestamp: string;
  state: TraceValue;
  evaluation: {
    assessment: TraceValue;
    model: string;
    latencyMs: number;
    rawAnswers: TraceValue;
  };
  policy: TraceValue;
};

export type OrchestrationTracePayload = {
  iteration: number;
  stateBefore: AgentState;
  evaluation: EvaluationResult;
  policy: PolicyDecision;
  proposal: unknown;
  approval: unknown;
  toolInput: unknown;
  toolResult: unknown;
  stateAfter: AgentState;
};

export class TraceWriteError extends Error {
  constructor() {
    super('Unable to write the decision trace. Re-run with --no-trace only when an unrecorded decision is acceptable.');
    this.name = 'TraceWriteError';
  }
}

type SanitizationContext = {
  remainingText: number;
  seen: WeakSet<object>;
  secretValues: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configuredSecretValues(): string[] {
  const gatewayKey = process.env.AI_GATEWAY_API_KEY?.trim();
  return gatewayKey ? [gatewayKey] : [];
}

function redactText(value: string, secretValues: string[]): string {
  let redacted = value;
  for (const secret of secretValues) {
    redacted = redacted.replaceAll(secret, REDACTED);
  }
  return redacted
    .replace(KEY_VALUE_SECRET, `$1${REDACTED}`)
    .replace(BEARER_TOKEN, `$1${REDACTED}`);
}

function takeText(value: string, context: SanitizationContext): string {
  const redacted = redactText(value, context.secretValues);
  const available = Math.min(MAX_TRACE_STRING_LENGTH, context.remainingText);
  if (available <= 0) return TRUNCATED;
  context.remainingText -= Math.min(redacted.length, available);
  return redacted.length > available ? `${redacted.slice(0, available)}${TRUNCATED}` : redacted;
}

function sanitizeValue(value: unknown, context: SanitizationContext, depth: number): TraceValue {
  if (depth > MAX_TRACE_DEPTH) return TRUNCATED;
  if (value === undefined) return '[UNDEFINED]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') return takeText(value, context);
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return takeText(String(value), context);
  }

  if (context.seen.has(value)) return '[CIRCULAR]';
  context.seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_TRACE_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, context, depth + 1));
    if (value.length > MAX_TRACE_ARRAY_ITEMS) items.push(TRUNCATED);
    return items;
  }

  if (!isRecord(value)) return takeText(String(value), context);

  const entries: { [key: string]: TraceValue } = {};
  const objectEntries = Object.entries(value).slice(0, MAX_TRACE_OBJECT_ENTRIES);
  for (const [key, entry] of objectEntries) {
    entries[key] = SENSITIVE_KEY.test(key)
      ? REDACTED
      : sanitizeValue(entry, context, depth + 1);
  }
  if (Object.keys(value).length > MAX_TRACE_OBJECT_ENTRIES) entries.truncated = TRUNCATED;
  return entries;
}

export function sanitizeTraceValue(
  value: unknown,
  secretValues: string[] = configuredSecretValues(),
): TraceValue {
  const sanitized = sanitizeValue(value, {
    remainingText: MAX_TRACE_TEXT_BUDGET,
    seen: new WeakSet<object>(),
    secretValues,
  }, 0);
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_TRACE_VALUE_BYTES) return sanitized;

  return {
    truncated: true,
    preview: takeText(serialized, {
      remainingText: Math.floor(MAX_TRACE_VALUE_BYTES / 4),
      seen: new WeakSet<object>(),
      secretValues,
    }),
  };
}

function makeTraceRecord(
  payload: {
    state: AgentState;
    evaluation: EvaluationResult;
    policy: PolicyDecision;
  },
  date: Date,
  runId: string,
): TraceRecord {
  const secretValues = configuredSecretValues();
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    runId,
    timestamp: date.toISOString(),
    state: sanitizeTraceValue(payload.state, secretValues),
    evaluation: {
      assessment: sanitizeTraceValue(payload.evaluation.assessment, secretValues),
      model: redactText(payload.evaluation.model, secretValues),
      latencyMs: Number.isFinite(payload.evaluation.latencyMs) ? payload.evaluation.latencyMs : 0,
      rawAnswers: sanitizeTraceValue(payload.evaluation.rawAnswers, secretValues),
    },
    policy: sanitizeTraceValue(payload.policy, secretValues),
  };
}

function isFileExistsError(error: unknown): boolean {
  return isRecord(error) && error.code === 'EEXIST';
}

async function uniqueTracePath(root: string): Promise<{ path: string; runId: string }> {
  const traceDir = path.join(root, 'traces');
  await mkdir(traceDir, { recursive: true });

  for (let attempt = 0; attempt < MAX_TRACE_WRITE_ATTEMPTS; attempt += 1) {
    const date = new Date();
    const runId = `${date.toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`;
    const tracePath = path.join(traceDir, `${runId}.jsonl`);
    try {
      await writeFile(tracePath, '', { flag: 'wx' });
      return { path: tracePath, runId };
    } catch (error) {
      if (isFileExistsError(error)) continue;
      throw error;
    }
  }

  throw new Error('Unable to allocate a unique trace path.');
}

export async function writeTrace(
  root: string,
  payload: {
    state: AgentState;
    evaluation: EvaluationResult;
    policy: PolicyDecision;
  },
): Promise<string> {
  try {
    const trace = await uniqueTracePath(root);
    const record = makeTraceRecord(payload, new Date(), trace.runId);
    await writeFile(trace.path, `${JSON.stringify(record)}\n`);
    return trace.path;
  } catch {
    throw new TraceWriteError();
  }
}

export async function createOrchestrationTrace(root: string): Promise<{
  path: string;
  runId: string;
}> {
  try {
    return await uniqueTracePath(root);
  } catch {
    throw new TraceWriteError();
  }
}

export async function appendOrchestrationTrace(
  trace: { path: string; runId: string },
  payload: OrchestrationTracePayload,
): Promise<void> {
  const secretValues = configuredSecretValues();
  const record = {
    schemaVersion: ORCHESTRATION_TRACE_SCHEMA_VERSION,
    runId: trace.runId,
    timestamp: new Date().toISOString(),
    iteration: payload.iteration,
    stateBefore: sanitizeTraceValue(payload.stateBefore, secretValues),
    evaluation: {
      assessment: sanitizeTraceValue(payload.evaluation.assessment, secretValues),
      model: redactText(payload.evaluation.model, secretValues),
      latencyMs: Number.isFinite(payload.evaluation.latencyMs) ? payload.evaluation.latencyMs : 0,
      rawAnswers: sanitizeTraceValue(payload.evaluation.rawAnswers, secretValues),
    },
    policy: sanitizeTraceValue(payload.policy, secretValues),
    proposal: sanitizeTraceValue(payload.proposal, secretValues),
    approval: sanitizeTraceValue(payload.approval, secretValues),
    toolInput: sanitizeTraceValue(payload.toolInput, secretValues),
    toolResult: sanitizeTraceValue(payload.toolResult, secretValues),
    stateAfter: sanitizeTraceValue(payload.stateAfter, secretValues),
  };

  try {
    await appendFile(trace.path, `${JSON.stringify(record)}\n`);
  } catch {
    throw new TraceWriteError();
  }
}
