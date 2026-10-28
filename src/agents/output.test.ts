import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { MAX_PROCESS_OUTPUT_BYTES, runProcess } from '../process.js';
import { createCodexAdapter } from './codex.js';
import { createClaudeAdapter } from './claude.js';
import { createWorkerOutput, MAX_WORKER_EVENT_BYTES } from './output.js';
import { isWorkerUsage, normalizeWorkerUsage } from './usage.js';

const codexUsage = { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 10 };
const claudeUsage = { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 20 };
const jsonl = (...events: unknown[]): string => events.map((event) => JSON.stringify(event)).join('\n') + '\n';

describe('reported worker usage', () => {
  it('normalizes cache input without double-counting Codex cache or reasoning', () => {
    expect(normalizeWorkerUsage('codex', codexUsage)).toEqual({ input: 100, output: 20, total: 120, cachedInput: 80 });
    expect(normalizeWorkerUsage('claude', claudeUsage)).toEqual({ input: 100, output: 20, total: 120, cachedInput: 80, cacheWriteInput: 10 });
    expect(normalizeWorkerUsage('codex', { input_tokens: 0, output_tokens: 0 })).toEqual({ input: 0, output: 0, total: 0 });
  });

  it.each([-1, 0.5, '100', null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])('rejects invalid counts %s', (input_tokens) => {
    expect(normalizeWorkerUsage('codex', { ...codexUsage, input_tokens })).toBeUndefined();
    expect(normalizeWorkerUsage('claude', { ...claudeUsage, cache_read_input_tokens: input_tokens })).toBeUndefined();
  });

  it('requires all Claude input components and rejects impossible normalized totals', () => {
    expect(normalizeWorkerUsage('claude', { input_tokens: 1, output_tokens: 2 })).toBeUndefined();
    expect(normalizeWorkerUsage('codex', { ...codexUsage, cached_input_tokens: 101 })).toBeUndefined();
    expect(isWorkerUsage({ input: 10, output: 1, total: 12 })).toBe(false);
    expect(isWorkerUsage({ input: 10, output: 1, total: 11, apiKey: 'untrusted' })).toBe(false);
  });

  it('handles split UTF-8 events and ignores usage embedded in worker or tool text', () => {
    const output = createWorkerOutput('codex');
    const bytes = Buffer.from(jsonl(
      { type: 'item.completed', item: { type: 'command_execution', aggregated_output: JSON.stringify({ usage: codexUsage }) } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Patch Ω ready. tokens: 999999' } },
      { type: 'turn.completed', usage: codexUsage },
    ));
    for (const byte of bytes) output.write(Buffer.from([byte]));
    expect(output.finish('')).toEqual({
      stdout: 'Patch Ω ready. tokens: 999999', usage: { input: 100, output: 20, total: 120, cachedInput: 80 },
    });
  });

  it('uses only the Claude result total, ignoring assistant placeholders and per-model duplicates', () => {
    const output = createWorkerOutput('claude');
    expect(output.finish(jsonl(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Working.' }], usage: claudeUsage } },
      { type: 'result', result: 'Implemented.', usage: claudeUsage, modelUsage: { sonnet: claudeUsage }, api_key: 'unretained' },
    ))).toEqual({ stdout: 'Implemented.', usage: { input: 100, output: 20, total: 120, cachedInput: 80, cacheWriteInput: 10 } });
  });

  it('retains usage beyond the output cap while discarding oversized unrelated frames', async () => {
    const events = jsonl(
      { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'x'.repeat(MAX_WORKER_EVENT_BYTES + 1) } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Ready for separate validation.' } },
      { type: 'turn.completed', usage: codexUsage },
    );
    const output = createWorkerOutput('codex');
    const result = await runProcess({
      command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(events)})`], cwd: os.tmpdir(), timeoutMs: 10_000,
    }, { onStdout: output.write });
    expect(Buffer.byteLength(result.stdout)).toBe(MAX_PROCESS_OUTPUT_BYTES);
    expect(output.finish(result.stdout)).toMatchObject({ stdout: 'Ready for separate validation.', usage: { total: 120 } });
  });

  it.each([
    '{"type":"turn.completed","usage":{"input_tokens":1,"input_tokens":2,"output_tokens":3}}\n',
    jsonl({ type: 'turn.completed', usage: codexUsage }, { type: 'turn.completed', usage: codexUsage }),
    '{"type":"turn.completed","usage":',
    jsonl({ type: 'turn.failed', error: { usage: codexUsage } }),
    jsonl({ type: 'item.completed', item: { type: 'agent_message', text: 'Used 120 tokens.' } }),
  ])('leaves missing, malformed, duplicate, and nonterminal usage unavailable', (text) => {
    expect(createWorkerOutput('codex').finish(text)).not.toHaveProperty('usage');
  });

  it.each(['codex', 'claude'] as const)('preserves %s reported usage on failed, timed-out, and cancelled processes', async (agent) => {
    for (const status of [{ exitCode: 1, timedOut: false }, { exitCode: null, timedOut: true }, { exitCode: 0, timedOut: false, cancelled: true }]) {
      const adapter = agent === 'codex' ? createCodexAdapter : createClaudeAdapter;
      const event = agent === 'codex' ? { type: 'turn.completed', usage: codexUsage }
        : { type: 'result', result: 'Partial edits.', usage: claudeUsage };
      const result = await adapter(async () => ({ ...status, stdout: jsonl(event), stderr: '' }))({ root: '/repo', task: 'Implement fixture' });
      expect(result).toMatchObject({ ok: false, usage: { input: 100, output: 20, total: 120 } });
    }
  });

  it('retains bounded terminal diagnostics without mining errors for usage', () => {
    expect(createWorkerOutput('codex').finish(jsonl({ type: 'turn.failed', error: { message: 'Worker access failed.', usage: codexUsage } })))
      .toEqual({ stdout: 'Worker access failed.' });
    expect(createWorkerOutput('claude').finish(jsonl({ type: 'result', errors: ['Turn limit reached.'] })))
      .toEqual({ stdout: 'Turn limit reached.' });
  });

  it('does not let a reporting observer bypass process completion', async () => {
    const result = await runProcess({ command: process.execPath, args: ['-e', 'console.log("done")'], cwd: os.tmpdir(), timeoutMs: 10_000 }, {
      onStdout: () => { throw new Error('reporting unavailable'); },
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'done\n', timedOut: false });
  });
});
