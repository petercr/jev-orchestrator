import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { RepoSnapshot } from '../types.js';

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', () => resolve(''));
    child.on('close', (code) => resolve(code === 0 ? output.trim() : ''));
  });
}

export async function inspectRepo(inputPath: string): Promise<RepoSnapshot> {
  const root = path.resolve(inputPath);
  const stat = await access(root).then(() => true).catch(() => false);
  if (!stat) throw new Error(`Repository path does not exist: ${root}`);

  const entries = await readdir(root, { withFileTypes: true });
  const topLevelFiles = entries
    .filter((entry) => entry.name !== 'node_modules' && entry.name !== '.git')
    .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
    .sort()
    .slice(0, 80);

  const packageJsonPath = path.join(root, 'package.json');
  let packageName: string | undefined;
  let scripts: string[] = [];
  if (await exists(packageJsonPath)) {
    const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    packageName = pkg.name;
    scripts = Object.keys(pkg.scripts ?? {}).sort();
  }

  const packageManager = (await exists(path.join(root, 'pnpm-lock.yaml')))
    ? 'pnpm'
    : (await exists(path.join(root, 'package-lock.json')))
      ? 'npm'
      : (await exists(path.join(root, 'yarn.lock')))
        ? 'yarn'
        : (await exists(path.join(root, 'bun.lock')) || await exists(path.join(root, 'bun.lockb')))
          ? 'bun'
          : 'unknown';

  const validationNames = new Set(['test', 'check', 'typecheck', 'lint', 'build']);
  const validationScripts = scripts.filter((script) =>
    [...validationNames].some((name) => script === name || script.startsWith(`${name}:`)),
  );

  const [gitBranch, status] = await Promise.all([
    git(root, ['branch', '--show-current']),
    git(root, ['status', '--short']),
  ]);

  return {
    root,
    packageManager,
    ...(packageName ? { packageName } : {}),
    scripts,
    validationScripts,
    ...(gitBranch ? { gitBranch } : {}),
    gitStatus: status ? status.split('\n').slice(0, 100) : [],
    topLevelFiles,
  };
}
