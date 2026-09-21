import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CandidateSelectionError,
  deriveSearchTerms,
  MAX_CLAUDE_CALLS,
  MAX_CODEX_CALLS,
  resolveSafeRepoFile,
  selectCandidate,
} from './candidate.js';
import type { AgentState } from '../types.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-candidate-'));
  roots.push(root);
  return root;
}

function state(root: string, overrides: Partial<AgentState> = {}): AgentState {
  return {
    task: 'Fix preview authentication failure',
    iteration: 1,
    currentGoal: 'Choose the next action',
    repo: {
      root,
      packageManager: 'pnpm',
      scripts: ['deploy', 'test'],
      validationScripts: ['test'],
      gitStatus: [],
      topLevelFiles: ['README.md', 'package.json'],
    },
    filesRead: [],
    filesModified: [],
    observations: [],
    commandsRun: [],
    tests: { ran: false },
    failedApproaches: [],
    codexCalls: 0,
    claudeCalls: 0,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('candidate selection', () => {
  it('derives a small literal search from task text', () => {
    expect(deriveSearchTerms('Inspect this repo and fix Preview auth auth!')).toEqual([
      'fix',
      'Preview',
      'auth',
    ]);
    expect(deriveSearchTerms('the repo')).toEqual(['README']);
  });

  it('rejects traversal, secret files, and symlink escape', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(path.join(root, 'safe.ts'), 'safe');
    await writeFile(path.join(root, '.env'), 'SECRET=value');
    await writeFile(path.join(outside, 'outside.ts'), 'outside');
    await symlink(path.join(outside, 'outside.ts'), path.join(root, 'linked.ts'));
    await symlink(path.join(root, '.env'), path.join(root, 'environment.txt'));

    await expect(resolveSafeRepoFile(root, '../outside.ts')).rejects.toBeInstanceOf(CandidateSelectionError);
    await expect(resolveSafeRepoFile(root, '.env')).rejects.toThrow('secret-file policy');
    await expect(resolveSafeRepoFile(root, 'linked.ts')).rejects.toThrow('outside');
    await expect(resolveSafeRepoFile(root, 'environment.txt')).rejects.toThrow('secret-file policy');
    await expect(resolveSafeRepoFile(root, 'safe.ts')).resolves.toBe('safe.ts');
  });

  it('selects only safe unread search results for a read', async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'README.md'), 'read me');
    await writeFile(path.join(root, 'package.json'), '{}');
    await writeFile(path.join(root, 'src', 'auth.ts'), 'export {};');

    await expect(selectCandidate('READ_FILE', state(root), ['src/auth.ts'])).resolves.toMatchObject({
      action: 'READ_FILE',
      input: { path: 'src/auth.ts' },
    });
  });

  it('builds validation commands only from detected scripts and lockfiles', async () => {
    const root = await temporaryRoot();
    await expect(selectCandidate('RUN_TESTS', state(root))).resolves.toMatchObject({
      action: 'RUN_TESTS',
      input: { command: 'pnpm', args: ['run', 'test'], script: 'test' },
    });

    const noScripts = state(root, {
      repo: { ...state(root).repo, validationScripts: [] },
    });
    await expect(selectCandidate('RUN_TESTS', noScripts)).resolves.toMatchObject({
      action: 'ASK_USER',
      reason: expect.stringContaining('No recognized validation script'),
    });
  });

  it('selects only fixed diagnostics and bounded coding-agent calls', async () => {
    const root = await temporaryRoot();
    await expect(selectCandidate('RUN_COMMAND', state(root))).resolves.toMatchObject({
      action: 'RUN_COMMAND',
      tool: 'diagnostic_command',
      input: {
        root,
        diagnostic: 'git_status',
        command: 'git',
        args: [
          '--no-pager',
          '--no-optional-locks',
          '-c',
          'core.fsmonitor=false',
          'status',
          '--short',
          '--untracked-files=all',
          '--no-renames',
          '--ignore-submodules=all',
          '--',
          '.',
          ':(exclude)traces/**',
        ],
      },
    });
    await expect(selectCandidate('RUN_COMMAND', state(root, {
      repo: { ...state(root).repo, gitStatus: ['?? src/new.ts'] },
    }))).resolves.toMatchObject({
      input: { diagnostic: 'git_status' },
    });
    await expect(selectCandidate('RUN_COMMAND', state(root, {
      repo: { ...state(root).repo, gitStatus: [' M src/auth.ts'] },
    }))).resolves.toMatchObject({
      action: 'RUN_COMMAND',
      input: {
        diagnostic: 'git_diff_stat',
        command: 'git',
        args: [
          '--no-pager',
          '--no-optional-locks',
          '-c',
          'core.fsmonitor=false',
          'diff',
          '--stat',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--ignore-submodules=all',
          'HEAD',
          '--',
          '.',
          ':(exclude)traces/**',
        ],
      },
    });
    await expect(selectCandidate('CALL_CODEX', state(root))).resolves.toMatchObject({
      action: 'CALL_CODEX',
      tool: 'codex_cli',
      input: {
        root,
        task: 'Fix preview authentication failure',
      },
    });
    await expect(selectCandidate('CALL_CLAUDE', state(root))).resolves.toMatchObject({
      action: 'CALL_CLAUDE',
      tool: 'claude_code_cli',
      input: {
        root,
        task: 'Fix preview authentication failure',
      },
    });
  });

  it('stops proposing Codex after the per-run call limit', async () => {
    const root = await temporaryRoot();
    await expect(selectCandidate('CALL_CODEX', state(root, {
      codexCalls: MAX_CODEX_CALLS,
    }))).resolves.toMatchObject({
      action: 'ASK_USER',
      reason: expect.stringContaining('call limit'),
    });
  });

  it('stops proposing Claude after the per-run call limit', async () => {
    const root = await temporaryRoot();
    await expect(selectCandidate('CALL_CLAUDE', state(root, {
      claudeCalls: MAX_CLAUDE_CALLS,
    }))).resolves.toMatchObject({
      action: 'ASK_USER',
      reason: expect.stringContaining('call limit'),
    });
  });
});
