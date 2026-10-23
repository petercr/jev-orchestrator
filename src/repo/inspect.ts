import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { RepoSnapshot } from '../types.js';
import { truncateText } from '../limits.js';
import { isValidationScript, validationWorkflow } from './validation.js';

export const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
export const MAX_TOP_LEVEL_FILES = 80;
export const MAX_TOP_LEVEL_ENTRIES_SCANNED = 256;
export const MAX_SCRIPTS = 100;
export const MAX_GIT_OUTPUT_BYTES = 32 * 1024;
export const MAX_GIT_STATUS_ENTRIES = 100;
export const GIT_TIMEOUT_MS = 2_000;

const MAX_PACKAGE_NAME_LENGTH = 200;
const MAX_SCRIPT_NAME_LENGTH = 200;
const MAX_GIT_LINE_LENGTH = 500;

type PackageMetadata = {
  packageName?: string;
  scripts: string[];
  validationCommands?: Record<string, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isFile();
  } catch {
    return false;
  }
}

async function git(root: string, args: string[], required = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    let output = '';
    let outputBytes = 0;
    let interrupted = false;
    let settled = false;
    const timeout = setTimeout(() => {
      interrupted = true;
      child.kill();
    }, GIT_TIMEOUT_MS);
    timeout.unref();

    const finish = (value: string, success = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (required && !success) reject(new Error('Unable to collect bounded Git file metadata.'));
      else resolve(value);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (interrupted) return;

      const availableBytes = MAX_GIT_OUTPUT_BYTES - outputBytes;
      if (availableBytes <= 0 || chunk.length > availableBytes) {
        interrupted = true;
        child.kill();
        return;
      }

      output += chunk.toString('utf8');
      outputBytes += chunk.length;
    });
    child.on('error', () => finish(''));
    child.on('close', (code) => // Leading spaces are fixed-width Git status columns, not padding.
      finish(code === 0 && !interrupted ? output.replace(/\r?\n$/u, '') : '', code === 0 && !interrupted));
  });
}

/** Fixed read-only enumeration; no Git hooks, credentials, or optional locks. */
export async function inspectGitFiles(root: string): Promise<string[]> {
  const generated = ['node_modules', 'dist', 'traces', '.entire', '.cache', '.next', '.turbo', 'coverage', '.venv'];
  const output = await git(root, ['ls-files', '--cached', '--others',
    ...generated.map((name) => `--exclude=**/${name}/**`), '-z'], true);
  if (output !== '' && !output.endsWith('\0')) throw new Error('Git file metadata is incomplete.');
  return output === '' ? [] : [...new Set(output.slice(0, -1).split('\0'))].sort();
}

export async function orchestrationWorktreeRoot(root: string): Promise<string> {
  const canonical = await realpath(root);
  const gitRoot = await git(canonical, ['rev-parse', '--show-toplevel']);
  return gitRoot ? await realpath(gitRoot) : canonical;
}

async function readTopLevelFiles(root: string): Promise<string[]> {
  const directory = await opendir(root);
  const entries: string[] = [];
  let scanned = 0;

  for await (const entry of directory) {
    scanned += 1;
    if (entry.name !== 'node_modules' && entry.name !== '.git') {
      entries.push(`${entry.name}${entry.isDirectory() ? '/' : ''}`);
    }
    if (scanned >= MAX_TOP_LEVEL_ENTRIES_SCANNED) break;
  }

  return entries.sort().slice(0, MAX_TOP_LEVEL_FILES);
}

async function readPackageMetadata(packageJsonPath: string): Promise<PackageMetadata> {
  if (!(await isRegularFile(packageJsonPath))) return { scripts: [] };

  try {
    const packageJson = await open(packageJsonPath, 'r');
    try {
      const contents = Buffer.alloc(MAX_PACKAGE_JSON_BYTES + 1);
      const { bytesRead } = await packageJson.read(contents, 0, contents.length, 0);
      if (bytesRead > MAX_PACKAGE_JSON_BYTES) return { scripts: [] };

      const parsed: unknown = JSON.parse(contents.subarray(0, bytesRead).toString('utf8'));
      if (!isRecord(parsed)) return { scripts: [] };

      const packageName = typeof parsed.name === 'string'
        ? truncateText(parsed.name, MAX_PACKAGE_NAME_LENGTH)
        : undefined;
      const scripts = isRecord(parsed.scripts)
        ? Object.entries(parsed.scripts)
          .filter(([, value]) => typeof value === 'string')
          .map(([name]) => truncateText(name, MAX_SCRIPT_NAME_LENGTH))
          .sort()
          .slice(0, MAX_SCRIPTS)
        : [];

      const validationCommands: Record<string, string> = {};
      for (const name of scripts.filter(isValidationScript)) {
        const command = isRecord(parsed.scripts) ? parsed.scripts[name] : undefined;
        if (typeof command === 'string') validationCommands[name] = command;
      }
      return { ...(packageName ? { packageName } : {}), scripts, validationCommands };
    } finally {
      await packageJson.close();
    }
  } catch {
    return { scripts: [] };
  }
}

async function detectPackageManager(root: string): Promise<RepoSnapshot['packageManager']> {
  if (await isRegularFile(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await isRegularFile(path.join(root, 'package-lock.json'))) return 'npm';
  if (await isRegularFile(path.join(root, 'yarn.lock'))) return 'yarn';
  if (
    (await isRegularFile(path.join(root, 'bun.lock'))) ||
    (await isRegularFile(path.join(root, 'bun.lockb')))
  ) {
    return 'bun';
  }
  return 'unknown';
}

async function inspectGit(root: string): Promise<Pick<RepoSnapshot, 'gitBranch' | 'gitStatus'>> {
  const gitRoot = await git(root, ['rev-parse', '--show-toplevel']);
  if (!gitRoot || path.resolve(gitRoot) !== root) return { gitStatus: [] };

  const [gitBranch, status] = await Promise.all([
    git(root, ['branch', '--show-current']),
    git(root, ['status', '--short', '--no-renames', '--untracked-files=all']),
  ]);

  return {
    ...(gitBranch ? { gitBranch: truncateText(gitBranch, MAX_GIT_LINE_LENGTH) } : {}),
    gitStatus: status
      ? status
        .split('\n')
        .slice(0, MAX_GIT_STATUS_ENTRIES)
        .map((line) => truncateText(line, MAX_GIT_LINE_LENGTH))
      : [],
  };
}

export async function inspectGitIdentity(root: string): Promise<{
  root: string;
  gitCommonDirectory: string;
  head: string;
}> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    throw new Error('Saved runs require an available Git worktree.');
  }
  const [gitRoot, gitCommonDirectory, head] = await Promise.all([
    git(canonicalRoot, ['rev-parse', '--show-toplevel']),
    git(canonicalRoot, ['rev-parse', '--git-common-dir']),
    git(canonicalRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
  ]);
  if (!gitRoot || !gitCommonDirectory || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(head)) {
    throw new Error('Saved runs require a Git worktree with a committed HEAD.');
  }
  const reportedGitCommonDirectory = path.resolve(canonicalRoot, gitCommonDirectory);
  let canonicalGitRoot: string;
  let canonicalGitCommonDirectory: string;
  try {
    [canonicalGitRoot, canonicalGitCommonDirectory] = await Promise.all([
      realpath(gitRoot), realpath(reportedGitCommonDirectory),
    ]);
  } catch {
    throw new Error('Saved run Git identity is unavailable.');
  }
  const pathIdentity = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
  if (pathIdentity(canonicalGitRoot) !== pathIdentity(canonicalRoot)) {
    throw new Error('Saved run path does not resolve to the selected Git worktree.');
  }
  return {
    root: canonicalRoot,
    gitCommonDirectory: canonicalGitCommonDirectory,
    head: head.toLowerCase(),
  };
}

export async function inspectRepo(inputPath: string): Promise<RepoSnapshot> {
  const root = path.resolve(inputPath);
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch {
    throw new Error(`Repository path does not exist: ${root}`);
  }
  if (!rootStat.isDirectory()) throw new Error(`Repository path must be a directory: ${root}`);

  const packageJsonPath = path.join(root, 'package.json');
  const [topLevelFiles, packageMetadata, packageManager, gitMetadata] = await Promise.all([
    readTopLevelFiles(root),
    readPackageMetadata(packageJsonPath),
    detectPackageManager(root),
    inspectGit(root),
  ]);

  const validationScripts = packageMetadata.scripts.filter(isValidationScript);

  return {
    root,
    packageManager,
    ...(packageMetadata.packageName ? { packageName: packageMetadata.packageName } : {}),
    scripts: packageMetadata.scripts,
    validationScripts,
    ...validationWorkflow(validationScripts, packageMetadata.validationCommands ?? {}, packageManager),
    ...gitMetadata,
    topLevelFiles,
  };
}
