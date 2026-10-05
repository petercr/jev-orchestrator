import { link, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

export const MAX_RENAME_FILE_BYTES = 1024 * 1024;
export const MAX_RENAME_PATH_LENGTH = 500;

export type RenameFileInput = { source: string; destination: string };

export class RenameFileError extends Error {}

function protectedPart(part: string): boolean {
  return /^(?:\.git.*|\.claude|\.codex|\.agents|\.mcp\.json|\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|\.aws|credentials.*|secrets.*|id_rsa.*|id_ed25519.*|node_modules|dist|traces|AGENTS\.md|CLAUDE\.md)$/iu.test(part) ||
    /\.(?:pem|key|p12|pfx|keystore)$/iu.test(part);
}

function relativeParts(value: string): string[] {
  const parts = value.split('/');
  if (value.length === 0 || value.length > MAX_RENAME_PATH_LENGTH || path.isAbsolute(value) ||
    /[\\:\u0000-\u001f\u007f]/u.test(value) ||
    parts.some((part) => part === '' || part === '.' || part === '..' || protectedPart(part))) {
    throw new RenameFileError('Rename paths must be bounded repository-relative paths without traversal or protected files.');
  }
  return parts;
}

async function checkedPath(root: string, parts: string[]): Promise<string> {
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new RenameFileError('Rename parents must be existing directories without symlinks.');
    }
  }
  return path.join(root, ...parts);
}

/** Move one regular file with an exclusive destination; never replace existing data. */
export async function renameRepositoryFile(root: string, input: unknown): Promise<RenameFileInput> {
  if (input === null || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).sort().join(',') !== 'destination,source' ||
    !('source' in input) || typeof input.source !== 'string' ||
    !('destination' in input) || typeof input.destination !== 'string') {
    throw new RenameFileError('Provide only string source and destination paths.');
  }
  const sourceParts = relativeParts(input.source);
  const destinationParts = relativeParts(input.destination);
  if (input.source === input.destination) throw new RenameFileError('Source and destination must be different.');

  try {
    const canonicalRoot = await realpath(root);
    if (!(await lstat(canonicalRoot)).isDirectory()) throw new RenameFileError('The selected repository must be a directory.');
    const source = await checkedPath(canonicalRoot, sourceParts);
    const destination = await checkedPath(canonicalRoot, destinationParts);
    const original = await lstat(source);
    if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1) {
      throw new RenameFileError('The source must be a regular file without symlinks or additional hard links.');
    }
    if (original.size > MAX_RENAME_FILE_BYTES) throw new RenameFileError('The source exceeds the rename file size limit.');

    // link is exclusive: unlike rename(), it cannot overwrite a destination
    // created between inspection and execution. Interruption preserves data.
    await link(source, destination);
    const current = await lstat(source);
    if (!current.isFile() || current.ino !== original.ino || current.dev !== original.dev) {
      throw new RenameFileError('The source changed during rename; both paths have been preserved for review.');
    }
    await unlink(source);
    return { source: input.source, destination: input.destination };
  } catch (error) {
    if (error instanceof RenameFileError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new RenameFileError('The destination already exists; no overwrite is allowed.');
    if (code === 'ENOENT') throw new RenameFileError('The source or a parent directory does not exist.');
    if (code === 'EXDEV') throw new RenameFileError('Both rename paths must be on the same filesystem.');
    throw new RenameFileError('Unable to complete the rename; preserve any partial edits for review.');
  }
}
