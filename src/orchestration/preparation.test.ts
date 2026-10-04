import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectRepo } from '../repo/inspect.js';
import type { Action, EvaluationResult } from '../types.js';
import { executeCandidate, type ToolResult } from './execute.js';
import { createInitialState, runOrchestration } from './loop.js';

const roots: string[] = [];
const issueUrl = 'https://github.com/owner/repo/issues/80';

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-preparation-'));
  roots.push(root);
  await writeFile(path.join(root, 'CONTRIBUTING.md'), 'Use npm test.');
  await writeFile(path.join(root, 'CLAUDE.md'), 'Keep edits small.');
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  return inspectRepo(root);
}

function evaluation(choice: Action = 'CALL_CODEX'): EvaluationResult {
  return {
    model: 'mock/jev', latencyMs: 0, rawAnswers: {},
    assessment: {
      taskComplete: { probability: 0.1 }, needsMoreInformation: { probability: 0.01 },
      needsTesting: { probability: 0.99 }, stuck: { probability: 0.01 },
      nextAction: { choice, probabilities: { [choice]: 0.9 }, confidence: 0.8 },
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('linked-task preparation in the approval loop', () => {
  it('records safe instruction aliases so an internal symlink does not repeat the same read', async () => {
    const repo = await repository();
    await symlink(path.join(repo.root, 'CONTRIBUTING.md'), path.join(repo.root, 'AGENTS.md'));
    const initial = createInitialState(await inspectRepo(repo.root), issueUrl);
    const paths: string[] = [];
    const execute = vi.fn<typeof executeCandidate>().mockImplementation(async (proposal) => {
      if (proposal.action === 'READ_ISSUE') return {
        action: 'READ_ISSUE', ok: true, exitCode: 0, timedOut: false, durationMs: 1, output: 'Task', files: [],
        issue: { url: issueUrl, title: 'Task', body: 'Fix config.', requestedValidationScripts: [], truncated: false },
      } satisfies ToolResult;
      if (proposal.action === 'READ_FILE') paths.push(proposal.input.path);
      return executeCandidate(proposal, vi.fn());
    });
    const result = await runOrchestration(initial, {
      evaluate: async () => evaluation(),
      approve: async ({ proposal }) => proposal.action === 'CALL_CODEX' ? { kind: 'stop' } : { kind: 'approve' },
      askForInformation: vi.fn(), execute,
    });
    expect(result).toMatchObject({ status: 'stopped', iterations: 4, state: { codexCalls: 0 } });
    expect(paths).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(result.state.filesRead).toEqual(['AGENTS.md', 'CONTRIBUTING.md', 'CLAUDE.md']);
  });

  it('uses explicit user context after an unavailable issue, then requires instructions and post-worker validation', async () => {
    const repo = await repository();
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const runner = vi.fn();
    const proposals: Action[] = [];
    const execute = vi.fn<typeof executeCandidate>().mockImplementation(async (proposal) => {
      if (proposal.action === 'CALL_CODEX') {
        expect(proposal.input.context).not.toHaveProperty('issue');
        expect(proposal.input.context.clarifications).toContainEqual({ iteration: 2, text: 'Fix config. Run npm test.' });
        expect(proposal.input.context.findings.flatMap((finding) => finding.paths)).toEqual(expect.arrayContaining(['CONTRIBUTING.md', 'CLAUDE.md']));
        await writeFile(path.join(repo.root, 'fix.ts'), 'export {};\n');
        return { action: 'CALL_CODEX', ok: true, exitCode: 0, timedOut: false, durationMs: 1, output: 'Patch complete; tests passed (unverified worker claim).', files: [] } satisfies ToolResult;
      }
      return executeCandidate(proposal, runner);
    });
    const askForInformation = vi.fn().mockResolvedValue('Fix config. Run npm test.');
    const result = await runOrchestration(createInitialState(repo, issueUrl), {
      evaluate: async () => evaluation(),
      approve: async ({ proposal }) => {
        proposals.push(proposal.action);
        return proposal.action === 'RUN_TESTS' ? { kind: 'stop' } : { kind: 'approve' };
      },
      askForInformation, execute,
      inspect: async () => ({ ...repo, gitStatus: ['?? fix.ts'] }),
    });
    expect(proposals).toEqual(['READ_ISSUE', 'ASK_USER', 'READ_FILE', 'READ_FILE', 'CALL_CODEX', 'RUN_TESTS']);
    expect(result).toMatchObject({ status: 'stopped', iterations: 6, state: { codexCalls: 1, claudeCalls: 0, tests: { ran: false }, evidence: { validationGeneration: 1 } } });
    expect(result.state.evidence).not.toHaveProperty('issue');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(askForInformation).toHaveBeenCalledOnce();
    expect(runner).not.toHaveBeenCalled();
    expect(await readFile(path.join(repo.root, 'fix.ts'), 'utf8')).toBe('export {};\n');
  });

  it.each(['RUN_TESTS', 'CALL_CODEX', 'CALL_CLAUDE', 'FINISH'] as const)(
    'rejects an early %s alternative without executing a tool', async (action) => {
      const execute = vi.fn();
      const initial = createInitialState(await repository(), issueUrl);
      initial.tests = { ran: true, passed: true };
      const result = await runOrchestration(initial, {
        evaluate: async () => evaluation(),
        approve: async ({ allowedAlternatives, proposal }) => {
          expect(proposal.action).toBe('READ_ISSUE');
          expect(allowedAlternatives).toContain('READ_ISSUE');
          expect(allowedAlternatives).not.toContain(action);
          return { kind: 'alternative', action };
        },
        askForInformation: vi.fn(), execute,
      }, { maxIterations: 1 });
      expect(result).toMatchObject({ status: 'iteration_limit', exitCode: 1, state: { codexCalls: 0, claudeCalls: 0 } });
      expect(result.state.evidence).not.toHaveProperty('issue');
      expect(execute).not.toHaveBeenCalled();
      const record = JSON.parse((await readFile(result.tracePath, 'utf8')).trim());
      expect(record).toMatchObject({
        approval: { kind: 'reject', history: [{ kind: 'alternative', action }, { kind: 'reject' }] },
        toolInput: { url: issueUrl }, toolResult: null,
      });
    },
  );

  it.each(['stop', 'interrupt'] as const)('does not fabricate fetched context or execute on %s at the preparatory approval', async (control) => {
    const controller = new AbortController();
    const execute = vi.fn();
    const result = await runOrchestration(createInitialState(await repository(), issueUrl), {
      evaluate: async () => evaluation(),
      approve: async () => {
        if (control === 'stop') return { kind: 'stop' };
        controller.abort();
        return { kind: 'approve' };
      },
      askForInformation: vi.fn(), execute,
    }, { signal: controller.signal });
    expect(result.status).toBe('stopped');
    expect(result.state.evidence).not.toHaveProperty('issue');
    expect(result.state.filesRead).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    const record = JSON.parse((await readFile(result.tracePath, 'utf8')).trim());
    expect(record).toMatchObject({ proposal: { selected: { action: 'READ_ISSUE' } }, toolInput: null, toolResult: null });
    if (control === 'interrupt') expect(record.approval).toBeNull();
  });

  it('rechecks required context when a worker proposal is approved', async () => {
    const initial = createInitialState(await repository(), issueUrl);
    initial.filesRead = ['CONTRIBUTING.md', 'CLAUDE.md'];
    initial.evidence!.issue = { url: issueUrl, title: 'Task', body: 'Fix config.', requestedValidationScripts: [], truncated: false };
    const execute = vi.fn();
    const result = await runOrchestration(initial, {
      evaluate: async () => evaluation(),
      approve: async ({ state, proposal }) => {
        expect(proposal.action).toBe('CALL_CODEX');
        state.filesRead = [];
        return { kind: 'approve' };
      },
      askForInformation: vi.fn(), execute,
    }, { maxIterations: 1 });
    expect(result.status).toBe('iteration_limit');
    expect(result.state.codexCalls).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });
});
