export type CodingAgentRequest = {
  root: string;
  task: string;
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
