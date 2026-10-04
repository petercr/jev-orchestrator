import type { Action, AgentState } from '../types.js';
import { isIssueContext, parseGitHubIssue } from './issue.js';

export const REPOSITORY_INSTRUCTION_FILES = ['AGENTS.md', 'CONTRIBUTING.md', 'CLAUDE.md'] as const;

export type TaskPreparation = {
  issue: 'not_linked' | 'pending' | 'read' | 'provided';
  unreadInstructions: string[];
  nextAction: 'READ_ISSUE' | 'READ_FILE' | 'ASK_USER' | null;
};

export function taskPreparation(state: AgentState): TaskPreparation {
  const issue = parseGitHubIssue(state.task);
  if (!issue) return { issue: 'not_linked', unreadInstructions: [], nextAction: null };

  const issueRead = isIssueContext(state.evidence?.issue) && state.evidence.issue.url === issue.url;
  const failedReadIteration = state.evidence?.failures.find((failure) => failure.action === 'READ_ISSUE')?.iteration;
  const contextProvided = failedReadIteration !== undefined && Boolean(state.evidence?.clarifications.some((item) =>
    item.iteration > failedReadIteration && item.text.trim().length > 0));
  const unreadInstructions = REPOSITORY_INSTRUCTION_FILES.filter((file) =>
    state.repo.topLevelFiles.includes(file) && !state.filesRead.includes(file));
  let nextAction: TaskPreparation['nextAction'] = null;
  if (!issueRead && !contextProvided) nextAction = failedReadIteration === undefined ? 'READ_ISSUE' : 'ASK_USER';
  else if (unreadInstructions.length > 0) nextAction = 'READ_FILE';
  return {
    issue: issueRead ? 'read' : contextProvided ? 'provided' : 'pending',
    unreadInstructions,
    nextAction,
  };
}

export function requiresTaskPreparation(action: Action): boolean {
  return action === 'RUN_TESTS' || action === 'CALL_CODEX' || action === 'CALL_CLAUDE' || action === 'FINISH';
}
