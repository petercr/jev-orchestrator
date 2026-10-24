import { resolveEvaluationConfiguration, type EvaluationConfiguration } from '../config.js';
import { requiredValidationScripts, validationRequirementsFromText } from '../repo/validation.js';
import { REPOSITORY_INSTRUCTION_FILES } from '../repo/preparation.js';
import { createSavedRunConfiguration, redactAndValidateAgentState } from './contract.js';
import { changedSnapshotPaths, type RepositorySnapshot } from './snapshot.js';
import type { SavedRunCheckpointV1, SavedRunEvent, SavedRunConfiguration } from './types.js';
import type { AgentState, RepoSnapshot } from '../types.js';

export function resumePosition(checkpoint: SavedRunCheckpointV1, events: SavedRunEvent[]) {
  const stop = events.at(-1);
  if (checkpoint.status !== 'stopped' || stop?.type !== 'run_stopped' || !stop.resumable) {
    throw new Error('Resume requires a durable clean stop; active, blocked, finished, and exhausted runs are inspection only.');
  }
  const used = events.filter((event) => event.type === 'iteration_reserved').length;
  if (used >= checkpoint.iterationLimit) throw new Error('The original iteration budget is exhausted.');
  if (!stop.repositorySnapshotHash) throw new Error('This stop predates content fingerprints and remains inspection only. Start a new saved run.');
  const failure = [...events].reverse().find((event) => event.type === 'evaluation_failed');
  const recoveryRequired = failure !== undefined && !events.some((event) =>
    event.type === 'evaluation_completed' && event.sequence > failure.sequence);
  return {
    nextIteration: used + 1,
    segment: 2 + events.filter((event) => event.type === 'run_resumed').length,
    repositorySnapshotHash: stop.repositorySnapshotHash,
    recoveryRequired,
  };
}

/** Reload secrets; defaults come from the frozen selection, never today's provider default. */
export function resolveResumeConfiguration(saved: SavedRunConfiguration, environment: NodeJS.ProcessEnv = process.env): EvaluationConfiguration | undefined {
  if (saved.mode === 'mock') return undefined;
  if (environment.ROUTER_MODEL !== undefined && environment.ROUTER_MODEL.trim() !== saved.model) {
    throw new Error('ROUTER_MODEL conflicts with the saved model selection.');
  }
  const configuration = resolveEvaluationConfiguration({
    ...environment,
    ...(environment.ROUTER_PROVIDER === undefined && environment.JEV_PROVIDER === undefined ? { ROUTER_PROVIDER: saved.provider } : {}),
    ...(environment.ROUTER_MODEL === undefined && !(saved.provider === 'openrouter' && environment.OPENROUTE_MODEL !== undefined)
      ? { ROUTER_MODEL: saved.model } : {}),
  });
  const current = createSavedRunConfiguration('live', configuration, saved.workerSelection, saved.codexNetworkAccess);
  if (JSON.stringify(current) !== JSON.stringify(saved)) {
    throw new Error('Provider, model, or Cloudflare account identity conflicts with this saved run.');
  }
  return configuration;
}

export function refreshResumeState(checkpoint: SavedRunCheckpointV1, repo: RepoSnapshot, snapshot?: RepositorySnapshot): AgentState {
  const previous = checkpoint.state;
  const required = [...new Set([
    ...requiredValidationScripts(previous), ...validationRequirementsFromText(previous.task).scripts,
    ...(repo.requiredValidationScripts ?? repo.validationScripts),
  ])];
  if (required.length > 100 || validationRequirementsFromText(previous.task).truncated) {
    throw new Error('Original validation requirements cannot fit safely in the resumed state.');
  }
  const evidence = previous.evidence;
  const worker = evidence?.worker;
  const instructionFiles = REPOSITORY_INSTRUCTION_FILES.filter((file) => snapshot
    ? snapshot.files.some((item) => item.path === file && item.hash !== null) : repo.topLevelFiles.includes(file));
  const next: AgentState = {
    ...previous,
    repo: { ...repo, requiredValidationScripts: required,
      topLevelFiles: [...new Set([...instructionFiles, ...repo.topLevelFiles])].slice(0, 80) },
    currentGoal: 'Reinspect instructions and independently validate the preserved task before acceptance.',
    filesRead: [],
    filesModified: [],
    commandsRun: [],
    observations: ['Explicit continuation preserved the task and budgets. Earlier file reads and validation are stale. Repository drift may include operator edits.'],
    tests: { ran: false },
    evidence: {
      revision: (evidence?.revision ?? 0) + 1,
      validationGeneration: (evidence?.validationGeneration ?? 0) + 1,
      clarifications: evidence?.clarifications ?? [],
      failures: evidence?.failures ?? [],
      ...(evidence?.issue ? { issue: evidence.issue } : {}),
      findings: [],
      validations: [],
      requiredInstructionFiles: instructionFiles,
      // Prior process success is historical evidence, not fresh validation.
      ...(worker ? { worker: {
        ...worker, modifiedFiles: [],
        summary: 'An earlier segment attempted this worker. Fresh independent validation is required.',
      } } : {}),
    },
  };
  return redactAndValidateAgentState(next);
}

export function validateSnapshotDrift(previous: RepositorySnapshot, current: RepositorySnapshot): string[] {
  for (const file of REPOSITORY_INSTRUCTION_FILES) {
    if (previous.files.some((item) => item.path === file && item.hash !== null) &&
        !current.files.some((item) => item.path === file && item.hash !== null)) {
      throw new Error('A previously present root instruction file is unavailable; restore it before continuation.');
    }
  }
  return changedSnapshotPaths(previous, current);
}
