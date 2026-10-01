import type { WorkerContext } from './context.js';

export const MAX_CODEX_CALLS = 2;
export const MAX_CLAUDE_CALLS = 2;

export type CodingAgentRequest = {
  root: string;
  task: string;
  context?: WorkerContext;
};

export type CodingAgentResult = {
  agent: 'codex' | 'claude';
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

export type CodingAgentAdapter = (request: CodingAgentRequest) => Promise<CodingAgentResult>;
