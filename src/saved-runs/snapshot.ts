import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { inspectGitFiles, inspectGitIdentity } from '../repo/inspect.js';
import { REPOSITORY_INSTRUCTION_FILES } from '../repo/preparation.js';
import { redactSensitiveText } from '../logging/trace.js';
import type { SavedRunRepository } from './types.js';

export const SNAPSHOT_FILE_LIMIT = 512;
export const SNAPSHOT_FILE_BYTES = 1_048_576;
export const SNAPSHOT_TOTAL_BYTES = 32 * 1_048_576;
export const SNAPSHOT_RECORD_BYTES = 512 * 1_024;

export type RepositorySnapshot = {
  version: 1;
  files: Array<{ path: string; hash: string | null }>;
};

function safePath(file: string): boolean {
  return file.length > 0 && file.length <= 512 && !path.isAbsolute(file) &&
    !file.includes('\\') && !/[\u0000-\u001f\u007f\ufffd]/u.test(file) &&
    !file.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function excluded(file: string): boolean {
  return file.split('/').some((part) =>
    /^(?:\.git|\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|\.aws|credentials?.*|secrets?.*|id_(?:rsa|dsa|ecdsa|ed25519).*|node_modules|dist|traces|\.entire|\.cache|\.next|\.turbo|coverage|\.venv)$/iu.test(part)) ||
    /\.(?:key|pem|p12|pfx)$/iu.test(file);
}

export function isRepositorySnapshot(value: unknown): value is RepositorySnapshot {
  if (value === null || typeof value !== 'object' || !('version' in value) || value.version !== 1 ||
      !('files' in value) || !Array.isArray(value.files) || value.files.length > SNAPSHOT_FILE_LIMIT ||
      Object.keys(value).length !== 2) return false;
  const names = new Set<string>();
  return value.files.every((item: unknown) => {
    if (item === null || typeof item !== 'object' || Object.keys(item).length !== 2 ||
        !('path' in item) || typeof item.path !== 'string' || !safePath(item.path) || excluded(item.path) ||
        redactSensitiveText(item.path) !== item.path ||
        names.has(item.path) || !('hash' in item) || (item.hash !== null &&
          (typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(item.hash)))) return false;
    names.add(item.path);
    return true;
  });
}

export function snapshotHash(snapshot: RepositorySnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export async function captureRepositorySnapshot(repository: SavedRunRepository): Promise<RepositorySnapshot> {
  const identity = await inspectGitIdentity(repository.root);
  if (identity.root !== repository.root || identity.gitCommonDirectory !== repository.gitCommonDirectory || identity.head !== repository.head) {
    throw new Error('Saved repository identity or HEAD changed; continuation is blocked.');
  }
  const enumerated = await inspectGitFiles(repository.root);
  const names = [...new Set([
    ...enumerated, 'package.json', ...REPOSITORY_INSTRUCTION_FILES,
  ])].filter((file) => !excluded(file)).sort();
  if (names.length > SNAPSHOT_FILE_LIMIT || names.some((file) => !safePath(file))) {
    throw new Error('Repository file comparison exceeds its bounds or contains an unsafe path.');
  }
  if (names.some((file) => redactSensitiveText(file) !== file)) {
    throw new Error('Repository comparison paths contain sensitive text and cannot be retained safely.');
  }
  let total = 0;
  const observed = new Map<string, string | null>();
  const metadata = (entry: { ino: number; dev: number; size: number; mtimeMs: number; ctimeMs: number }): string =>
    JSON.stringify([entry.ino, entry.dev, entry.size, entry.mtimeMs, entry.ctimeMs]);
  const files: RepositorySnapshot['files'] = [];
  for (const name of names) {
    const file = path.join(repository.root, name);
    let details;
    try { details = await lstat(file); } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        files.push({ path: name, hash: null });
        observed.set(name, null);
        continue;
      }
      throw new Error('Repository file comparison is unavailable.');
    }
    if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 ||
        details.size > SNAPSHOT_FILE_BYTES || await realpath(file) !== file) {
      throw new Error('Repository comparison requires bounded regular files without links.');
    }
    total += details.size;
    if (total > SNAPSHOT_TOTAL_BYTES) throw new Error('Repository content comparison exceeds its total byte limit.');
    const handle = await open(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      const buffer = Buffer.alloc(details.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      const after = await handle.stat();
      const current = await lstat(file);
      if (offset !== details.size || before.ino !== details.ino || before.dev !== details.dev ||
          before.nlink !== 1 || after.nlink !== 1 || before.mtimeMs !== details.mtimeMs ||
          after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
          current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink()) {
        throw new Error('Repository contents changed during comparison. Retry after edits stop.');
      }
      files.push({ path: name, hash: createHash('sha256').update(buffer.subarray(0, offset)).digest('hex') });
      observed.set(name, metadata(after));
    } finally { await handle.close(); }
  }
  if (JSON.stringify(enumerated) !== JSON.stringify(await inspectGitFiles(repository.root))) {
    throw new Error('Repository file enumeration changed during comparison.');
  }
  for (const name of names) {
    let current: string | null;
    try { current = metadata(await lstat(path.join(repository.root, name))); } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') current = null;
      else throw new Error('Repository metadata could not be rechecked.');
    }
    if (current !== observed.get(name)) throw new Error('Repository contents changed during comparison.');
  }
  const finalIdentity = await inspectGitIdentity(repository.root);
  if (JSON.stringify(finalIdentity) !== JSON.stringify(identity)) throw new Error('Repository identity changed during comparison.');
  return { version: 1, files };
}

export function changedSnapshotPaths(previous: RepositorySnapshot, current: RepositorySnapshot): string[] {
  const before = new Map(previous.files.map((item) => [item.path, item.hash]));
  const after = new Map(current.files.map((item) => [item.path, item.hash]));
  return [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file)).sort();
}
