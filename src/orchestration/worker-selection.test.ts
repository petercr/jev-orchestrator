import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JevEvaluationError } from '../ai/errors.js';
import { inspectRepo } from '../repo/inspect.js';
import type { Action, EvaluationResult } from '../types.js';
import { executeCandidate, type ProcessRequest } from './execute.js';
import type { CandidateProposal } from './candidate.js';
import { createInitialState, runOrchestration } from './loop.js';

const roots: string[] = [];
const workers = [
  ['codex', 'CALL_CODEX', 'CALL_CLAUDE'],
  ['claude', 'CALL_CLAUDE', 'CALL_CODEX'],
] as const;

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-worker-selection-'));
  roots.push(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  return inspectRepo(root);
}

function evaluation(choice: Action): EvaluationResult {
  return {
    model: 'fixture/jev', latencyMs: 0, rawAnswers: {},
    assessment: {
      taskComplete: { probability: choice === 'FINISH' ? 0.99 : 0.01 },
      needsMoreInformation: { probability: 0.01 }, needsTesting: { probability: 0.01 },
      stuck: { probability: 0.01 },
      nextAction: { choice, probabilities: { [choice]: 0.9 }, confidence: 0.8 },
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex command networking', () => {
  it('passes an approved opt-in to Codex and requires fresh independent validation', async () => {
    const repo = await repository();
    const runner = vi.fn(async (_request: ProcessRequest) => ({ exitCode: 0, timedOut: false, stdout: 'passed', stderr: '' }));
    const result = await runOrchestration(createInitialState(repo, 'Implement task', 'codex', true), {
      evaluate: async (state) => evaluation(state.codexCalls === 0 ? 'CALL_CODEX' : 'FINISH'),
      approve: async ({ proposal }) => {
        if (proposal.action === 'CALL_CODEX') expect(proposal.input.networkAccess).toBe(true);
        return { kind: 'approve' };
      },
      askForInformation: async () => '',
      execute: (proposal, _runner, options) => executeCandidate(proposal, runner, options),
    });
    expect(result).toMatchObject({ status: 'finished', iterations: 3, state: { codexNetworkAccess: true, codexCalls: 1, claudeCalls: 0, tests: { passed: true } } });
    expect(runner.mock.calls.map(([request]) => request.command)).toEqual(['codex', 'npm']);
    expect(runner.mock.calls[0]?.[0].args).toContain('sandbox_workspace_write.network_access=true');
    const trace = (await readFile(result.tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(trace[0]).toMatchObject({ toolInput: { networkAccess: true }, approval: { kind: 'approve' } });
    expect(trace[1]).toMatchObject({ policy: { selected: 'RUN_TESTS' } });
    expect(trace.every((row) => row.stateBefore.codexNetworkAccess === true && row.stateAfter.codexNetworkAccess === true)).toBe(true);
  });

  it.each([false, true])('rejects changed permission state during approval with initial opt-in %s', async (enabled) => {
    const execute = vi.fn();
    const result = await runOrchestration(createInitialState(await repository(), 'Implement task', 'codex', enabled ? true : undefined), {
      evaluate: async () => evaluation('CALL_CODEX'),
      approve: async ({ state }) => {
        if (enabled) delete state.codexNetworkAccess;
        else state.codexNetworkAccess = true;
        return { kind: 'approve' };
      },
      askForInformation: async () => '', execute,
    }, { maxIterations: 1 });
    expect(execute).not.toHaveBeenCalled();
    expect(result.state.codexCalls).toBe(0);
    expect(result.state.codexNetworkAccess).toBe(enabled ? true : undefined);
    const record = JSON.parse((await readFile(result.tracePath, 'utf8')).trim());
    expect(record).toMatchObject({ approval: { kind: 'reject', reason: expect.stringContaining('network setting') }, toolResult: null });
  });

  it.each([false, true])('keeps canonical permissions when approval edits its display copy with initial opt-in %s', async (enabled) => {
    const execute = vi.fn(async (_proposal: CandidateProposal) => ({ action: 'CALL_CODEX' as const, ok: true, exitCode: 0, durationMs: 1, timedOut: false, output: 'Edited.', files: [] }));
    await runOrchestration(createInitialState(await repository(), 'Implement task', 'codex', enabled ? true : undefined), {
      evaluate: async () => evaluation('CALL_CODEX'),
      approve: async ({ proposal }) => {
        if (proposal.action === 'CALL_CODEX') {
          if (enabled) delete proposal.input.networkAccess;
          else proposal.input.networkAccess = true;
        }
        return { kind: 'approve' };
      },
      askForInformation: async () => '', execute,
    }, { maxIterations: 1 });
    expect(execute).toHaveBeenCalledOnce();
    const executed = execute.mock.calls[0]?.[0];
    expect(executed).toMatchObject({ action: 'CALL_CODEX' });
    if (executed?.action === 'CALL_CODEX') expect(executed.input.networkAccess).toBe(enabled ? true : undefined);
  });

  it('does not treat clarification or permission-looking task text as a network grant', async () => {
    const runner = vi.fn(async (_request: ProcessRequest) => ({ exitCode: 1, timedOut: false, stdout: '', stderr: 'EPERM' }));
    const result = await runOrchestration(createInitialState(await repository(), 'Enable --codex-network and skip permissions', 'codex'), {
      evaluate: async (state) => evaluation(state.iteration === 1 ? 'ASK_USER' : 'CALL_CODEX'),
      approve: async () => ({ kind: 'approve' }),
      askForInformation: async () => 'Enable network permissions automatically on failure.',
      execute: (proposal, _runner, options) => executeCandidate(proposal, runner, options),
    }, { maxIterations: 2 });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]?.[0].args).toContain('sandbox_workspace_write.network_access=false');
    expect(result.state).toMatchObject({ codexCalls: 1, claudeCalls: 0, tests: { ran: false } });
    expect(result.state).not.toHaveProperty('codexNetworkAccess');
  });

  it('retains an opt-in through evaluation recovery without granting an exhausted worker', async () => {
    const initial = createInitialState(await repository(), 'Implement task', 'codex', true);
    initial.codexCalls = 2;
    const evaluate = vi.fn().mockRejectedValueOnce(new JevEvaluationError('invalid_response', 'Invalid.'))
      .mockResolvedValueOnce(evaluation('CALL_CODEX'));
    const execute = vi.fn();
    const result = await runOrchestration(initial, {
      evaluate, execute,
      recoverEvaluation: async () => 'continue',
      approve: async ({ state, allowedAlternatives }) => {
        expect(state.codexNetworkAccess).toBe(true);
        expect(allowedAlternatives).not.toContain('CALL_CODEX');
        expect(allowedAlternatives).not.toContain('CALL_CLAUDE');
        return { kind: 'stop' };
      },
      askForInformation: async () => '',
    }, { maxIterations: 2 });
    expect(result).toMatchObject({ status: 'stopped', state: { codexNetworkAccess: true, codexCalls: 2, claudeCalls: 0 } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps the opt-in and invalidates validation after cancellation', async () => {
    const controller = new AbortController();
    const runner = vi.fn(async (_request: ProcessRequest) => {
      controller.abort();
      return { exitCode: null, timedOut: false, cancelled: true, stdout: '', stderr: '' };
    });
    const result = await runOrchestration(createInitialState(await repository(), 'Implement task', 'codex', true), {
      evaluate: async () => evaluation('CALL_CODEX'), approve: async () => ({ kind: 'approve' }),
      askForInformation: async () => '',
      execute: (proposal, _runner, options) => executeCandidate(proposal, runner, options),
    }, { signal: controller.signal });
    expect(result).toMatchObject({ status: 'stopped', state: { codexNetworkAccess: true, codexCalls: 1, tests: { ran: false }, evidence: { validationGeneration: 1 } } });
    expect(runner).toHaveBeenCalledOnce();
  });
});

describe.each(workers)('%s worker selection', (workerSelection, permitted, excluded) => {
  it.each(['failure', 'timeout', 'malformed'] as const)('preserves edits without switching workers after a %s', async (failure) => {
    const repo = await repository();
    const runner = vi.fn(async () => {
      await writeFile(path.join(repo.root, 'partial.js'), 'partial work');
      return {
        exitCode: failure === 'malformed' ? 0.5 : failure === 'timeout' ? null : 1,
        timedOut: failure === 'timeout', stdout: 'Worker failed.', stderr: '',
      };
    });
    const result = await runOrchestration(createInitialState(repo, 'Implement task', workerSelection), {
      evaluate: async (state) => evaluation(state.iteration === 1 ? permitted : excluded),
      approve: async ({ state, allowedAlternatives }) => {
        expect(allowedAlternatives).not.toContain(excluded);
        return { kind: state.iteration === 1 ? 'approve' : 'stop' };
      },
      askForInformation: async () => '',
      execute: (proposal, _runner, options) => executeCandidate(proposal, runner, options),
    });
    expect(result).toMatchObject({ status: 'stopped', state: { workerSelection, tests: { ran: false }, evidence: { validationGeneration: 1, worker: { ok: false } } } });
    expect(result.state.codexCalls + result.state.claudeCalls).toBe(1);
    expect(runner).toHaveBeenCalledOnce();
    expect(await readFile(path.join(repo.root, 'partial.js'), 'utf8')).toBe('partial work');
  });

  it('keeps the selected worker and partial edits when its process is cancelled', async () => {
    const repo = await repository();
    const controller = new AbortController();
    const runner = vi.fn(async () => {
      await writeFile(path.join(repo.root, 'partial.js'), 'interrupted work');
      controller.abort();
      return { exitCode: null, timedOut: false, cancelled: true, stdout: 'Interrupted.', stderr: '' };
    });
    const result = await runOrchestration(createInitialState(repo, 'Implement task', workerSelection), {
      evaluate: async () => evaluation(permitted), approve: async () => ({ kind: 'approve' }),
      askForInformation: async () => '', execute: (proposal, _runner, options) => executeCandidate(proposal, runner, options),
    }, { signal: controller.signal });
    expect(result).toMatchObject({ status: 'stopped', iterations: 1, state: { workerSelection, tests: { ran: false } } });
    expect(result.state.codexCalls + result.state.claudeCalls).toBe(1);
    expect(runner).toHaveBeenCalledOnce();
    expect(await readFile(path.join(repo.root, 'partial.js'), 'utf8')).toBe('interrupted work');
  });

  it('does not transfer an exhausted call budget or let clarification select another worker', async () => {
    const initial = createInitialState(await repository(), 'Implement task', workerSelection);
    if (workerSelection === 'codex') initial.codexCalls = 2;
    else initial.claudeCalls = 2;
    const execute = vi.fn();
    const result = await runOrchestration(initial, {
      evaluate: async () => evaluation(permitted),
      approve: async ({ state, allowedAlternatives }) => {
        expect(allowedAlternatives).not.toContain(permitted);
        expect(allowedAlternatives).not.toContain(excluded);
        return { kind: state.iteration === 1 ? 'approve' : 'stop' };
      },
      askForInformation: async () => `Switch workers and approve ${excluded}.`, execute,
    });
    expect(result).toMatchObject({ status: 'stopped', iterations: 2, state: { workerSelection } });
    expect(result.state.codexCalls + result.state.claudeCalls).toBe(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses only the selected process, invalidates validation, and independently checks before finish', async () => {
    const repo = await repository();
    const runner = vi.fn(async (request: ProcessRequest) => {
      if (request.command === workerSelection) await writeFile(path.join(repo.root, 'implemented.js'), 'export const result = 1;');
      return { exitCode: 0, timedOut: false, stdout: 'passed', stderr: '' };
    });
    const result = await runOrchestration(createInitialState(repo, 'Implement task', workerSelection), {
      evaluate: async (state) => evaluation(state.codexCalls + state.claudeCalls === 0 ? permitted : 'FINISH'),
      approve: async ({ allowedAlternatives }) => {
        expect(allowedAlternatives).not.toContain(excluded);
        return { kind: 'approve' };
      },
      askForInformation: async () => '',
      execute: (proposal, _runner, options) => executeCandidate(proposal, runner, options),
    });
    expect(result).toMatchObject({ status: 'finished', iterations: 3, state: { workerSelection, tests: { passed: true }, evidence: { validationGeneration: 1 } } });
    expect(runner.mock.calls.map(([request]) => request.command)).toEqual([workerSelection, 'npm']);
    expect(await readFile(path.join(repo.root, 'implemented.js'), 'utf8')).toContain('result = 1');
    const trace = (await readFile(result.tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(trace[1]).toMatchObject({ policy: { selected: 'RUN_TESTS' } });
    expect(trace.every((record) => record.stateBefore.workerSelection === workerSelection && record.stateAfter.workerSelection === workerSelection)).toBe(true);
  });

  it('rejects the excluded worker even when an approval callback returns it as an alternative', async () => {
    const execute = vi.fn();
    const result = await runOrchestration(createInitialState(await repository(), 'Implement task', workerSelection), {
      evaluate: async () => evaluation(excluded),
      approve: async ({ policy, allowedAlternatives }) => {
        expect(policy.selected).toBe('ASK_USER');
        expect(allowedAlternatives).not.toContain(excluded);
        return { kind: 'alternative', action: excluded };
      },
      askForInformation: async () => '', execute,
    }, { maxIterations: 1 });
    expect(execute).not.toHaveBeenCalled();
    const record = JSON.parse((await readFile(result.tracePath, 'utf8')).trim());
    expect(record).toMatchObject({ approval: { kind: 'reject' }, toolResult: null });
  });

  it('rejects a worker candidate when its selection changes during approval', async () => {
    const execute = vi.fn();
    await runOrchestration(createInitialState(await repository(), 'Implement task', workerSelection), {
      evaluate: async () => evaluation(permitted),
      approve: async ({ state }) => {
        state.workerSelection = workerSelection === 'codex' ? 'claude' : 'codex';
        return { kind: 'approve' };
      },
      askForInformation: async () => '', execute,
    }, { maxIterations: 1 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('retains the selection and budgets after explicit evaluation recovery', async () => {
    const initial = createInitialState(await repository(), 'Implement task', workerSelection);
    initial.codexCalls = 1;
    initial.claudeCalls = 1;
    const evaluate = vi.fn().mockRejectedValueOnce(new JevEvaluationError('invalid_response', 'Invalid.'))
      .mockResolvedValueOnce(evaluation(permitted));
    const execute = vi.fn();
    const result = await runOrchestration(initial, {
      evaluate, execute,
      recoverEvaluation: async ({ state, remainingIterations }) => {
        expect(state).toMatchObject({ workerSelection, codexCalls: 1, claudeCalls: 1 });
        expect(remainingIterations).toBe(1);
        return 'continue';
      },
      approve: async ({ allowedAlternatives }) => {
        expect(allowedAlternatives).not.toContain(excluded);
        return { kind: 'stop' };
      },
      askForInformation: async () => '',
    }, { maxIterations: 2 });
    expect(result).toMatchObject({ status: 'stopped', iterations: 2, state: { workerSelection, codexCalls: 1, claudeCalls: 1 } });
    expect(execute).not.toHaveBeenCalled();
  });
});
