import type { AgentState, RepoSnapshot } from '../types.js';

export const VALIDATION_NAMES = ['verify', 'check', 'test', 'typecheck', 'lint', 'build'] as const;

export function isValidationScript(script: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/u.test(script) &&
    VALIDATION_NAMES.some((name) => script === name || script.startsWith(`${name}:`));
}

// Only a conjunction of plain package-script calls proves coverage. Flags,
// shell substitutions, ORs, and opaque tool commands prove nothing further.
function scriptDependencies(command: string, manager: RepoSnapshot['packageManager']): string[] {
  const dependencies: string[] = [];
  for (const part of command.split('&&')) {
    const match = /^(pnpm|npm|yarn|bun)\s+(?:(run)\s+)?([a-zA-Z0-9][a-zA-Z0-9:_-]{0,199})$/u.exec(part.trim());
    if (!match || match[1] !== manager || !match[3]) return [];
    // Other bare commands may name package-manager builtins (e.g. bun test
    // or yarn check), which do not prove execution of the declared script.
    if (!match[2] && !(manager === 'npm' && match[3] === 'test')) return [];
    dependencies.push(match[3]);
  }
  return dependencies;
}

export function validationWorkflow(
  scripts: string[],
  commands: Record<string, string>,
  manager: RepoSnapshot['packageManager'],
): Pick<RepoSnapshot, 'requiredValidationScripts' | 'validationScriptCoverage'> {
  const exact = VALIDATION_NAMES.filter((name) => scripts.includes(name));
  const requiredValidationScripts = exact.length > 0 ? [...exact] : [...scripts];
  const validationScriptCoverage: Record<string, string[]> = {};
  function covered(script: string, seen: Set<string>, depth = 0): void {
    if (seen.has(script) || depth >= 8 || seen.size >= 100) return;
    seen.add(script);
    for (const dependency of scriptDependencies(commands[script] ?? '', manager)) {
      if (scripts.includes(dependency)) covered(dependency, seen, depth + 1);
    }
  }
  for (const script of scripts) {
    const seen = new Set<string>();
    covered(script, seen);
    validationScriptCoverage[script] = [...seen];
  }
  return { requiredValidationScripts, validationScriptCoverage };
}

export function requiredValidationScripts(state: AgentState): string[] {
  return [...new Set([
    ...(state.repo.requiredValidationScripts ?? state.repo.validationScripts),
    ...(state.evidence?.issue?.requestedValidationScripts ?? []),
  ])];
}

function validationOutcomes(state: AgentState): Map<string, boolean> {
  const generation = state.evidence?.validationGeneration ?? 0;
  const records = state.evidence?.validations ??
    (state.evidence?.validation ? [state.evidence.validation] : undefined);
  const outcomes = new Map<string, boolean>();
  for (const result of (records ?? []).filter((item) => item.generation === generation)
    .sort((left, right) => left.iteration - right.iteration)) {
    const passed = result.passed && result.exitCode === 0 && !result.timedOut;
    const covered = passed ? state.repo.validationScriptCoverage?.[result.script] ?? [result.script] : [result.script];
    for (const script of covered) outcomes.set(script, passed);
  }
  return outcomes;
}

export function pendingValidationScripts(state: AgentState): string[] {
  const required = requiredValidationScripts(state);
  // Retain compatibility for older decision-only single-check snapshots.
  if (state.evidence?.validations === undefined && state.evidence?.validation === undefined &&
    (state.evidence?.validationGeneration ?? 0) === 0 && required.length === 1 &&
    state.tests.ran && state.tests.passed === true) return [];
  const outcomes = validationOutcomes(state);
  return required.filter((script) => outcomes.get(script) !== true);
}

export function hasFailedValidation(state: AgentState): boolean {
  const outcomes = validationOutcomes(state);
  return requiredValidationScripts(state).some((script) => outcomes.get(script) === false) ||
    (outcomes.size === 0 && state.tests.ran && state.tests.passed === false);
}

export function hasPassedValidation(state: AgentState): boolean {
  return !state.evidence?.repoRefreshRequired && !state.evidence?.issue?.validationRequirementsTruncated &&
    state.tests.ran && state.tests.passed === true &&
    requiredValidationScripts(state).length > 0 && pendingValidationScripts(state).length === 0;
}

export function selectPendingValidation(state: AgentState): string | undefined {
  const pending = pendingValidationScripts(state);
  if (pending.length === 0) return undefined;
  const candidates = state.repo.validationScripts.filter(isValidationScript);
  const score = (script: string): number =>
    (state.repo.validationScriptCoverage?.[script] ?? [script]).filter((name) => pending.includes(name)).length;
  const priority = (script: string): number => {
    const index = VALIDATION_NAMES.findIndex((name) => script === name || script.startsWith(`${name}:`));
    return index < 0 ? VALIDATION_NAMES.length : index;
  };
  return candidates.filter((script) => score(script) > 0)
    .sort((left, right) => score(right) - score(left) || priority(left) - priority(right) || left.localeCompare(right))[0];
}
