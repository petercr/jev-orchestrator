import { getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptStoppedError, RunInterruptedError } from '../cancellation.js';
import { createPresentation, createTerminal, styledTerminal, terminalText, type CliTerminal } from './terminal.js';

function streams() {
  const raw: boolean[] = [];
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (value: boolean) => { raw.push(value); } });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 40 });
  let text = '';
  output.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  return { input, output, raw, text: () => text };
}

let terminal: CliTerminal | undefined;
beforeEach(() => { terminal = undefined; });
afterEach(() => { terminal?.dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe.each([false, true])('production prompt with plain=%s', (plain) => {
  it('keeps blank input empty and requires a fresh explicit response', async () => {
    const io = streams();
    terminal = await createTerminal({ ...io, plain, environment: {}, interrupt: vi.fn() });
    const controller = new AbortController();
    const blank = terminal.question('Choose approve, reject, stop:', { signal: controller.signal });
    io.input.write('\r');
    expect(await blank).toBe('');
    const explicit = terminal.question('Choose approve, reject, stop:', { signal: controller.signal });
    io.input.write('approve\r');
    expect(await explicit).toBe('approve');
    if (plain) expect(io.text()).not.toContain('\u001b');
    const snapshot = io.text();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    controller.abort();
    expect(io.text()).toBe(snapshot);
  });

  it.each(['end', 'timeout', 'signal'] as const)('cancels %s without a fabricated answer', async (kind) => {
    const io = streams();
    const controller = new AbortController();
    terminal = await createTerminal({ ...io, plain, environment: {}, interrupt: vi.fn(), promptTimeoutMs: kind === 'timeout' ? 20 : 5_000 });
    const response = terminal.question('Choose:', { signal: controller.signal });
    if (kind === 'end') io.input.end();
    if (kind === 'signal') controller.abort();
    await expect(response).rejects.toMatchObject(kind === 'signal'
      ? { name: 'RunInterruptedError' } : { name: 'PromptStoppedError', reason: kind === 'end' ? 'input_closed' : 'input_timeout' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('rejects prompts after EOF and restores owned event listeners', async () => {
    const io = streams();
    terminal = await createTerminal({ ...io, plain, environment: {}, interrupt: vi.fn() });
    io.input.emit('end');
    await expect(terminal.question('Choose:')).rejects.toEqual(new PromptStoppedError('input_closed'));
    terminal.dispose(); terminal = undefined;
    expect(io.input.listenerCount('end')).toBe(0);
    expect(io.input.listenerCount('close')).toBe(0);
    expect(io.input.listenerCount('keypress')).toBeLessThanOrEqual(1); // Node's shared key decoder may remain.
    if (io.raw.length) expect(io.raw.at(-1)).toBe(false);
  });

  it('does not open a prompt on an already-aborted run signal', async () => {
    const io = streams();
    terminal = await createTerminal({ ...io, plain, environment: {}, interrupt: vi.fn() });
    const controller = new AbortController(); controller.abort();
    await expect(terminal.question('Choose:', { signal: controller.signal })).rejects.toEqual(new RunInterruptedError());
    expect(io.text()).toBe('');
  });
});

describe('production presentation ownership', () => {
  it('uses plain output for explicit plain mode, pipes, CI, NO_COLOR, and dumb terminals', () => {
    expect(styledTerminal(false, true, {})).toBe(true);
    expect(styledTerminal(true, true, {})).toBe(false);
    expect(styledTerminal(false, false, {})).toBe(false);
    for (const environment of [{ CI: 'true' }, { NO_COLOR: '' }, { TERM: 'dumb' }]) {
      expect(styledTerminal(false, true, environment)).toBe(false);
    }
  });

  it('removes untrusted terminal controls and visibly escapes bidi controls', () => {
    expect(terminalText('\u001b[2J\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007\r\u202e')).toBe('link \\u202e');
  });

  it('redacts credentials exposed by removing terminal controls', () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'header-secret');
    expect(terminalText('header-\u001b[0msecret')).toBe('[REDACTED]');
  });

  it('fences progress output after disposal or a run interruption', async () => {
    const io = streams();
    const view = await createPresentation({ ...io, environment: {} });
    let finish!: (value: string) => void;
    const pending = view.phase('Evaluating task', () => new Promise<string>((resolve) => { finish = resolve; }));
    const before = io.text();
    view.dispose(); finish('late result');
    expect(await pending).toBe('late result');
    expect(io.text()).toBe(before);
    expect(stripVTControlCharacters(before)).toContain('Evaluating task');
  });

  it.each([
    ['Ctrl+D', '\u0004', 'input_closed'],
    ['Escape', '\u001b', 'input_cancelled'],
  ] as const)('treats %s as stopped input', async (_key, value, reason) => {
    const io = streams();
    terminal = await createTerminal({ ...io, environment: {}, interrupt: vi.fn() });
    const response = terminal.question('Choose:');
    io.input.write(value);
    await expect(response).rejects.toEqual(new PromptStoppedError(reason));
    expect(io.raw.at(-1)).toBe(false);
  });
});
