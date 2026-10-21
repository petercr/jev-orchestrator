import { createInterface } from 'node:readline/promises';
import type { Key } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import * as clack from '@clack/prompts';
import { formatRunSummary } from '../../src/cli.js';
import { formatApprovalLines, formatOutcomeLines } from '../../src/cli/presentation.js';
import { createFixtures } from './fixtures.js';

type Renderer = 'auto' | 'plain' | 'clack';
type Scenario = 'all' | 'review' | 'progress' | 'blocked' | 'summary';
type PreviewChoice = 'approve' | 'reject' | 'stop';
type PreviewResponse = { kind: 'response'; value: PreviewChoice }
  | { kind: 'cancelled'; reason: 'signal' | 'input_closed' | 'timeout' | 'library' };
type Output = Writable & { isTTY?: boolean; columns?: number };
type Options = { renderer: Renderer; scenario: Scenario; interactive: boolean };

export function displayText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function chooseRenderer(requested: Renderer, tty: boolean, environment: NodeJS.ProcessEnv): Exclude<Renderer, 'auto'> {
  if (requested === 'plain' || !tty || 'NO_COLOR' in environment || environment.TERM === 'dumb'
    || (environment.CI !== undefined && environment.CI !== '' && environment.CI !== 'false' && environment.CI !== '0')) return 'plain';
  return 'clack';
}

function previewChoice(value: string): PreviewChoice | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'quit') return 'stop';
  return normalized === 'approve' || normalized === 'reject' || normalized === 'stop' ? normalized : undefined;
}

// This returns a preview response, never a real orchestration approval.
export async function readPreviewResponse(
  renderer: 'plain' | 'clack', input: Readable, output: Writable,
  signal: AbortSignal, timeoutMs = 60_000,
): Promise<PreviewResponse> {
  const controller = new AbortController();
  let reason: 'signal' | 'input_closed' | 'timeout' = 'signal';
  const cancel = (cause: typeof reason): void => {
    if (controller.signal.aborted) return;
    reason = cause; controller.abort();
  };
  const interrupt = (): void => cancel('signal');
  const closed = (): void => cancel('input_closed');
  const eofKey = (_value: string, key: Key): void => { if (key.ctrl && key.name === 'd') closed(); };
  signal.addEventListener('abort', interrupt, { once: true });
  input.once('end', closed); input.once('close', closed); input.once('error', closed);
  input.on('keypress', eofKey);
  const timer = setTimeout(() => cancel('timeout'), timeoutMs);
  const terminal = renderer === 'plain' ? createInterface({ input, output, terminal: false }) : undefined;
  try {
    if (signal.aborted) interrupt();
    if (input.readableEnded || input.destroyed) closed();
    if (controller.signal.aborted) return { kind: 'cancelled', reason };
    const message = 'Preview response: type approve, reject, or stop';
    if (renderer === 'clack') {
      const answer = await clack.text({
        message, input, output, signal: controller.signal,
        validate: (value) => previewChoice(value ?? '') ? undefined : 'Type approve, reject, or stop; empty input selects nothing.',
      });
      if (controller.signal.aborted) return { kind: 'cancelled', reason };
      if (clack.isCancel(answer)) return { kind: 'cancelled', reason: 'library' };
      const value = previewChoice(answer);
      return value ? { kind: 'response', value } : { kind: 'cancelled', reason: 'library' };
    }
    while (!controller.signal.aborted) {
      const answer = await terminal!.question(`${message}: `, { signal: controller.signal });
      if (controller.signal.aborted) break;
      const value = previewChoice(answer);
      if (value) return { kind: 'response', value };
      output.write('Type approve, reject, or stop; empty input selects nothing.\n');
    }
    return { kind: 'cancelled', reason };
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    return { kind: 'cancelled', reason };
  } finally {
    clearTimeout(timer);
    terminal?.close();
    signal.removeEventListener('abort', interrupt);
    input.off('end', closed); input.off('close', closed); input.off('error', closed);
    input.off('keypress', eofKey);
  }
}

function sections(lines: string[]): Array<{ title: string; body: string[] }> {
  const headings = new Set(['Model recommendation', 'Policy decision', 'Candidate review', 'Current evidence and limits', 'Operator choices']);
  const result: Array<{ title: string; body: string[] }> = [{ title: 'Iteration', body: [] }];
  for (const line of lines) {
    if (headings.has(line)) result.push({ title: line, body: [] });
    else if (line.trim()) result.at(-1)!.body.push(displayText(line.trim()));
  }
  return result;
}

export async function renderPrototype(
  options: Options,
  io: { input: Readable; output: Output; renderer: 'plain' | 'clack'; signal: AbortSignal },
  fixtures = createFixtures(),
): Promise<void> {
  const { output, renderer, signal } = io;
  const styled = renderer === 'clack';
  const write = (line: string): void => { output.write(`${displayText(line)}\n`); };
  const note = (title: string, lines: string[]): void => {
    if (styled) clack.note(lines.map(displayText).join('\n'), title, { output });
    else { write(`\n${title}`); lines.forEach(write); }
  };
  const header = 'Dev Orchestrator | v0.5 UI prototype';
  if (styled) clack.intro(header, { output }); else write(header);
  note('Offline preview', ['Synthetic scenes and timing data.', 'No repository actions, model calls, or trace writes.']);
  const shown = (scenario: Scenario): boolean => options.scenario === 'all' || options.scenario === scenario;
  const review = (name: string, context: typeof fixtures.review): void => {
    note(name, [`Task: ${context.state.task}`, `Repo: ${context.state.repo.root}`,
      'Worker: Codex only | workspace-write | command network: disabled']);
    const lines = formatApprovalLines(context);
    if (styled) for (const section of sections(lines)) note(section.title, section.body);
    else lines.forEach(write);
  };
  if (shown('review')) {
    review('Action review (synthetic)', fixtures.review);
    if (options.interactive) {
      const response = await readPreviewResponse(renderer, io.input, output, signal);
      if (response.kind === 'cancelled' || response.value === 'stop') {
        note('Preview stopped', [response.kind === 'cancelled' ? `Reason: ${response.reason}.` : 'Response: stop.']);
        return;
      }
      note('Preview response', [`Typed ${response.value}. This only records a demo response.`, 'The remaining scenes are separate synthetic fixtures.']);
    }
  }
  if (shown('progress')) {
    note('Worker and validation (synthetic)', ['Independent checks follow the worker attempt; acceptance review follows the checks.']);
    for (const phase of [
      { start: 'Codex worker: preparing edits', done: 'Codex worker: edits prepared' },
      { start: 'Independent pnpm test: running', done: 'pnpm test: passed (generation 1)' },
      { start: 'Independent pnpm check: running', done: 'pnpm check: passed (generation 1)' },
    ]) {
      signal.throwIfAborted();
      if (styled) {
        // Clack's native spinner owns stdin and exits 0 on a Ctrl+C key.
        // Keep input and signal ownership in the application instead.
        clack.log.step(phase.start, { output });
        await delay(300, undefined, { signal });
        clack.log.success(phase.done, { output });
      } else { write(phase.start); write(phase.done); }
    }
    if (styled) clack.log.warn('Acceptance review: still required', { output });
    else write('Acceptance review: still required');
  }
  signal.throwIfAborted();
  if (shown('blocked')) review('Blocked run | synthetic', fixtures.blocked);
  if (shown('summary')) note('Accepted run | synthetic', [
    ...formatOutcomeLines(fixtures.outcome), ...formatRunSummary(fixtures.outcome.summary).trim().split('\n'),
  ]);
  if (styled) clack.outro('Offline preview complete.', { output }); else write('\nOffline preview complete.');
}

const usage = 'Usage: pnpm prototype:ui [--renderer auto|plain|clack] [--scenario all|review|progress|blocked|summary] [--interactive]';

export function parseOptions(args: string[]): Options {
  const options: Options = { renderer: 'auto', scenario: 'all', interactive: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--interactive') options.interactive = true;
    else if (arg === '--renderer' && ['auto', 'plain', 'clack'].includes(args[index + 1] ?? '')) options.renderer = args[++index] as Renderer;
    else if (arg === '--scenario' && ['all', 'review', 'progress', 'blocked', 'summary'].includes(args[index + 1] ?? '')) options.scenario = args[++index] as Scenario;
    else throw new Error(usage);
  }
  if (options.interactive && options.scenario !== 'all' && options.scenario !== 'review') throw new Error('--interactive requires the review or all scenario.');
  return options;
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes('--help')) { console.log(usage); return; }
  let options: Options;
  try { options = parseOptions(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : usage); process.exitCode = 2; return; }
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (options.interactive && !tty) { console.error('Interactive preview requires a terminal. Omit --interactive for static output.'); process.exitCode = 2; return; }
  const controller = new AbortController();
  const sigint = (): void => { process.exitCode = 130; controller.abort(); };
  const sigterm = (): void => { process.exitCode = 143; controller.abort(); };
  const keypress = (_value: string, key: Key): void => { if (key.ctrl && key.name === 'c') sigint(); };
  process.once('SIGINT', sigint); process.once('SIGTERM', sigterm);
  process.stdin.on('keypress', keypress);
  try {
    await renderPrototype(options, {
      input: process.stdin, output: process.stdout, signal: controller.signal,
      renderer: chooseRenderer(options.renderer, tty, process.env),
    });
  } catch (error) {
    if (controller.signal.aborted) process.stdout.write('\nPreview interrupted.\n');
    else throw error;
  } finally {
    process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
    process.stdin.off('keypress', keypress);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
