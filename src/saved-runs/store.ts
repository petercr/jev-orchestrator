import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hasPassedValidation } from '../repo/validation.js';
import { isRepositorySnapshot, snapshotHash, SNAPSHOT_RECORD_BYTES, type RepositorySnapshot } from './snapshot.js';
import {
  isSavedAgentState,
  isSavedRunConfiguration,
  isSavedRunEventData,
  isSavedRunId,
  isSavedRunRepository,
  parseSavedRunJson,
  redactAndValidateAgentState,
  timestampString,
} from './contract.js';
import {
  SAVED_RUN_CHECKPOINT_LIMIT_BYTES,
  SAVED_RUN_COUNT_LIMIT,
  SAVED_RUN_EVENT_LIMIT,
  SAVED_RUN_EVENT_LIMIT_BYTES,
  SAVED_RUN_SCHEMA_VERSION,
  type SavedRunCheckpointV1,
  type SavedRunCreateInput,
  type SavedRunEvent,
  type SavedRunEventData,
  type SavedRunEventInput,
  type SavedRunOwnership,
  type SavedRunStatus,
} from './types.js';

const MAX_LOCK_BYTES = 1_024;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const WINDOWS_NOFOLLOW = 0;
const NOFOLLOW = process.platform === 'win32' ? WINDOWS_NOFOLLOW : (fsConstants.O_NOFOLLOW ?? 0);

export type SavedRunStoreErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'unsupported_version'
  | 'invalid_record'
  | 'integrity_failure'
  | 'limit_reached'
  | 'busy'
  | 'storage_failure';

export class SavedRunStoreError extends Error {
  constructor(readonly code: SavedRunStoreErrorCode, message: string) {
    super(message);
    this.name = 'SavedRunStoreError';
  }
}

function fail(code: SavedRunStoreErrorCode, message: string): never {
  throw new SavedRunStoreError(code, message);
}

function normalizeState(state: SavedRunCheckpointV1['state']): SavedRunCheckpointV1['state'] {
  try {
    return redactAndValidateAgentState(state);
  } catch {
    fail('invalid_input', 'Saved run state does not match the bounded v1 contract.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function checkpointBody(checkpoint: Omit<SavedRunCheckpointV1, 'checksum'>): string {
  return JSON.stringify(checkpoint);
}

function withCheckpointChecksum(
  checkpoint: Omit<SavedRunCheckpointV1, 'checksum'>,
): SavedRunCheckpointV1 {
  return { ...checkpoint, checksum: sha256(checkpointBody(checkpoint)) };
}

function eventBody(event: Omit<SavedRunEvent, 'hash'>): string {
  return JSON.stringify(event);
}

function withEventHash(event: Omit<SavedRunEvent, 'hash'>): SavedRunEvent {
  return { ...event, hash: sha256(eventBody(event)) } as SavedRunEvent;
}

function eventData(event: SavedRunEvent): SavedRunEventData {
  const { schemaVersion: _schemaVersion, sequence: _sequence, timestamp: _timestamp,
    previousHash: _previousHash, identityHash: _identityHash, stateHash: _stateHash,
    hash: _hash, ...data } = event;
  return data as SavedRunEventData;
}

function runIdentityHash(value: Pick<SavedRunCheckpointV1,
  'schemaVersion' | 'runId' | 'createdAt' | 'iterationLimit' | 'repository' | 'configuration'>): string {
  return sha256(JSON.stringify({
    schemaVersion: value.schemaVersion,
    runId: value.runId,
    createdAt: value.createdAt,
    iterationLimit: value.iterationLimit,
    repository: value.repository,
    configuration: value.configuration,
  }));
}

function eventStatus(event: SavedRunEventData): SavedRunStatus {
  switch (event.type) {
    case 'run_created':
    case 'run_resumed':
    case 'iteration_reserved':
    case 'evaluation_completed':
    case 'action_approved':
    case 'execution_reserved':
    case 'clarification_recorded':
      return 'active';
    case 'evaluation_failed':
      return 'evaluation_failed';
    case 'execution_outcome':
      return event.outcome === 'uncertain' ? 'blocked' : 'active';
    case 'run_stopped':
      return event.resumable ? 'stopped' : 'blocked';
    case 'run_finished':
      return 'finished';
    case 'iteration_limit':
      return 'iteration_limit';
    case 'run_blocked':
      return 'blocked';
  }
}

function noUnresolvedExecution(events: SavedRunEvent[]): boolean {
  const reserved = new Set<string>();
  const completed = new Set<string>();
  for (const event of events) {
    const data = eventData(event);
    if (data.type === 'execution_reserved') reserved.add(data.attemptId);
    if (data.type === 'execution_outcome') completed.add(data.attemptId);
  }
  return [...reserved].every((attemptId) => completed.has(attemptId));
}

function hasPendingEvaluationFailure(events: SavedRunEvent[]): boolean {
  const failures = events.filter((event) => event.type === 'evaluation_failed');
  const lastFailure = failures.at(-1);
  if (!lastFailure) return false;
  return !events.some((event) => event.type === 'evaluation_completed' && event.sequence > lastFailure.sequence);
}

function validateEventSequence(events: SavedRunEvent[], checkpoint: SavedRunCheckpointV1): void {
  if (events.length === 0 || events.length > SAVED_RUN_EVENT_LIMIT || events[0]?.type !== 'run_created') {
    fail('invalid_record', 'Saved run event history is missing or exceeds its limit.');
  }
  let expectedSequence = 1;
  let previousHash: string | null = null;
  let status: SavedRunStatus = 'active';
  let segment = 1;
  let lastIteration = 0;
  const reservedAttempts = new Set<string>();
  const finishedAttempts = new Set<string>();
  const workerCalls: Record<'CALL_CODEX' | 'CALL_CLAUDE', number> = { CALL_CODEX: 0, CALL_CLAUDE: 0 };
  let lastApproved: { iteration: number; action: string } | undefined;
  let evaluationSettled = false;

  for (const event of events) {
    if (status === 'finished' || status === 'iteration_limit' || status === 'blocked') {
      fail('invalid_record', 'Saved run contains events after a terminal state.');
    }
    if (event.sequence !== expectedSequence || event.previousHash !== previousHash) {
      fail('integrity_failure', 'Saved run event order is inconsistent.');
    }
    if (event.identityHash !== runIdentityHash(checkpoint) || !HASH_PATTERN.test(event.stateHash)) {
      fail('integrity_failure', 'Saved run identity or state does not match its event history.');
    }
    const { hash: _hash, ...body } = event;
    if (event.hash !== sha256(eventBody(body))) fail('integrity_failure', 'Saved run event integrity check failed.');
    const data = eventData(event);
    if (!isSavedRunEventData(data)) fail('invalid_record', 'Saved run event does not match schema version 1.');
    if (event.sequence === 1 && data.type !== 'run_created') fail('invalid_record', 'Saved run event history is invalid.');
    if (event.sequence > 1 && data.type === 'run_created') fail('invalid_record', 'Saved run creation event is duplicated.');

    if (data.type === 'run_resumed') {
      if (status !== 'stopped' && status !== 'evaluation_failed') fail('invalid_record', 'Saved run resume transition is invalid.');
      if (data.segment !== segment + 1 || !noUnresolvedExecution(events.slice(0, event.sequence - 1))) {
        fail('invalid_record', 'Saved run resume transition is invalid.');
      }
      if (hasPendingEvaluationFailure(events.slice(0, event.sequence - 1)) !== (data.evaluationRecoveryApproved === true)) {
        fail('invalid_record', 'Saved run recovery decision is missing or unexpected.');
      }
      segment = data.segment;
      lastApproved = undefined;
    } else if (data.type === 'iteration_reserved') {
      if (status !== 'active' || data.iteration !== lastIteration + 1 || data.iteration > checkpoint.iterationLimit) {
        fail('invalid_record', 'Saved run iteration reservation is invalid.');
      }
      lastIteration = data.iteration;
      evaluationSettled = false;
      lastApproved = undefined;
    } else if (data.type === 'evaluation_completed' || data.type === 'evaluation_failed') {
      if (status !== 'active' || data.iteration !== lastIteration || evaluationSettled) {
        fail('invalid_record', 'Saved run evaluation transition is invalid.');
      }
      evaluationSettled = true;
      lastApproved = undefined;
    } else if (data.type === 'action_approved') {
      if (status !== 'active' || data.iteration !== lastIteration || !evaluationSettled || lastApproved !== undefined) {
        fail('invalid_record', 'Saved run approval history is invalid.');
      }
      if ((data.action === 'CALL_CODEX' && checkpoint.configuration.workerSelection === 'claude') ||
          (data.action === 'CALL_CLAUDE' && checkpoint.configuration.workerSelection === 'codex') ||
          (data.action === 'CALL_CODEX' && checkpoint.configuration.codexNetworkAccess &&
            checkpoint.configuration.workerSelection === 'claude')) {
        fail('invalid_record', 'Saved run approval conflicts with its immutable worker selection.');
      }
      lastApproved = { iteration: data.iteration, action: data.action };
    } else if (data.type === 'execution_reserved') {
      if (status !== 'active' || data.iteration !== lastIteration || !lastApproved ||
          lastApproved.iteration !== data.iteration || lastApproved.action !== data.action ||
          reservedAttempts.has(data.attemptId)) {
        fail('invalid_record', 'Saved run execution reservation is invalid.');
      }
      reservedAttempts.add(data.attemptId);
      if (data.action === 'CALL_CODEX' || data.action === 'CALL_CLAUDE') {
        workerCalls[data.action] += 1;
        if (workerCalls[data.action] > 2) fail('limit_reached', 'Saved run worker-call limit was exceeded.');
      }
      lastApproved = undefined;
    } else if (data.type === 'execution_outcome') {
      if (status !== 'active' || !reservedAttempts.has(data.attemptId) || finishedAttempts.has(data.attemptId)) {
        fail('invalid_record', 'Saved run execution outcome has no matching reservation.');
      }
      finishedAttempts.add(data.attemptId);
    } else if (data.type === 'clarification_recorded') {
      if (status !== 'active' || data.iteration !== lastIteration || lastApproved?.action !== 'ASK_USER') {
        fail('invalid_record', 'Saved run clarification history is invalid.');
      }
      lastApproved = undefined;
    } else if (data.type === 'run_stopped') {
      if (status !== 'active' && status !== 'evaluation_failed') fail('invalid_record', 'Saved run stop transition is invalid.');
      if (data.resumable && !noUnresolvedExecution(events.slice(0, event.sequence - 1))) {
        fail('invalid_record', 'An unresolved execution cannot be marked resumable.');
      }
      if (data.reason === 'evaluation_failure' && status !== 'evaluation_failed') {
        fail('invalid_record', 'Saved run evaluation-failure stop is invalid.');
      }
      lastApproved = undefined;
    } else if (data.type === 'run_finished') {
      if (status !== 'active' || lastApproved?.action !== 'FINISH' || !hasPassedValidation(checkpoint.state) ||
          !noUnresolvedExecution(events.slice(0, event.sequence - 1))) {
        fail('invalid_record', 'Saved run completion history is invalid.');
      }
    } else if (data.type === 'iteration_limit') {
      if ((status !== 'active' && status !== 'evaluation_failed') || lastIteration !== checkpoint.iterationLimit ||
          !noUnresolvedExecution(events.slice(0, event.sequence - 1))) {
        fail('invalid_record', 'Saved run budget history is invalid.');
      }
    }

    status = eventStatus(data);
    previousHash = event.hash;
    expectedSequence += 1;
  }

  if (checkpoint.sequence !== events.length || checkpoint.ledgerHead !== previousHash || checkpoint.status !== status) {
    fail('integrity_failure', 'Saved run checkpoint and event history disagree.');
  }
  if (events.at(-1)?.stateHash !== sha256(JSON.stringify(checkpoint.state))) {
    fail('integrity_failure', 'Saved run state does not match its event history.');
  }
  if ((lastIteration > 0 && checkpoint.state.iteration !== lastIteration) ||
      (lastIteration === 0 && checkpoint.state.iteration !== 1)) {
    fail('invalid_record', 'Saved run state and iteration history disagree.');
  }
  if (checkpoint.state.codexCalls !== workerCalls.CALL_CODEX || checkpoint.state.claudeCalls !== workerCalls.CALL_CLAUDE) {
    fail('invalid_record', 'Saved run worker counters are inconsistent.');
  }
}

function parseEvent(value: unknown): SavedRunEvent {
  if (!isRecord(value) || value.schemaVersion !== SAVED_RUN_SCHEMA_VERSION ||
      !Number.isInteger(value.sequence) || !timestampString(value.timestamp) ||
      (value.previousHash !== null && (typeof value.previousHash !== 'string' || !HASH_PATTERN.test(value.previousHash))) ||
      typeof value.identityHash !== 'string' || !HASH_PATTERN.test(value.identityHash) ||
      typeof value.stateHash !== 'string' || !HASH_PATTERN.test(value.stateHash) ||
      typeof value.hash !== 'string' || !HASH_PATTERN.test(value.hash)) {
    fail('invalid_record', 'Saved run event does not match schema version 1.');
  }
  const data: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!['schemaVersion', 'sequence', 'timestamp', 'previousHash', 'identityHash', 'stateHash', 'hash'].includes(key)) data[key] = item;
  }
  if (!isSavedRunEventData(data)) fail('invalid_record', 'Saved run event does not match schema version 1.');
  const { hash, ...body } = value as SavedRunEvent;
  if (sha256(eventBody(body)) !== hash) fail('integrity_failure', 'Saved run event integrity check failed.');
  return value as SavedRunEvent;
}

function parseCheckpoint(text: string): SavedRunCheckpointV1 {
  if (Buffer.byteLength(text, 'utf8') > SAVED_RUN_CHECKPOINT_LIMIT_BYTES) {
    fail('limit_reached', 'Saved run checkpoint exceeds its size limit.');
  }
  let parsed: unknown;
  try {
    parsed = parseSavedRunJson(text);
  } catch {
    fail('invalid_record', 'Saved run checkpoint contains invalid JSON.');
  }
  if (!isRecord(parsed)) fail('invalid_record', 'Saved run checkpoint is invalid.');
  if (parsed.schemaVersion !== SAVED_RUN_SCHEMA_VERSION) fail('unsupported_version', 'Saved run schema version is not supported.');
  const keys = ['schemaVersion', 'runId', 'createdAt', 'updatedAt', 'sequence', 'ledgerHead', 'status',
    'iterationLimit', 'repository', 'configuration', 'state', 'checksum'];
  if (Object.keys(parsed).length !== keys.length || Object.keys(parsed).some((key) => !keys.includes(key)) ||
      typeof parsed.runId !== 'string' || !isSavedRunId(parsed.runId) ||
      !timestampString(parsed.createdAt) || !timestampString(parsed.updatedAt) ||
      !Number.isInteger(parsed.sequence) || (parsed.sequence as number) < 1 ||
      typeof parsed.ledgerHead !== 'string' || !HASH_PATTERN.test(parsed.ledgerHead) ||
      !['active', 'stopped', 'evaluation_failed', 'finished', 'iteration_limit', 'blocked'].includes(String(parsed.status)) ||
      !Number.isInteger(parsed.iterationLimit) || (parsed.iterationLimit as number) < 1 || (parsed.iterationLimit as number) > 8 ||
      !isSavedRunRepository(parsed.repository) || !isSavedRunConfiguration(parsed.configuration) ||
      !isSavedAgentState(parsed.state) || parsed.state.repo.root !== parsed.repository.root ||
      parsed.state.workerSelection !== parsed.configuration.workerSelection ||
      (parsed.state.codexNetworkAccess === true) !== parsed.configuration.codexNetworkAccess ||
      typeof parsed.checksum !== 'string' || !HASH_PATTERN.test(parsed.checksum)) {
    fail('invalid_record', 'Saved run checkpoint does not match schema version 1.');
  }
  const { checksum, ...body } = parsed as SavedRunCheckpointV1;
  if (sha256(checkpointBody(body)) !== checksum) fail('integrity_failure', 'Saved run checkpoint integrity check failed.');
  return parsed as SavedRunCheckpointV1;
}

async function ensurePrivateDirectory(directory: string): Promise<string> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) fail('storage_failure', 'Saved run storage directory is not a regular directory.');
    if (process.platform !== 'win32' && (details.mode & 0o077) !== 0) {
      await chmod(directory, 0o700);
      const restricted = await lstat(directory);
      if ((restricted.mode & 0o077) !== 0) fail('storage_failure', 'Saved run storage permissions could not be restricted.');
    }
    return await realpath(directory);
  } catch (error) {
    if (error instanceof SavedRunStoreError) throw error;
    throw new SavedRunStoreError('storage_failure', 'Unable to create private saved run storage.');
  }
}

export function defaultSavedRunDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = os.homedir(),
): string {
  if (platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA;
    const root = localAppData && path.win32.isAbsolute(localAppData)
      ? localAppData
      : path.win32.join(homeDirectory, 'AppData', 'Local');
    return path.win32.join(root, 'dev-orchestrator', 'saved-runs');
  }
  if (platform === 'darwin') return path.join(homeDirectory, 'Library', 'Application Support', 'dev-orchestrator', 'saved-runs');
  const xdgStateHome = environment.XDG_STATE_HOME;
  const root = xdgStateHome && path.posix.isAbsolute(xdgStateHome)
    ? xdgStateHome
    : path.join(homeDirectory, '.local', 'state');
  return path.join(root, 'dev-orchestrator', 'saved-runs');
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function boundedRead(file: string, maximumBytes: number): Promise<string> {
  let handle;
  try {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail('invalid_record', 'Saved run file is not regular.');
    }
    if (entry.nlink !== 1) fail('limit_reached', 'Saved run file is not regular or exceeds its size limit.');
    handle = await open(file, fsConstants.O_RDONLY | NOFOLLOW);
    const details = await handle.stat();
    if (!details.isFile() || details.nlink !== 1 || details.size > maximumBytes ||
        details.dev !== entry.dev || details.ino !== entry.ino) {
      fail('limit_reached', 'Saved run file is not regular or exceeds its size limit.');
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, Math.min(64 * 1024, buffer.length - offset), offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > maximumBytes) fail('limit_reached', 'Saved run file exceeds its size limit.');
    }
    return buffer.subarray(0, offset).toString('utf8');
  } catch (error) {
    if (error instanceof SavedRunStoreError) throw error;
    throw new SavedRunStoreError('storage_failure', 'Unable to read saved run storage.');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicWrite(file: string, contents: string, maximumBytes: number): Promise<void> {
  if (Buffer.byteLength(contents, 'utf8') > maximumBytes) fail('limit_reached', 'Saved run checkpoint exceeds its size limit.');
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.tmp-${randomUUID()}`);
  let handle;
  try {
    try {
      const destination = await lstat(file);
      if (!destination.isFile() || destination.isSymbolicLink() || destination.nlink !== 1) {
        fail('storage_failure', 'Saved run checkpoint path is not a regular file.');
      }
    } catch (error) {
      if (error instanceof SavedRunStoreError || !hasErrorCode(error, 'ENOENT')) throw error;
    }
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof SavedRunStoreError) throw error;
    throw new SavedRunStoreError('storage_failure', 'Unable to durably write saved run state.');
  }
}

async function appendDurably(file: string, record: string, totalLimit: number): Promise<void> {
  if (Buffer.byteLength(record, 'utf8') > SAVED_RUN_EVENT_LIMIT_BYTES) fail('limit_reached', 'Saved run event exceeds its size limit.');
  let handle;
  try {
    const current = await lstat(file);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.size + Buffer.byteLength(record, 'utf8') > totalLimit) {
      fail('limit_reached', 'Saved run event ledger is not regular or exceeds its size limit.');
    }
    handle = await open(file, fsConstants.O_WRONLY | fsConstants.O_APPEND | NOFOLLOW);
    await handle.writeFile(record, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(path.dirname(file));
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (error instanceof SavedRunStoreError) throw error;
    throw new SavedRunStoreError('storage_failure', 'Unable to append saved run history.');
  }
}

function eventTotalLimit(): number {
  return SAVED_RUN_EVENT_LIMIT * SAVED_RUN_EVENT_LIMIT_BYTES;
}

function eventFilePath(directory: string, runId: string): string {
  return path.join(directory, 'runs', runId, 'events.jsonl');
}

function checkpointFilePath(directory: string, runId: string): string {
  return path.join(directory, 'runs', runId, 'checkpoint.json');
}

function lockPath(directory: string, name: string): string {
  return path.join(directory, 'locks', `${name}.lock`);
}

function eventToRecord(
  data: SavedRunEventData,
  sequence: number,
  previousHash: string | null,
  identityHash: string,
  stateHash: string,
): SavedRunEvent {
  const body = {
    schemaVersion: SAVED_RUN_SCHEMA_VERSION,
    sequence,
    timestamp: new Date().toISOString(),
    previousHash,
    identityHash,
    stateHash,
    ...data,
  } as Omit<SavedRunEvent, 'hash'>;
  return withEventHash(body);
}

function checkpointFrom(
  previous: SavedRunCheckpointV1 | undefined,
  input: Omit<SavedRunCheckpointV1, 'checksum' | 'sequence' | 'ledgerHead' | 'updatedAt' | 'status'>,
  event: SavedRunEvent,
): SavedRunCheckpointV1 {
  const body = {
    schemaVersion: SAVED_RUN_SCHEMA_VERSION,
    runId: input.runId,
    createdAt: input.createdAt,
    updatedAt: event.timestamp,
    sequence: event.sequence,
    ledgerHead: event.hash,
    status: eventStatus(eventData(event)),
    iterationLimit: input.iterationLimit,
    repository: input.repository,
    configuration: input.configuration,
    state: input.state,
  } satisfies Omit<SavedRunCheckpointV1, 'checksum'>;
  if (previous && (previous.runId !== body.runId || previous.createdAt !== body.createdAt ||
      previous.iterationLimit !== body.iterationLimit || JSON.stringify(previous.repository) !== JSON.stringify(body.repository) ||
      JSON.stringify(previous.configuration) !== JSON.stringify(body.configuration) || previous.state.task !== body.state.task)) {
    fail('invalid_input', 'Saved run identity and approved configuration are immutable.');
  }
  return withCheckpointChecksum(body);
}

async function acquireFileLock(
  directory: string,
  name: string,
  kind: SavedRunOwnership['kind'],
  key: string,
): Promise<SavedRunOwnership> {
  const file = lockPath(directory, name);
  const token = randomUUID();
  const details = JSON.stringify({ schemaVersion: SAVED_RUN_SCHEMA_VERSION, kind, key, token, pid: process.pid, createdAt: new Date().toISOString() });
  let handle;
  let created = false;
  try {
    handle = await open(file, 'wx', 0o600);
    created = true;
    await handle.writeFile(details, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(path.dirname(file));
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (created) await rm(file, { force: true }).catch(() => undefined);
    if (hasErrorCode(error, 'EEXIST')) fail('busy', 'Another process owns this saved run or worktree.');
    if (error instanceof SavedRunStoreError) throw error;
    throw new SavedRunStoreError('storage_failure', 'Unable to acquire saved run ownership.');
  }
  let released = false;
  return {
    kind,
    key,
    token,
    lockPath: file,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      let raw: string;
      try { raw = await boundedRead(file, MAX_LOCK_BYTES); } catch {
        fail('busy', 'Saved run ownership changed before it could be released.');
      }
      let lock: unknown;
      try { lock = parseSavedRunJson(raw); } catch { fail('busy', 'Saved run ownership changed before it could be released.'); }
      if (!isRecord(lock) || lock.token !== token || lock.key !== key || lock.kind !== kind) {
        fail('busy', 'Saved run ownership changed before it could be released.');
      }
      try {
        await unlink(file);
        await syncDirectory(path.dirname(file));
      } catch {
        fail('storage_failure', 'Unable to release saved run ownership.');
      }
    },
  };
}

export class SavedRunStore {
  readonly directory: string;
  readonly runsDirectory: string;
  readonly locksDirectory: string;

  private constructor(directory: string) {
    this.directory = directory;
    this.runsDirectory = path.join(directory, 'runs');
    this.locksDirectory = path.join(directory, 'locks');
  }

  static async open(directory: string = defaultSavedRunDirectory()): Promise<SavedRunStore> {
    try {
      const root = await ensurePrivateDirectory(directory);
      const runs = await ensurePrivateDirectory(path.join(root, 'runs'));
      const locks = await ensurePrivateDirectory(path.join(root, 'locks'));
      if (runs !== path.join(root, 'runs') || locks !== path.join(root, 'locks')) {
        fail('storage_failure', 'Saved run storage contains a symbolic link.');
      }
      return new SavedRunStore(root);
    } catch (error) {
      if (error instanceof SavedRunStoreError) throw error;
      throw new SavedRunStoreError('storage_failure', 'Unable to open saved run storage.');
    }
  }

  /** Inspection never initializes storage, changes permissions, or acquires ownership. */
  static async openForInspection(directory: string = defaultSavedRunDirectory()): Promise<SavedRunStore | undefined> {
    try {
      let root;
      try { root = await lstat(directory); } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return undefined;
        throw error;
      }
      if (!root.isDirectory() || root.isSymbolicLink()) {
        fail('storage_failure', 'Saved run storage is not a regular directory.');
      }
      const canonical = await realpath(directory);
      for (const name of ['runs', 'locks']) {
        const child = path.join(canonical, name);
        const details = await lstat(child);
        if (!details.isDirectory() || details.isSymbolicLink() || await realpath(child) !== child) {
          fail('storage_failure', 'Saved run storage contains an invalid directory.');
        }
      }
      return new SavedRunStore(canonical);
    } catch (error) {
      if (error instanceof SavedRunStoreError) throw error;
      throw new SavedRunStoreError('storage_failure', 'Unable to inspect saved run storage.');
    }
  }

  async listIdsForInspection(): Promise<{ runIds: string[]; ignoredEntries: number }> {
    const runIds: string[] = [];
    let scanned = 0;
    let ignoredEntries = 0;
    try {
      const directory = await opendir(this.runsDirectory);
      for await (const entry of directory) {
        scanned += 1;
        if (scanned > SAVED_RUN_COUNT_LIMIT) fail('limit_reached', 'Saved run store exceeds its entry limit. Inspect a known run ID directly.');
        if (isSavedRunId(entry.name)) runIds.push(entry.name);
        else ignoredEntries += 1;
      }
      return { runIds: runIds.sort(), ignoredEntries };
    } catch (error) {
      if (error instanceof SavedRunStoreError) throw error;
      throw new SavedRunStoreError('storage_failure', 'Unable to list saved run storage.');
    }
  }

  async readForInspection(runId: string): Promise<{
    checkpoint: SavedRunCheckpointV1;
    events: SavedRunEvent[];
    ownership: { run: boolean; worktree: boolean };
  }> {
    if (!isSavedRunId(runId)) fail('invalid_input', 'Saved run ID is invalid.');
    const exists = async (name: string): Promise<boolean> => {
      try { await lstat(lockPath(this.directory, name)); return true; } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return false;
        fail('storage_failure', 'Saved run ownership could not be inspected.');
      }
    };
    const requireStableRead = async (): Promise<void> => {
      if (await exists(`update-${runId}`)) {
        fail('busy', 'Saved run is being updated or has unresolved update ownership.');
      }
    };
    await requireStableRead();
    // A concurrent write may yield an integrity error. Never repair or guess at
    // partially committed evidence, and never use this snapshot to authorize work.
    const record = await this.readUnlocked(runId);
    await requireStableRead();
    const root = record.checkpoint.repository.root;
    const key = sha256(process.platform === 'win32' ? root.toLowerCase() : root);
    return {
      ...record,
      ownership: {
        run: await exists(`run-${runId}`),
        worktree: await exists(`worktree-${key}`),
      },
    };
  }

  async acquireRunOwnership(runId: string): Promise<SavedRunOwnership> {
    if (!isSavedRunId(runId)) fail('invalid_input', 'Saved run ID is invalid.');
    return acquireFileLock(this.directory, `run-${runId}`, 'run', runId);
  }

  async acquireWorktreeOwnership(root: string): Promise<SavedRunOwnership> {
    let canonicalRoot: string;
    try { canonicalRoot = await realpath(root); } catch { fail('invalid_input', 'Worktree path is unavailable.'); }
    if (!path.isAbsolute(canonicalRoot)) fail('invalid_input', 'Worktree path is invalid.');
    const relative = path.relative(canonicalRoot, this.directory);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      fail('invalid_input', 'Saved run storage must be outside the selected worktree.');
    }
    const key = sha256(process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot);
    return acquireFileLock(this.directory, `worktree-${key}`, 'worktree', key);
  }

  async create(input: SavedRunCreateInput): Promise<SavedRunCheckpointV1> {
    if (!Number.isInteger(input.iterationLimit) || input.iterationLimit < 1 || input.iterationLimit > 8 ||
        !isSavedRunRepository(input.repository) || !isSavedRunConfiguration(input.configuration)) {
      fail('invalid_input', 'Saved run creation input is invalid.');
    }
    const state = normalizeState(input.state);
    if (state.repo.root !== input.repository.root || state.iteration !== 1 ||
        state.workerSelection !== input.configuration.workerSelection ||
        (state.codexNetworkAccess === true) !== input.configuration.codexNetworkAccess ||
        state.codexCalls !== 0 || state.claudeCalls !== 0) {
      fail('invalid_input', 'Saved run state does not match its repository or immutable configuration.');
    }
    if (isWithin(input.repository.root, this.directory)) {
      fail('invalid_input', 'Saved run storage must be outside the selected worktree.');
    }
    const storeLock = await acquireFileLock(this.directory, 'store', 'run', 'store');
    try {
      const entries = await readdir(this.runsDirectory, { withFileTypes: true });
      const runs = entries.filter((entry) => entry.isDirectory()).length;
      if (runs >= SAVED_RUN_COUNT_LIMIT) fail('limit_reached', 'Saved run store reached its record limit.');
      const runId = input.runId ?? randomUUID();
      if (!isSavedRunId(runId)) fail('invalid_input', 'Saved run ID is invalid.');
      const runDirectory = path.join(this.runsDirectory, runId);
      try { await mkdir(runDirectory, { mode: 0o700 }); } catch { fail('storage_failure', 'Unable to create saved run record.'); }
      if (process.platform !== 'win32') await chmod(runDirectory, 0o700);
      const createdAt = (input.createdAt ?? new Date()).toISOString();
      const identity = {
        schemaVersion: SAVED_RUN_SCHEMA_VERSION,
        runId,
        createdAt,
        iterationLimit: input.iterationLimit,
        repository: input.repository,
        configuration: input.configuration,
      };
      const event = eventToRecord({ type: 'run_created' }, 1, null,
        runIdentityHash(identity), sha256(JSON.stringify(state)));
      const eventText = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(eventText, 'utf8') > SAVED_RUN_EVENT_LIMIT_BYTES) fail('limit_reached', 'Saved run event exceeds its size limit.');
      const checkpoint = checkpointFrom(undefined, {
        schemaVersion: SAVED_RUN_SCHEMA_VERSION,
        runId,
        createdAt,
        iterationLimit: input.iterationLimit,
        repository: input.repository,
        configuration: input.configuration,
        state,
      }, event);
      validateEventSequence([event], checkpoint);
      let eventHandle;
      try {
        eventHandle = await open(eventFilePath(this.directory, runId), 'wx', 0o600);
        await eventHandle.writeFile(eventText, 'utf8');
        await eventHandle.sync();
        await eventHandle.close();
        eventHandle = undefined;
        await syncDirectory(runDirectory);
      } catch {
        await eventHandle?.close().catch(() => undefined);
        fail('storage_failure', 'Unable to create saved run event history.');
      }
      await atomicWrite(checkpointFilePath(this.directory, runId), `${JSON.stringify(checkpoint)}\n`, SAVED_RUN_CHECKPOINT_LIMIT_BYTES);
      await syncDirectory(this.runsDirectory);
      return checkpoint;
    } catch (error) {
      if (error instanceof SavedRunStoreError) throw error;
      throw new SavedRunStoreError('storage_failure', 'Unable to create saved run record.');
    } finally {
      await storeLock.release();
    }
  }

  async read(runId: string): Promise<{ checkpoint: SavedRunCheckpointV1; events: SavedRunEvent[] }> {
    if (!isSavedRunId(runId)) fail('invalid_input', 'Saved run ID is invalid.');
    const updateLock = await acquireFileLock(this.directory, `update-${runId}`, 'run', runId);
    try { return await this.readUnlocked(runId); } finally { await updateLock.release(); }
  }

  async append(
    runId: string,
    eventData: SavedRunEventInput,
    nextState: SavedRunCheckpointV1['state'],
    repositorySnapshot?: RepositorySnapshot,
  ): Promise<SavedRunCheckpointV1> {
    if (!isSavedRunId(runId) || !isSavedRunEventData(eventData) || eventData.type === 'run_created') {
      fail('invalid_input', 'Saved run event input is invalid.');
    }
    const state = normalizeState(nextState);
    const updateLock = await acquireFileLock(this.directory, `update-${runId}`, 'run', runId);
    try {
      const { checkpoint: previous, events } = await this.readUnlocked(runId);
      if (repositorySnapshot !== undefined) {
        if (eventData.type !== 'run_stopped' || !isRepositorySnapshot(repositorySnapshot)) {
          fail('invalid_input', 'Repository snapshots belong only to a stopped run.');
        }
        eventData = { ...eventData, repositorySnapshotHash: snapshotHash(repositorySnapshot) };
      }
      if (['finished', 'iteration_limit', 'blocked'].includes(previous.status)) {
        fail('invalid_input', 'Saved run is terminal and cannot accept new events.');
      }
      if (previous.status !== 'active' && eventData.type !== 'run_resumed' && eventData.type !== 'run_blocked' &&
          eventData.type !== 'run_stopped' && !(previous.status === 'evaluation_failed' && eventData.type === 'iteration_limit')) {
        fail('invalid_input', 'Saved run must be explicitly resumed before recording more work.');
      }
      if (eventData.type === 'run_resumed') {
        const expectedSegment = 2 + events.filter((event) => event.type === 'run_resumed').length;
        if ((previous.status !== 'stopped' && previous.status !== 'evaluation_failed') || eventData.segment !== expectedSegment ||
            hasPendingEvaluationFailure(events) !== (eventData.evaluationRecoveryApproved === true)) {
          fail('invalid_input', 'Saved run continuation does not match its prior stop.');
        }
      }
      if (eventData.type === 'run_finished' && !hasPassedValidation(state)) {
        fail('invalid_input', 'Saved run cannot be marked finished without current-generation independent validation.');
      }
      if (eventData.type === 'iteration_reserved' && (eventData.iteration > previous.iterationLimit ||
          eventData.iteration !== Math.max(0, ...events.filter((event) => event.type === 'iteration_reserved')
            .map((event) => event.iteration)) + 1)) {
        fail('limit_reached', 'Saved run iteration limit cannot be exceeded or reset.');
      }
      if (state.task !== previous.state.task || state.repo.root !== previous.repository.root ||
          state.workerSelection !== previous.configuration.workerSelection ||
          (state.codexNetworkAccess === true) !== previous.configuration.codexNetworkAccess ||
          state.codexCalls < previous.state.codexCalls || state.claudeCalls < previous.state.claudeCalls) {
        fail('invalid_input', 'Saved run task, repository, worker, and networking settings are immutable.');
      }
      const event = eventToRecord(eventData, previous.sequence + 1, previous.ledgerHead,
        runIdentityHash(previous), sha256(JSON.stringify(state)));
      if (event.sequence > SAVED_RUN_EVENT_LIMIT) fail('limit_reached', 'Saved run event limit was reached.');
      const checkpoint = checkpointFrom(previous, {
        schemaVersion: SAVED_RUN_SCHEMA_VERSION,
        runId: previous.runId,
        createdAt: previous.createdAt,
        iterationLimit: previous.iterationLimit,
        repository: previous.repository,
        configuration: previous.configuration,
        state,
      }, event);
      validateEventSequence([...events, event], checkpoint);
      if (repositorySnapshot) {
        await atomicWrite(path.join(this.runsDirectory, runId, 'repository.json'), JSON.stringify(repositorySnapshot), SNAPSHOT_RECORD_BYTES);
      }
      await appendDurably(eventFilePath(this.directory, runId), `${JSON.stringify(event)}\n`, eventTotalLimit());
      await atomicWrite(checkpointFilePath(this.directory, runId), `${JSON.stringify(checkpoint)}\n`, SAVED_RUN_CHECKPOINT_LIMIT_BYTES);
      return checkpoint;
    } catch (error) {
      if (error instanceof SavedRunStoreError) throw error;
      throw new SavedRunStoreError('storage_failure', 'Unable to update saved run record.');
    } finally {
      await updateLock.release();
    }
  }

  async readRepositorySnapshot(runId: string, expectedHash: string): Promise<RepositorySnapshot> {
    if (!isSavedRunId(runId) || !HASH_PATTERN.test(expectedHash)) fail('invalid_input', 'Repository snapshot identity is invalid.');
    const raw = await boundedRead(path.join(this.runsDirectory, runId, 'repository.json'), SNAPSHOT_RECORD_BYTES);
    let parsed: unknown;
    try { parsed = parseSavedRunJson(raw); } catch { fail('invalid_record', 'Saved repository snapshot is malformed.'); }
    if (!isRepositorySnapshot(parsed)) fail('invalid_record', 'Saved repository snapshot exceeds its contract.');
    if (snapshotHash(parsed) !== expectedHash) fail('integrity_failure', 'Saved repository snapshot does not match the stop ledger.');
    return parsed;
  }

  private async readUnlocked(runId: string): Promise<{ checkpoint: SavedRunCheckpointV1; events: SavedRunEvent[] }> {
    const runDirectory = path.join(this.runsDirectory, runId);
    try {
      const directory = await lstat(runDirectory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) fail('invalid_record', 'Saved run directory is not regular.');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) fail('not_found', 'Saved run record was not found.');
      if (error instanceof SavedRunStoreError) throw error;
      throw new SavedRunStoreError('storage_failure', 'Unable to read saved run record.');
    }
    let checkpoint: SavedRunCheckpointV1;
    let eventText: string;
    try {
      checkpoint = parseCheckpoint(await boundedRead(checkpointFilePath(this.directory, runId), SAVED_RUN_CHECKPOINT_LIMIT_BYTES));
      eventText = await boundedRead(eventFilePath(this.directory, runId), eventTotalLimit());
    } catch (error) {
      if (error instanceof SavedRunStoreError) throw error;
      throw new SavedRunStoreError('storage_failure', 'Unable to read saved run record.');
    }
    if (checkpoint.runId !== runId || !eventText.endsWith('\n')) fail('invalid_record', 'Saved run event history is incomplete.');
    const lines = eventText.slice(0, -1).split('\n');
    if (lines.length > SAVED_RUN_EVENT_LIMIT) fail('limit_reached', 'Saved run event history exceeds its limit.');
    const events = lines.map((line) => {
      if (Buffer.byteLength(line, 'utf8') > SAVED_RUN_EVENT_LIMIT_BYTES) fail('limit_reached', 'Saved run event exceeds its size limit.');
      let parsed: unknown;
      try { parsed = parseSavedRunJson(line); } catch { fail('invalid_record', 'Saved run event contains invalid JSON.'); }
      return parseEvent(parsed);
    });
    validateEventSequence(events, checkpoint);
    return { checkpoint, events };
  }
}

export async function openSavedRunStore(directory?: string): Promise<SavedRunStore> {
  return SavedRunStore.open(directory);
}
