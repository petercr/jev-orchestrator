import type { Action, AgentState, WorkerSelection } from '../types.js';
import { MAX_CLAUDE_CALLS, MAX_CODEX_CALLS } from './types.js';

type WorkerAction = Extract<Action, 'CALL_CODEX' | 'CALL_CLAUDE'>;

export function isWorkerActionAllowed(action: Action, selection?: WorkerSelection): boolean {
  if (action !== 'CALL_CODEX' && action !== 'CALL_CLAUDE') return true;
  return selection === undefined || (action === 'CALL_CODEX' && selection === 'codex') ||
    (action === 'CALL_CLAUDE' && selection === 'claude');
}

export function availableWorkerActions(state: AgentState): WorkerAction[] {
  const actions: WorkerAction[] = [];
  if (state.codexCalls < MAX_CODEX_CALLS && isWorkerActionAllowed('CALL_CODEX', state.workerSelection)) actions.push('CALL_CODEX');
  if (state.claudeCalls < MAX_CLAUDE_CALLS && isWorkerActionAllowed('CALL_CLAUDE', state.workerSelection)) actions.push('CALL_CLAUDE');
  return actions;
}
