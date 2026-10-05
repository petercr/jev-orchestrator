import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CandidateSelectionError,
  deriveSearchTerms,
  MAX_CLAUDE_CALLS,
  MAX_CODEX_CALLS,
  proposalSignature,
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
  it.each([
    ['codex', 'CALL_CODEX', 'CALL_CLAUDE'], ['claude', 'CALL_CLAUDE', 'CALL_CODEX'],
  ] as const)('resolves only the %s worker and retains its call limit', async (workerSelection, permitted, excluded) => {
    const initial = state(await temporaryRoot(), { workerSelection });
    await expect(selectCandidate(permitted, initial)).resolves.toMatchObject({ action: permitted });
    await expect(selectCandidate(excluded, initial)).resolves.toMatchObject({ action: 'ASK_USER', tool: null, input: null, reason: expect.stringContaining('worker selection') });
    initial.codexCalls = MAX_CODEX_CALLS;
    initial.claudeCalls = MAX_CLAUDE_CALLS;
    await expect(selectCandidate(permitted, initial)).resolves.toMatchObject({ action: 'ASK_USER', reason: expect.stringContaining('call limit') });
  });

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

  it('reads repository instructions before a searched source file', async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, 'CONTRIBUTING.md'), 'Use npm run verify.');
    await writeFile(path.join(root, 'source.ts'), 'export {};');
    const initial = state(root);
    initial.repo.topLevelFiles = ['source.ts', 'CONTRIBUTING.md'];
    await expect(selectCandidate('READ_FILE', initial, ['source.ts'])).resolves.toMatchObject({ input: { path: 'CONTRIBUTING.md' } });
    initial.filesRead = ['CONTRIBUTING.md'];
    await expect(selectCandidate('READ_FILE', initial, ['source.ts'])).resolves.toMatchObject({ input: { path: 'source.ts' } });
  });

  it.each(['RUN_TESTS', 'CALL_CODEX', 'CALL_CLAUDE', 'FINISH'] as const)(
    'does not resolve %s before linked-task preparation', async (action) => {
      const initial = state(await temporaryRoot(), { task: 'https://github.com/owner/repo/issues/80' });
      await expect(selectCandidate(action, initial)).resolves.toMatchObject({ action: 'ASK_USER', tool: null, input: null });
      initial.evidence = {
        revision: 0, validationGeneration: 0, clarifications: [], findings: [], failures: [],
        issue: { url: initial.task, title: 'Task', body: '', requestedValidationScripts: [], truncated: false },
      };
      initial.repo.topLevelFiles = ['AGENTS.md'];
      await expect(selectCandidate(action, initial)).resolves.toMatchObject({ action: 'ASK_USER' });
      initial.filesRead = ['AGENTS.md'];
      await expect(selectCandidate(action, initial)).resolves.toMatchObject({ action });
    },
  );

  it('cannot skip an unsafe required instruction file for an unrelated safe read', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(path.join(outside, 'instructions.md'), 'Outside instructions.');
    await symlink(path.join(outside, 'instructions.md'), path.join(root, 'AGENTS.md'));
    await writeFile(path.join(root, 'README.md'), 'Safe unrelated read.');
    const initial = state(root, { task: 'https://github.com/owner/repo/issues/80' });
    initial.repo.topLevelFiles = ['AGENTS.md', 'README.md'];
    await expect(selectCandidate('READ_FILE', initial, ['README.md'])).resolves.toMatchObject({
      action: 'ASK_USER', reason: expect.stringContaining('AGENTS.md cannot be read safely'),
    });
  });

  it('reads the task issue when earlier evidence is for another issue', async () => {
    const initial = state(await temporaryRoot(), { task: 'https://github.com/owner/repo/issues/80?tracking=ignored' });
    initial.evidence = {
      revision: 0, validationGeneration: 0, clarifications: [], findings: [], failures: [],
      issue: { url: 'https://github.com/owner/repo/issues/81', title: 'Other task', body: '', requestedValidationScripts: [], truncated: false },
    };
    await expect(selectCandidate('CALL_CODEX', initial)).resolves.toMatchObject({ action: 'ASK_USER' });
    await expect(selectCandidate('READ_ISSUE', initial)).resolves.toMatchObject({ action: 'READ_ISSUE', input: { url: 'https://github.com/owner/repo/issues/80' } });
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
      reason: expect.stringContaining('No declared validation script'),
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

  it('requires user information or a new work generation to retry failed validation', async () => {
    const root = await temporaryRoot();
    const current = state(root, {
      evidence: {
        revision: 0, validationGeneration: 1, clarifications: [], findings: [], failures: [],
      },
    });
    const candidate = await selectCandidate('RUN_TESTS', current);
    const failedKey = proposalSignature(candidate, current);
    current.evidence!.revision += 1;
    current.evidence!.lastRevisionSource = 'diagnostic';
    expect(proposalSignature(candidate, current)).toBe(failedKey);
    current.evidence!.clarifications.push({ iteration: 2, text: 'Dependencies are now installed.' });
    expect(proposalSignature(candidate, current)).not.toBe(failedKey);
    current.evidence!.clarifications = [];
    current.evidence!.validationGeneration += 1;
    expect(proposalSignature(candidate, current)).not.toBe(failedKey);
  });
});
