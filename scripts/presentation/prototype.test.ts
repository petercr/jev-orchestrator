import { spawnSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatApprovalLines } from '../../src/cli/presentation.js';
import { createFixtures } from './fixtures.js';
import { chooseRenderer, displayText, parseOptions, readPreviewResponse, renderPrototype } from './prototype.js';

function streams(columns = 80) {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns });
  let text = '';
  output.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  return { input, output, text: () => text };
}

afterEach(() => vi.restoreAllMocks());

describe('offline presentation comparison', () => {
  it.each(['plain', 'clack'] as const)('preserves the complete review and fixture data with %s', async (renderer) => {
    const io = streams();
    const fixtures = createFixtures();
    const before = structuredClone(fixtures);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network in the prototype.'));
    await renderPrototype({ renderer, scenario: 'all', interactive: false }, {
      ...io, renderer, signal: new AbortController().signal,
    }, fixtures);
    const text = stripVTControlCharacters(io.text());
    expect(text).toContain('Synthetic scenes and timing data');
    for (const line of formatApprovalLines(fixtures.review).filter((value) => value.trim())) {
      // Clack wraps paragraphs; compare their content after removing whitespace.
      const compact = (value: string) => value.replace(/[\s│]/gu, '');
      expect(compact(text)).toContain(compact(line));
    }
    expect(text).toContain('command network: disabled');
    expect(text).toContain('Codex worker: edits prepared');
    expect(text).toContain('Acceptance review: still required');
    expect(text).toContain('Codex call limit exhausted');
    expect(text).toContain('Task acceptance: approved after independent validation.');
    expect(text).toContain('Elapsed:');
    expect(text).toContain('Offline preview complete');
    expect(fixtures).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps long parameters readable at 40 columns without terminal controls from fixture text', async () => {
    const fixtures = createFixtures();
    fixtures.review.state.task = 'Fix labels\u001b[2J\u001b]8;;https://invalid.example\u0007now\u001b]8;;\u0007\u202e';
    fixtures.review.state.repo.root = '/workspace/' + 'a-very-long-project-path/'.repeat(6);
    if (fixtures.review.proposal.action !== 'CALL_CODEX') throw new Error('Expected worker fixture.');
    fixtures.review.proposal.input.root = fixtures.review.state.repo.root;
    const io = streams(40);
    await renderPrototype({ renderer: 'clack', scenario: 'review', interactive: false }, {
      ...io, renderer: 'clack', signal: new AbortController().signal,
    }, fixtures);
    expect(io.text()).not.toContain('\u001b[2J');
    expect(io.text()).not.toContain('\u001b]8');
    expect(io.text()).not.toContain('\u202e');
    expect(io.text()).toContain('\\u202e');
    const lines = stripVTControlCharacters(io.text()).split('\n');
    expect(Math.max(...lines.map((line) => [...line].length))).toBeLessThanOrEqual(40);
  });

  it.each([
    ['pipe', false, {}], ['NO_COLOR', true, { NO_COLOR: '' }],
    ['CI', true, { CI: 'true' }], ['dumb terminal', true, { TERM: 'dumb' }],
  ] as const)('uses static plain output for %s even when Clack is requested', (_name, tty, environment) => {
    expect(chooseRenderer('clack', tty, environment)).toBe('plain');
  });

  it('chooses Clack in a normal terminal and keeps explicit plain mode', () => {
    expect(chooseRenderer('auto', true, {})).toBe('clack');
    expect(chooseRenderer('plain', true, {})).toBe('plain');
    expect(displayText('\u001b[2Jhello\rworld')).toBe('hello world');
  });

  it('validates prototype options without adding product flags', () => {
    expect(parseOptions([])).toEqual({ renderer: 'auto', scenario: 'all', interactive: false });
    expect(() => parseOptions(['--renderer', 'unknown'])).toThrow('Usage');
    expect(() => parseOptions(['--repo', '/tmp'])).toThrow('Usage');
    expect(() => parseOptions(['--scenario', 'progress', '--interactive'])).toThrow('requires');
  });

  it('runs the real entry point in an empty consumer with no styling or writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dev-ui-prototype-'));
    try {
      const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const result = spawnSync(process.execPath, ['--import', loader,
        fileURLToPath(new URL('./prototype.ts', import.meta.url)), '--renderer', 'clack'], {
        cwd: root, encoding: 'utf8', timeout: 20_000,
        env: { PATH: process.env.PATH, CI: 'true', NO_COLOR: '1' },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Offline preview complete.');
      expect(result.stdout).not.toMatch(/\u001b|[│◇└]/u);
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe.each(['plain', 'clack'] as const)('%s preview input owns cancellation', (renderer) => {
  it.each(['reject', 'stop', 'quit'] as const)('records only the explicit %s response', async (value) => {
    const io = streams();
    const response = readPreviewResponse(renderer, io.input, io.output, new AbortController().signal);
    io.input.write(`${value}\r`);
    await expect(response).resolves.toEqual({ kind: 'response', value: value === 'quit' ? 'stop' : value });
  });

  it('requires explicit nonempty input, then cleans up without later signal output', async () => {
    const io = streams();
    const controller = new AbortController();
    const response = readPreviewResponse(renderer, io.input, io.output, controller.signal);
    io.input.write('\r');
    await vi.waitFor(() => expect(io.text()).toContain('empty input selects nothing'));
    io.input.write('approve\r');
    await expect(response).resolves.toEqual({ kind: 'response', value: 'approve' });
    const after = io.text();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    controller.abort();
    expect(io.text()).toBe(after);
  });

  it.each(['end', 'abort', 'timeout'] as const)('treats %s as cancellation without inventing a response', async (cause) => {
    const io = streams();
    const controller = new AbortController();
    const response = readPreviewResponse(renderer, io.input, io.output, controller.signal, cause === 'timeout' ? 20 : 5_000);
    if (cause === 'end') io.input.end();
    if (cause === 'abort') controller.abort();
    await expect(response).resolves.toEqual({ kind: 'cancelled', reason: { end: 'input_closed', abort: 'signal', timeout: 'timeout' }[cause] });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(io.input.listenerCount('end')).toBe(0);
    expect(io.input.listenerCount('close')).toBe(0);
  });

  it('stops on an already-aborted signal before displaying a prompt', async () => {
    const io = streams();
    const controller = new AbortController(); controller.abort();
    await expect(readPreviewResponse(renderer, io.input, io.output, controller.signal))
      .resolves.toEqual({ kind: 'cancelled', reason: 'signal' });
    expect(io.text()).toBe('');
  });
});

it('treats a raw-mode Ctrl+D key as EOF instead of approving or hanging', async () => {
  const io = streams();
  const response = readPreviewResponse('clack', io.input, io.output, new AbortController().signal);
  io.input.write('\u0004');
  await expect(response).resolves.toEqual({ kind: 'cancelled', reason: 'input_closed' });
});
