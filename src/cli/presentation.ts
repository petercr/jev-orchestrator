import { stripVTControlCharacters } from 'node:util';
import { truncateText } from '../limits.js';
import { redactSensitiveText } from '../logging/trace.js';
import { MAX_CLAUDE_CALLS, MAX_CODEX_CALLS } from '../agents/types.js';
import { taskPreparation } from '../repo/preparation.js';
import { hasOmittedValidationRequirements, hasPassedValidation, validationChecks } from '../repo/validation.js';
import { ACTIONS, type AgentState } from '../types.js';
import type { ApprovalContext, EvaluationRecoveryContext, OrchestrationResult } from '../orchestration/loop.js';

const MAX_DISPLAY_ITEMS = 8;

function text(value: string, limit = 400): string {
  const plain = stripVTControlCharacters(redactSensitiveText(value)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ');
  return truncateText(redactSensitiveText(plain.replace(/\s+/gu, ' ').trim()), limit);
}

function list(values: string[]): string {
  const shown = values.slice(0, MAX_DISPLAY_ITEMS).map((value) => text(value, 100));
  if (values.length > shown.length) shown.push(`+${values.length - shown.length} more`);
  return shown.join(', ') || 'none';
}

function parameters(input: ApprovalContext['proposal']['input']): string {
  // Preserve the reviewed values and parseable JSON, including control bytes.
  return JSON.stringify(input, (_key, value: unknown) => typeof value === 'string' ? redactSensitiveText(value) : value)
    .replace(/[\u007f-\u009f\u2028\u2029]/gu, (value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function formatProgressLines(state: AgentState): string[] {
  const preparation = taskPreparation(state);
  const generation = state.evidence?.validationGeneration ?? 0;
  const checks = validationChecks(state);
  const issueFailed = state.evidence?.failures.some((failure) => failure.action === 'READ_ISSUE');
  const issue = preparation.issue === 'read' ? 'read; repository/issue text remains untrusted'
    : preparation.issue === 'provided' ? 'supplied through approved clarification'
      : preparation.issue === 'not_linked' ? 'no linked GitHub issue'
        : issueFailed ? 'unavailable; task context is still required from the operator' : 'not yet read';
  const lines = [
    `Issue context: ${issue}.`,
    `Required unread instructions: ${list(preparation.unreadInstructions)}.`,
    `Independent checks (generation ${generation}): ${checks.length
      ? list(checks.map((check) => `${check.script}: ${check.status}`)) : 'no required checks detected'}.`,
  ];
  const pending = checks.filter((check) => check.status !== 'passed');
  if (pending.length) lines.push(`Completion needs independent checks: ${list(pending.map((check) => check.script))}.`);
  const oldResults = state.evidence?.validations ?? (state.evidence?.validation ? [state.evidence.validation] : []);
  const failedScripts = new Set(checks.filter((check) => check.status === 'failed').map((check) => check.script));
  const failed = [...oldResults].sort((left, right) => right.iteration - left.iteration).find((result) =>
    result.generation === generation && failedScripts.has(result.script) &&
    (!result.passed || result.exitCode !== 0 || result.timedOut));
  if (failed) lines.push(`Independent ${text(failed.script, 100)} failure: ${failed.timedOut ? 'timed out' : `exit ${failed.exitCode ?? 'unavailable'}`}. ${text(failed.summary, 300)}`);
  if (pending.length && oldResults.some((result) => result.generation !== generation)) {
    lines.push('Earlier-generation results are stale after a worker attempt; fresh checks are required.');
  }
  if (hasOmittedValidationRequirements(state)) lines.push('Completion blocked: task context omitted validation requirements; obtain the missing requirements.');
  if (state.evidence?.repoRefreshRequired) lines.push('Execution blocked: repository inspection requires recovery through approved user input.');
  if (pending.some((check) => !state.repo.validationScripts.includes(check.script) &&
    !state.repo.validationScripts.some((script) => state.repo.validationScriptCoverage?.[script]?.includes(check.script)))) {
    lines.push('Some required checks have no declared runnable coverage; clarify the missing check before completion.');
  }
  if (state.repo.packageManager === 'unknown' && pending.length) lines.push('Validation blocked: no supported package manager was detected from a lockfile.');
  const worker = state.evidence?.worker;
  if (worker && !worker.ok) {
    const guidance = pending.length ? 'review any saved edits and obtain fresh independent validation'
      : 'review any saved edits against the independent check outcomes above';
    lines.push(`Last ${worker.agent} attempt: ${worker.timedOut ? 'timed out' : `unsuccessful, exit ${worker.exitCode ?? 'unavailable'}`}; ${guidance}.`);
  }
  lines.push(`Worker calls used: Codex ${state.codexCalls}/${MAX_CODEX_CALLS}; Claude ${state.claudeCalls}/${MAX_CLAUDE_CALLS}.`);
  if (state.workerSelection) lines.push(`Worker selection: ${state.workerSelection} only; the other worker is excluded for this run.`);
  if (state.codexCalls >= MAX_CODEX_CALLS) lines.push('Codex call limit exhausted; another Codex call is unavailable.');
  if (state.claudeCalls >= MAX_CLAUDE_CALLS) lines.push('Claude call limit exhausted; another Claude call is unavailable.');
  return lines;
}

export function formatApprovalLines(context: ApprovalContext): string[] {
  const { state, evaluation, policy, proposal, review } = context;
  const { nextAction, taskComplete } = evaluation.assessment;
  const lines = [
    `\nIteration ${state.iteration}${review ? ` of ${review.iterationLimit} (${Math.max(0, review.iterationLimit - state.iteration + 1)} remaining, including this iteration)` : ''}`,
    'Model recommendation',
    `Evaluator requested: ${nextAction.choice}`,
    `Choice probability: ${nextAction.probabilities[nextAction.choice] ?? 0}; reported confidence: ${nextAction.confidence ?? 'not reported'}.`,
    `Task-completion probability: ${taskComplete.probability}.`,
    `Needs information: ${evaluation.assessment.needsMoreInformation.probability}; needs testing: ${evaluation.assessment.needsTesting.probability}; stuck: ${evaluation.assessment.stuck.probability}.`,
  ];
  if (evaluation.provider) lines.push(`Provider: ${text(evaluation.provider)}`);
  if (evaluation.requestedModel) lines.push(`Requested model: ${text(evaluation.requestedModel)}`);
  if (evaluation.servedModel) lines.push(`Served model: ${text(evaluation.servedModel)}`);
  lines.push('Next-action distribution');
  const actions = ACTIONS.filter((action) => nextAction.probabilities[action] !== undefined)
    .sort((left, right) => (nextAction.probabilities[right] ?? 0) - (nextAction.probabilities[left] ?? 0));
  for (const action of actions) lines.push(`  ${action.padEnd(14)} ${Math.round((nextAction.probabilities[action] ?? 0) * 100)}%`);
  lines.push('', 'Policy decision', `Policy selected: ${policy.selected}${policy.override ? ' (override)' : ''}`, `Reason: ${text(policy.reason)}`);
  lines.push('', 'Candidate review');
  if (review) {
    lines.push(review.source === 'alternative'
      ? `Manual alternative requested: ${review.requested}; original policy selection: ${policy.selected}.`
      : `Resolving policy selection: ${review.requested}.`);
    if (proposal.action !== review.requested) lines.push(`Candidate unavailable: ${review.requested} could not be offered with the current evidence.`);
  }
  lines.push(`Safe candidate: ${proposal.action}`, `Tool: ${proposal.tool ?? 'none'}`, `Parameters: ${parameters(proposal.input)}`);
  if ('reason' in proposal) lines.push(`Candidate reason: ${text(proposal.reason)}`);
  lines.push('', 'Current evidence and limits', ...formatProgressLines(state));
  if (review) lines.push(`Interaction totals in this process: ${review.counts.approvals} action approvals; ${review.counts.alternatives} manual alternatives; ${review.counts.evaluationRecoveries} explicit evaluation recoveries.`);
  lines.push('', 'Operator choices', `Allowed alternatives: ${context.allowedAlternatives.join(', ') || 'none'}`);
  if (proposal.action === 'ASK_USER') {
    if (context.allowedAlternatives.includes('FINISH')) {
      lines.push('Completion review is available. Select FINISH, review its resolved candidate, then approve only if the original task acceptance criteria are met.');
    }
    lines.push('To provide context, enter approve and then a plain-language answer. ASK_USER runs no repository tool.');
  } else if (proposal.action === 'FINISH') {
    lines.push('Approve FINISH only after reviewing the original task acceptance criteria and saved changes; passing checks alone does not establish acceptance.');
  } else {
    lines.push(`Enter approve to run only the displayed ${proposal.action} candidate.`);
    if (context.allowedAlternatives.includes('FINISH')) {
      lines.push('Completion review is available. Select FINISH, review its resolved candidate, then approve only if the original task acceptance criteria are met.');
    }
  }
  lines.push('To choose another action, enter a listed action name and review its resolved candidate before approval.');
  lines.push('Enter reject to skip this candidate and reevaluate, or stop to end the run without claiming completion; edits and evidence are kept.');
  return lines;
}

export function formatRecoveryLines(context: EvaluationRecoveryContext): string[] {
  return [
    'No candidate or action approval came from the failed evaluation.',
    ...(context.failure.code === 'invalid_response' && context.failure.stage === 'distribution' && context.failure.category === 'sum'
      ? ['The returned action probabilities failed the sum check; they were not adjusted. A fresh evaluation may fail again.'] : []),
    'Continue requests a fresh evaluation within the remaining budget. It does not approve a repository action.',
    `Continuing consumes another iteration. ${context.remainingIterations} iterations remain; worker call limits are retained.`,
    'Provider/model selection and worker/network permissions remain fixed during recovery.',
    ...formatProgressLines(context.state),
    'Edits and evidence are preserved. Enter continue to reevaluate, or stop to end this run.',
  ];
}

export function formatOutcomeLines(result: OrchestrationResult): string[] {
  const lines: string[] = [];
  if (result.status === 'finished') {
    lines.push('Task acceptance: approved after independent validation.');
  } else if (result.status === 'iteration_limit') {
    lines.push(`Iteration budget exhausted after ${result.iterations} iterations; task completion was not approved.`);
    if (result.summary.validation.passed) lines.push('All required independent checks passed, but acceptance review did not complete within the budget.');
  } else if (result.status === 'evaluation_failed') {
    lines.push('Evaluation stopped this run; no action was approved from the failed evaluation.');
  } else {
    lines.push(result.exitCode === 130 || result.exitCode === 143
      ? 'A signal interrupted this run; partial edits and evidence were preserved.'
      : 'Run stopped without claiming task completion; edits and evidence were preserved.');
  }
  if (result.status !== 'finished') {
    lines.push(...formatProgressLines(result.state));
    if (hasPassedValidation(result.state)) lines.push('Passing validation is supporting evidence; the task outcome still needs acceptance review.');
    lines.push(result.savedRunId
      ? `Next: inspect dev-agent --show-run ${result.savedRunId}; use --resume ${result.savedRunId} only if the recorded stop is eligible. The trace is diagnostic data.`
      : 'Next: review the saved changes, required checks, and trace. A new invocation starts a separate run with its own approvals; the trace is diagnostic data.');
  }
  return lines;
}
