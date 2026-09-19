import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentState, EvaluationResult, PolicyDecision } from '../types.js';

export async function writeTrace(
  root: string,
  payload: {
    state: AgentState;
    evaluation: EvaluationResult;
    policy: PolicyDecision;
  },
): Promise<string> {
  const traceDir = path.join(root, 'traces');
  await mkdir(traceDir, { recursive: true });
  const date = new Date();
  const runId = date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const tracePath = path.join(traceDir, `${runId}.jsonl`);
  await appendFile(tracePath, `${JSON.stringify({ timestamp: date.toISOString(), ...payload })}\n`);
  return tracePath;
}
