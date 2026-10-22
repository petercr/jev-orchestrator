import { createInterface } from 'node:readline/promises';
import type { Key } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { PromptStoppedError, throwIfInterrupted, type ExecutionOptions, type PromptStopReason } from '../cancellation.js';
import { redactSensitiveText } from '../logging/trace.js';
import type { ApprovalContext } from '../orchestration/loop.js';
import { formatApprovalLines } from './presentation.js';

export const PROMPT_TIMEOUT_MS = 15 * 60_000;
type Output = Writable & { isTTY?: boolean; columns?: number };

export function terminalText(value: string): string {
  const plain = stripVTControlCharacters(redactSensitiveText(value))
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return redactSensitiveText(plain);
}

export function styledTerminal(plain: boolean, tty: boolean, environment: NodeJS.ProcessEnv): boolean {
  return !plain && tty && !('NO_COLOR' in environment) && environment.TERM !== 'dumb'
    && !(environment.CI && environment.CI !== 'false' && environment.CI !== '0');
}

type PresentationOptions = {
  input?: Readable & { isTTY?: boolean };
  output?: Output;
  plain?: boolean;
  environment?: NodeJS.ProcessEnv;
  writeLine?: (line: string) => void;
};

/** CLI output only. This object never changes candidates or authorizes actions. */
async function createPresentationParts(options: PresentationOptions = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const styled = styledTerminal(options.plain === true, input.isTTY === true && output.isTTY === true, options.environment ?? process.env);
  // JSON/plain paths do not initialize a terminal renderer or prompt reader.
  const clack = styled ? await import('@clack/prompts') : undefined;
  let disposed = false;
  const line = (value: string): void => {
    if (disposed) return;
    const safe = terminalText(value);
    if (options.writeLine) options.writeLine(safe);
    else output.write(`${safe}\n`);
  };
  const section = (title: string, lines: string[]): void => {
    if (disposed) return;
    if (clack) clack.note(lines.map(terminalText).join('\n'), title, { output });
    else { line(title); lines.forEach(line); }
  };
  return {
    styled, clack, input, output, line, section,
    header(title: string, lines: string[]): void {
      if (clack) { clack.intro('Dev Orchestrator', { output }); section('Run', [title, ...lines]); }
      else { line(`\n${title}`); lines.forEach(line); }
    },
    review(context: ApprovalContext): void {
      const lines = formatApprovalLines(context);
      if (context.proposal.action === 'CALL_CODEX') {
        const position = lines.indexOf('Current evidence and limits');
        lines.splice(position - 1, 0, `Permissions: workspace-write; Codex command network: ${context.proposal.input.networkAccess === true ? 'enabled' : 'disabled'}.`);
      } else if (context.proposal.action === 'CALL_CLAUDE') {
        lines.splice(lines.indexOf('Current evidence and limits') - 1, 0, 'Permissions: restricted repository file tools.');
      }
      if (!clack) { lines.forEach(line); return; }
      const headings = new Set(['Model recommendation', 'Policy decision', 'Candidate review', 'Current evidence and limits', 'Operator choices']);
      let title = 'Iteration';
      let body: string[] = [];
      for (const value of lines) {
        if (headings.has(value)) { section(title, body); title = value; body = []; }
        else if (value.trim()) body.push(value.trim());
      }
      section(title, body);
    },
    async phase<T>(label: string, operation: () => Promise<T>, execution: ExecutionOptions = {}, passed?: (result: T) => boolean): Promise<T> {
      if (clack && !disposed && !execution.signal?.aborted) section('Progress', [label]);
      const result = await operation();
      if (clack && !disposed && !execution.signal?.aborted) {
        section('Progress', [`${label}: ${passed && !passed(result) ? 'unsuccessful' : 'completed'}.`]);
      }
      return result;
    },
    end(message: string): void { if (clack && !disposed) clack.outro(message, { output }); },
    dispose(): void { disposed = true; },
  };
}

export async function createPresentation(options: PresentationOptions = {}) {
  const { clack: _clack, input: _input, output: _output, ...view } = await createPresentationParts(options);
  return view;
}

/** One reader owns stdin. Each question has a private cancellation scope. */
export async function createTerminal(options: PresentationOptions & {
  interrupt: () => void;
  promptTimeoutMs?: number;
}) {
  const { input, output, clack, ...view } = await createPresentationParts(options);
  const terminal = clack ? undefined : createInterface({ input, output, terminal: false });
  let inputClosed = input.readableEnded || input.destroyed;
  let pendingClose: (() => void) | undefined;
  const closed = (): void => { inputClosed = true; pendingClose?.(); };
  const keypress = (_value: string, key: Key): void => {
    if (key.ctrl && key.name === 'c') options.interrupt();
    if (key.ctrl && key.name === 'd') closed();
  };
  terminal?.on('SIGINT', options.interrupt);
  terminal?.on('close', closed);
  input.on('end', closed); input.on('close', closed); input.on('error', closed);
  input.on('keypress', keypress);
  return {
    ...view,
    async question(message: string, execution: ExecutionOptions = {}): Promise<string> {
      throwIfInterrupted(execution.signal);
      if (inputClosed) {
        view.section('Input stopped', ['Input stream closed without a response.']);
        throw new PromptStoppedError('input_closed');
      }
      const controller = new AbortController();
      let reason: PromptStopReason = 'input_cancelled';
      const stop = (value: PromptStopReason): void => {
        if (controller.signal.aborted) return;
        reason = value; controller.abort();
      };
      const interrupt = (): void => controller.abort();
      pendingClose = () => stop('input_closed');
      execution.signal?.addEventListener('abort', interrupt, { once: true });
      const timer = setTimeout(() => stop('input_timeout'), options.promptTimeoutMs ?? PROMPT_TIMEOUT_MS);
      try {
        throwIfInterrupted(execution.signal);
        const answer = clack
          ? await clack.text({ message: terminalText(message), input, output, signal: controller.signal })
          : await terminal!.question(message, { signal: controller.signal });
        throwIfInterrupted(execution.signal);
        if (controller.signal.aborted) throw new PromptStoppedError(reason);
        if (clack?.isCancel(answer)) throw new PromptStoppedError('input_cancelled');
        return typeof answer === 'string' ? answer : '';
      } catch (error) {
        throwIfInterrupted(execution.signal);
        const stopped = controller.signal.aborted ? new PromptStoppedError(reason) : error;
        if (stopped instanceof PromptStoppedError) view.section('Input stopped', [
          stopped.reason === 'input_timeout' ? 'Prompt timed out without a response.'
            : stopped.reason === 'input_closed' ? 'Input stream closed without a response.' : 'Prompt cancelled without a response.',
        ]);
        throw stopped;
      } finally {
        clearTimeout(timer);
        execution.signal?.removeEventListener('abort', interrupt);
        pendingClose = undefined;
      }
    },
    dispose(): void {
      pendingClose?.();
      terminal?.off('SIGINT', options.interrupt);
      terminal?.off('close', closed);
      terminal?.close();
      input.off('end', closed); input.off('close', closed); input.off('error', closed);
      input.off('keypress', keypress);
      view.dispose();
    },
  };
}

export type CliTerminal = Awaited<ReturnType<typeof createTerminal>>;
