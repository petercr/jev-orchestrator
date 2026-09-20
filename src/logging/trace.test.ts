import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_TRACE_VALUE_BYTES,
  sanitizeTraceValue,
  TraceWriteError,
  writeTrace,
} from './trace.js';
import type { AgentState, EvaluationResult, PolicyDecision } from '../types.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-trace-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const state: AgentState = {
  task: 'Investigate authorization: Bearer task-token-value',
  iteration: 1,
  currentGoal: 'Choose the next action',
  repo: {
    root: '/repo',
    packageManager: 'pnpm',
    scripts: ['test'],
    validationScripts: ['test'],
    gitStatus: [],
    topLevelFiles: ['package.json'],
  },
  filesRead: [],
  filesModified: [],
  observations: [],
  commandsRun: [],
  tests: { ran: false },
  failedApproaches: [],
  codexCalls: 0,
};

const policy: PolicyDecision = {
  requested: 'SEARCH_REPO',
  selected: 'SEARCH_REPO',
  override: false,
  reason: 'Clear recommendation.',
};

function evaluation(rawAnswers: unknown): EvaluationResult {
  return {
    assessment: {
      taskComplete: { probability: 0.1 },
      needsMoreInformation: { probability: 0.1 },
      needsTesting: { probability: 0.1 },
      stuck: { probability: 0.1 },
      nextAction: {
        choice: 'SEARCH_REPO',
        probabilities: { SEARCH_REPO: 0.8 },
        confidence: 0.7,
      },
    },
    model: 'typesafe-ai/jev',
    latencyMs: 12,
    providerMetadata: { apiKey: 'provider-secret-value' },
    rawAnswers,
  };
}

describe('writeTrace', () => {
  it('redacts configured credential values in ordinary text fields', () => {
    const sanitized = sanitizeTraceValue(
      { note: 'The configured value is gateway-key-value.' },
      ['gateway-key-value'],
    );

    expect(JSON.stringify(sanitized)).not.toContain('gateway-key-value');
  });

  it('writes a versioned, unique record without raw provider metadata or secrets', async () => {
    const root = await temporaryRoot();
    const payload = {
      state,
      evaluation: evaluation({
        apiKey: 'raw-api-key-value',
        explanation: 'authorization: Bearer raw-bearer-token',
        nested: { token: 'nested-token-value' },
      }),
      policy,
    };

    const firstPath = await writeTrace(root, payload);
    const secondPath = await writeTrace(root, payload);
    const record = JSON.parse(await readFile(firstPath, 'utf8')) as Record<string, unknown>;
    const serialized = JSON.stringify(record);

    expect(firstPath).not.toBe(secondPath);
    expect(record).toMatchObject({
      schemaVersion: 1,
      runId: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.+-[0-9a-f-]{36}$/),
      state: { task: 'Investigate authorization: [REDACTED]' },
      evaluation: {
        model: 'typesafe-ai/jev',
        latencyMs: 12,
      },
      policy,
    });
    expect((record.evaluation as Record<string, unknown>)).not.toHaveProperty('providerMetadata');
    expect(serialized).not.toContain('provider-secret-value');
    expect(serialized).not.toContain('task-token-value');
    expect(serialized).not.toContain('raw-api-key-value');
    expect(serialized).not.toContain('raw-bearer-token');
    expect(serialized).not.toContain('nested-token-value');
  });

  it('bounds an oversized raw-answer payload', async () => {
    const root = await temporaryRoot();
    const tracePath = await writeTrace(root, {
      state,
      evaluation: evaluation({ answer: 'x'.repeat(MAX_TRACE_VALUE_BYTES * 2) }),
      policy,
    });
    const record = JSON.parse(await readFile(tracePath, 'utf8')) as {
      evaluation: { rawAnswers: unknown };
    };

    expect(Buffer.byteLength(JSON.stringify(record.evaluation.rawAnswers), 'utf8')).toBeLessThanOrEqual(
      MAX_TRACE_VALUE_BYTES,
    );
  });

  it('returns a credential-safe error when the trace directory cannot be created', async () => {
    const root = await temporaryRoot();
    const file = path.join(root, 'not-a-directory');
    await writeFile(file, 'not a directory');

    await expect(writeTrace(file, {
      state,
      evaluation: evaluation({}),
      policy,
    })).rejects.toEqual(expect.objectContaining({
      name: 'TraceWriteError',
      message: expect.stringContaining('--no-trace'),
    } satisfies Partial<TraceWriteError>));
  });
});
