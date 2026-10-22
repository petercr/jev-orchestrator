import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseApprovalChoice } from '../cli.js';
import { EvaluationError } from '../ai/errors.js';
import { executeCandidate } from '../orchestration/execute.js';
import { createInitialState, runOrchestration, type ApprovalContext } from '../orchestration/loop.js';
import type { ProcessRunner } from '../process.js';
import type { Action, EvaluationResult, RepoSnapshot } from '../types.js';
import { createTerminal, type CliTerminal } from './terminal.js';

let root: string;
let terminal: CliTerminal;
let repo: RepoSnapshot;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dev-terminal-loop-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  repo = { root, packageManager: 'npm', scripts: ['test'], validationScripts: ['test'], gitStatus: [], topLevelFiles: ['package.json'] };
});
afterEach(async () => { terminal?.dispose(); await rm(root, { recursive: true, force: true }); });

function evaluation(choice: Action, repair = false): EvaluationResult {
  return {
    model: 'synthetic/ui', latencyMs: 0, rawAnswers: {},
    assessment: {
      taskComplete: { probability: choice === 'FINISH' ? 0.94 : 0.01 },
      needsMoreInformation: { probability: choice === 'ASK_USER' ? 0.99 : 0.01 },
      needsTesting: { probability: choice === 'RUN_TESTS' || repair ? 0.99 : 0.01 }, stuck: { probability: 0.01 },
      nextAction: { choice, confidence: 0.99, probabilities: { [choice]: 1 } },
    },
  };
}

async function setup(plain: boolean) {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  let text = '';
  output.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  terminal = await createTerminal({ input, output, plain, environment: {}, interrupt: vi.fn() });
  return { input, output, text: () => stripVTControlCharacters(text) };
}

async function records(tracePath: string): Promise<unknown[]> {
  return (await readFile(tracePath, 'utf8')).trim().split('\n').map((line): unknown => JSON.parse(line));
}

describe.each([false, true])('real enforcement with plain=%s', (plain) => {
  it('keeps controlled repair, fresh checks, and a separate resolved completion approval', async () => {
    const io = await setup(plain);
    const route: Action[] = ['CALL_CODEX', 'RUN_TESTS', 'CALL_CODEX', 'RUN_TESTS', 'FINISH'];
    const answers = ['approve', 'approve', 'approve', 'approve', 'FINISH', 'approve'];
    const reviews: ApprovalContext[] = [];
    let checks = 0;
    const runner: ProcessRunner = vi.fn(async (request) => {
      const failed = request.command === 'npm' && ++checks === 1;
      return { exitCode: failed ? 1 : 0, timedOut: false, stdout: failed ? 'Boundary assertion failed.' : 'Fixture process completed.', stderr: '' };
    });
    const initial = createInitialState(repo, 'Fix the label boundary', 'codex');
    const result = await runOrchestration(initial, {
      evaluate: async () => { const action = route.shift()!; return evaluation(action, action === 'CALL_CODEX' && checks > 0); },
      approve: async (context) => {
        reviews.push(structuredClone(context));
        terminal.review(context);
        const pending = terminal.question('Choose approve, reject, stop, or an allowed action name: ');
        io.input.write(`${answers.shift()}\r`);
        const decision = parseApprovalChoice(await pending, context);
        if (!decision) throw new Error('Invalid fixture input.');
        return decision;
      },
      askForInformation: async () => { throw new Error('Unexpected clarification.'); },
      execute: (proposal, _runner, execution) => executeCandidate(proposal, runner, execution),
      inspect: async () => repo,
    });
    expect(result).toMatchObject({ status: 'finished', iterations: 5,
      state: { codexCalls: 2, claudeCalls: 0, evidence: { validationGeneration: 2 } },
      summary: { validation: { passed: true }, counts: { approvals: 5, alternatives: 1, validationRuns: 2 } },
    });
    expect(reviews.at(-2)).toMatchObject({ proposal: { action: 'ASK_USER' }, allowedAlternatives: expect.arrayContaining(['FINISH']) });
    expect(reviews.at(-1)).toMatchObject({ proposal: { action: 'FINISH' }, review: { source: 'alternative' } });
    expect(io.text()).toContain('Codex command network: disabled');
    expect(io.text()).toContain('original task acceptance criteria');
    const trace = await records(result.tracePath);
    expect(trace.at(-1)).toMatchObject({ approval: { history: [{ kind: 'alternative', action: 'FINISH' }, { kind: 'approve' }] } });
    expect(trace.at(-1)).toHaveProperty('stateAfter.evidence.validationGeneration', 2);
    const raw = await readFile(result.tracePath, 'utf8');
    expect(raw).not.toContain('\u001b');
    expect(raw).not.toContain('"plain":');
  });

  it('records EOF at approval without a fabricated decision or post-close execution', async () => {
    const io = await setup(plain);
    const execute = vi.fn();
    const result = await runOrchestration(createInitialState(repo, 'Inspect the fixture'), {
      evaluate: async () => evaluation('RUN_TESTS'),
      approve: async () => {
        const pending = terminal.question('Choose:'); io.input.end();
        await pending; throw new Error('EOF returned an answer.');
      },
      askForInformation: async () => '', execute,
    });
    expect(result).toMatchObject({ status: 'stopped', exitCode: 1, summary: { counts: { approvals: 0 } } });
    expect(execute).not.toHaveBeenCalled();
    expect((await records(result.tracePath)).at(-1)).toMatchObject({
      approval: null, toolInput: null, toolResult: null, promptStop: { phase: 'approval', reason: 'input_closed' },
    });
  });

  it('preserves the actual ASK_USER approval without inventing clarification after EOF', async () => {
    const io = await setup(plain);
    const result = await runOrchestration(createInitialState(repo, 'Clarify the fixture'), {
      evaluate: async () => evaluation('ASK_USER'),
      approve: async (context) => {
        const pending = terminal.question('Choose:'); io.input.write('approve\r');
        const decision = parseApprovalChoice(await pending, context);
        if (!decision) throw new Error('Invalid fixture input.');
        return decision;
      },
      askForInformation: async () => { const pending = terminal.question('Information:'); io.input.end(); return pending; },
    });
    expect(result).toMatchObject({ status: 'stopped', exitCode: 1, state: { evidence: { clarifications: [] } }, summary: { counts: { approvals: 1 } } });
    expect((await records(result.tracePath)).at(-1)).toMatchObject({ approval: { kind: 'approve' }, promptStop: { phase: 'information', reason: 'input_closed' } });
  });

  it('retains evaluation failure before EOF without inventing recovery', async () => {
    const io = await setup(plain);
    const result = await runOrchestration(createInitialState(repo, 'Inspect the fixture'), {
      evaluate: async () => { throw new EvaluationError('invalid_response', 'Fixture rejection.'); },
      approve: async () => { throw new Error('No candidate exists.'); },
      askForInformation: async () => '',
      recoverEvaluation: async () => { const pending = terminal.question('Continue or stop:'); io.input.end(); await pending; return 'continue'; },
    });
    const trace = await records(result.tracePath);
    expect(result).toMatchObject({ status: 'stopped', exitCode: 1, summary: { counts: { approvals: 0, evaluationFailures: 1, evaluationRecoveries: 0 } } });
    expect(trace[0]).toMatchObject({ failure: { code: 'invalid_response' }, approval: null });
    expect(trace.at(-1)).toMatchObject({ promptStop: { phase: 'recovery', reason: 'input_closed' }, approval: null });
    expect(trace.at(-1)).not.toHaveProperty('recovery.decision');
  });
});
