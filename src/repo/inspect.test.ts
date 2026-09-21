import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectRepo,
  MAX_GIT_OUTPUT_BYTES,
  MAX_GIT_STATUS_ENTRIES,
  MAX_PACKAGE_JSON_BYTES,
  MAX_SCRIPTS,
  MAX_TOP_LEVEL_FILES,
} from './inspect.js';

const execFile = promisify(execFileCallback);
const temporaryRoots: string[] = [];

async function createRepositoryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'jev-inspect-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('inspectRepo', () => {
  it('rejects a missing path and a path that is not a directory', async () => {
    const root = await createRepositoryDirectory();
    const file = path.join(root, 'not-a-directory');
    await writeFile(file, 'contents');

    await expect(inspectRepo(path.join(root, 'missing'))).rejects.toThrow(
      'Repository path does not exist',
    );
    await expect(inspectRepo(file)).rejects.toThrow('Repository path must be a directory');
  });

  it('treats malformed package metadata as unavailable', async () => {
    const root = await createRepositoryDirectory();
    await writeFile(path.join(root, 'package.json'), '{ not valid json');
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');

    const snapshot = await inspectRepo(root);

    expect(snapshot).toMatchObject({
      packageManager: 'pnpm',
      scripts: [],
      validationScripts: [],
      gitStatus: [],
    });
    expect(snapshot.packageName).toBeUndefined();
    expect(snapshot.gitBranch).toBeUndefined();
  });

  it('does not inherit Git metadata from an ancestor repository', async () => {
    const root = await createRepositoryDirectory();
    const nestedDirectory = path.join(root, 'nested');
    await execFile('git', ['init', '--quiet'], { cwd: root });
    await mkdir(nestedDirectory);

    const snapshot = await inspectRepo(nestedDirectory);

    expect(snapshot.gitStatus).toEqual([]);
    expect(snapshot.gitBranch).toBeUndefined();
  });

  it('treats an oversized package manifest as unavailable', async () => {
    const root = await createRepositoryDirectory();
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'x'.repeat(MAX_PACKAGE_JSON_BYTES) }),
    );

    const snapshot = await inspectRepo(root);

    expect(snapshot.packageName).toBeUndefined();
    expect(snapshot.scripts).toEqual([]);
  });

  it('bounds scripts and top-level metadata', async () => {
    const root = await createRepositoryDirectory();
    const scripts = Object.fromEntries(
      Array.from({ length: MAX_SCRIPTS + 20 }, (_, index) => [
        `test:${String(index).padStart(3, '0')}`,
        'vitest run',
      ]),
    );
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'bounded', scripts }));
    await Promise.all(
      Array.from({ length: MAX_TOP_LEVEL_FILES + 20 }, (_, index) =>
        writeFile(path.join(root, `source-${String(index).padStart(3, '0')}.ts`), ''),
      ),
    );

    const snapshot = await inspectRepo(root);

    expect(snapshot.scripts).toHaveLength(MAX_SCRIPTS);
    expect(snapshot.validationScripts).toHaveLength(MAX_SCRIPTS);
    expect(snapshot.topLevelFiles).toHaveLength(MAX_TOP_LEVEL_FILES);
  });

  it('bounds Git status entries for a repository root', async () => {
    const root = await createRepositoryDirectory();
    await execFile('git', ['init', '--quiet'], { cwd: root });
    await Promise.all(
      Array.from({ length: MAX_GIT_STATUS_ENTRIES + 20 }, (_, index) =>
        writeFile(path.join(root, `untracked-${String(index).padStart(3, '0')}.txt`), ''),
      ),
    );

    const snapshot = await inspectRepo(root);

    expect(snapshot.gitStatus).toHaveLength(MAX_GIT_STATUS_ENTRIES);
  });

  it('reports exact paths for untracked files below directories', async () => {
    const root = await createRepositoryDirectory();
    await execFile('git', ['init', '--quiet'], { cwd: root });
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'new.ts'), 'export {};');

    const snapshot = await inspectRepo(root);

    expect(snapshot.gitStatus).toEqual(['?? src/new.ts']);
  });

  it('stops collecting oversized Git output', async () => {
    const root = await createRepositoryDirectory();
    await execFile('git', ['init', '--quiet'], { cwd: root });
    const filenameLength = 240;
    const fileCount = Math.ceil(MAX_GIT_OUTPUT_BYTES / filenameLength) + 5;
    await Promise.all(
      Array.from({ length: fileCount }, (_, index) => {
        const prefix = `untracked-${String(index).padStart(3, '0')}-`;
        return writeFile(path.join(root, `${prefix}${'x'.repeat(filenameLength - prefix.length)}`), '');
      }),
    );

    const snapshot = await inspectRepo(root);

    expect(snapshot.gitStatus).toEqual([]);
  });
});
