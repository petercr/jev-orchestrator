import { lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildWorkerContext, workerEvidenceKey, type WorkerContext } from '../agents/context.js';
import { MAX_CLAUDE_CALLS, MAX_CODEX_CALLS } from '../agents/types.js';
import { requireBoundedTask } from '../limits.js';
import type { Action, AgentState } from '../types.js';
import { selectDiagnosticCommand, type DiagnosticCommandId } from './diagnostics.js';
import { parseGitHubIssue } from '../repo/issue.js';
import { hasPassedValidation, selectPendingValidation } from '../repo/validation.js';
import { REPOSITORY_INSTRUCTION_FILES, requiresTaskPreparation, taskPreparation } from '../repo/preparation.js';

export const EXECUTABLE_ACTIONS = [
  'SEARCH_REPO',
  'READ_FILE',
  'READ_ISSUE',
  'RUN_COMMAND',
  'RUN_TESTS',
  'CALL_CODEX',
  'CALL_CLAUDE',
  'ASK_USER',
  'FINISH',
] as const satisfies readonly Action[];

export { MAX_CODEX_CALLS, MAX_CLAUDE_CALLS } from '../agents/types.js';

export type ExecutableAction = (typeof EXECUTABLE_ACTIONS)[number];

export type SearchProposal = {
  action: 'SEARCH_REPO';
  tool: 'rg';
  input: {
    root: string;
    terms: string[];
  };
};

export type ReadProposal = {
  action: 'READ_FILE';
  tool: 'read_file';
  input: {
    root: string;
    path: string;
  };
};

export type IssueProposal = {
  action: 'READ_ISSUE';
  tool: 'github_issue';
  input: { url: string };
};

export type TestProposal = {
  action: 'RUN_TESTS';
  tool: 'package_script';
  input: {
    root: string;
    packageManager: Exclude<AgentState['repo']['packageManager'], 'unknown'>;
    script: string;
    command: string;
    args: string[];
  };
};

export type DiagnosticProposal = {
  action: 'RUN_COMMAND';
  tool: 'diagnostic_command';
  input: {
    root: string;
    diagnostic: DiagnosticCommandId;
    command: string;
    args: string[];
  };
};

export type CodexProposal = {
  action: 'CALL_CODEX';
  tool: 'codex_cli';
  input: {
    root: string;
    task: string;
    context: WorkerContext;
  };
};

export type ClaudeProposal = {
  action: 'CALL_CLAUDE';
  tool: 'claude_code_cli';
  input: {
    root: string;
    task: string;
    context: WorkerContext;
  };
};

export type AskUserProposal = {
  action: 'ASK_USER';
  tool: null;
  input: null;
  reason: string;
};

export type FinishProposal = {
  action: 'FINISH';
  tool: null;
  input: null;
  reason: string;
};

export type CandidateProposal =
  | SearchProposal
  | ReadProposal
  | IssueProposal
  | DiagnosticProposal
  | TestProposal
  | CodexProposal
  | ClaudeProposal
  | AskUserProposal
  | FinishProposal;

const MAX_SEARCH_TERMS = 3;
const MAX_SEARCH_TERM_LENGTH = 64;
const SEARCH_TOKEN = /[\p{L}\p{N}_./:@-]+/gu;
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'choose',
  'for',
  'from',
  'in',
  'inspect',
  'of',
  'on',
  'repo',
  'repository',
  'safest',
  'the',
  'this',
  'to',
  'useful',
  'with',
]);
const SENSITIVE_BASENAME = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i;
const SENSITIVE_EXTENSION = /\.(?:key|pem|p12|pfx)$/i;

export class CandidateSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandidateSelectionError';
  }
}

function isBelowRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function isSensitivePath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/u);
  return segments.some((segment) => SENSITIVE_BASENAME.test(segment)) ||
    SENSITIVE_EXTENSION.test(relativePath);
}

export function deriveSearchTerms(task: string): string[] {
  const tokens = task.match(SEARCH_TOKEN) ?? [];
  const terms: string[] = [];

  for (const token of tokens) {
    const normalized = token.slice(0, MAX_SEARCH_TERM_LENGTH);
    if (normalized.length < 2 || STOP_WORDS.has(normalized.toLowerCase())) continue;
    if (terms.some((term) => term.toLowerCase() === normalized.toLowerCase())) continue;
    terms.push(normalized);
    if (terms.length >= MAX_SEARCH_TERMS) break;
  }

  return terms.length > 0 ? terms : ['README'];
}

export async function resolveSafeRepoFile(root: string, candidatePath: string): Promise<string> {
  if (!candidatePath || path.isAbsolute(candidatePath) || candidatePath.includes('\0')) {
    throw new CandidateSelectionError('The file candidate must be a relative repository path.');
  }

  const resolvedRoot = await realpath(root);
  const lexicalCandidate = path.resolve(resolvedRoot, candidatePath);
  if (!isBelowRoot(resolvedRoot, lexicalCandidate)) {
    throw new CandidateSelectionError('The file candidate escapes the repository root.');
  }

  const relativeCandidate = path.relative(resolvedRoot, lexicalCandidate);
  if (isSensitivePath(relativeCandidate)) {
    throw new CandidateSelectionError('The file candidate is blocked by the secret-file policy.');
  }

  let resolvedCandidate: string;
  try {
    resolvedCandidate = await realpath(lexicalCandidate);
  } catch {
    throw new CandidateSelectionError('The file candidate does not exist.');
  }
  if (!isBelowRoot(resolvedRoot, resolvedCandidate)) {
    throw new CandidateSelectionError('The file candidate resolves outside the repository root.');
  }
  if (isSensitivePath(path.relative(resolvedRoot, resolvedCandidate))) {
    throw new CandidateSelectionError('The resolved file candidate is blocked by the secret-file policy.');
  }

  const fileStat = await lstat(resolvedCandidate);
  if (!fileStat.isFile()) {
    throw new CandidateSelectionError('The file candidate is not a regular file.');
  }

  return path.relative(resolvedRoot, resolvedCandidate);
}

function preferredReadCandidates(state: AgentState, searchResults: string[]): string[] {
  const searched = searchResults.filter((candidate) => !state.filesRead.includes(candidate));
  const searchedSet = new Set(searched);
  const knownPaths = state.repo.topLevelFiles
    .filter((entry) => !entry.endsWith('/'))
    .filter((candidate) => !searchedSet.has(candidate))
    .filter((candidate) => !state.filesRead.includes(candidate));
  const preferences = [...REPOSITORY_INSTRUCTION_FILES, 'README.md', 'package.json', 'PLAN.md'];

  const sortedKnownPaths = knownPaths.sort((left, right) => {
    const leftIndex = preferences.indexOf(left);
    const rightIndex = preferences.indexOf(right);
    const leftRank = leftIndex === -1 ? preferences.length : leftIndex;
    const rightRank = rightIndex === -1 ? preferences.length : rightIndex;
    return leftRank - rightRank || left.localeCompare(right);
  });
  const instructions: string[] = REPOSITORY_INSTRUCTION_FILES
    .filter((file) => state.repo.topLevelFiles.includes(file) && !state.filesRead.includes(file));
  return [...instructions, ...searched.filter((file) => !instructions.includes(file)),
    ...sortedKnownPaths.filter((file) => !instructions.includes(file))];
}

function validationCommand(
  packageManager: TestProposal['input']['packageManager'],
  script: string,
): Pick<TestProposal['input'], 'command' | 'args'> {
  switch (packageManager) {
    case 'pnpm':
      return { command: 'pnpm', args: ['run', script] };
    case 'npm':
      return { command: 'npm', args: ['run', script] };
    case 'yarn':
      return { command: 'yarn', args: ['run', script] };
    case 'bun':
      return { command: 'bun', args: ['run', script] };
  }
}

export async function selectCandidate(
  action: Action,
  state: AgentState,
  searchResults: string[] = [],
): Promise<CandidateProposal> {
  const preparation = taskPreparation(state);
  if (preparation.nextAction !== null && requiresTaskPreparation(action)) {
    return {
      action: 'ASK_USER', tool: null, input: null,
      reason: 'The linked issue and known repository instructions must be read before testing, delegation, or completion.',
    };
  }
  switch (action) {
    case 'SEARCH_REPO':
      return {
        action,
        tool: 'rg',
        input: { root: state.repo.root, terms: deriveSearchTerms(state.evidence?.issue?.title ?? state.task) },
      };
    case 'READ_ISSUE': {
      const issue = parseGitHubIssue(state.task);
      return issue && state.evidence?.issue?.url !== issue.url ? {
        action,
        tool: 'github_issue',
        input: { url: issue.url },
      } : {
        action: 'ASK_USER',
        tool: null,
        input: null,
        reason: issue ? 'The linked issue is already available as untrusted context.' : 'The task is not a supported GitHub issue URL.',
      };
    }
    case 'READ_FILE': {
      const requiredInstruction = preparation.unreadInstructions[0];
      if (requiredInstruction) {
        try {
          await resolveSafeRepoFile(state.repo.root, requiredInstruction);
          return { action, tool: 'read_file', input: { root: state.repo.root, path: requiredInstruction } };
        } catch (error) {
          if (!(error instanceof CandidateSelectionError)) throw error;
          return {
            action: 'ASK_USER', tool: null, input: null,
            reason: `The required repository instruction file ${requiredInstruction} cannot be read safely.`,
          };
        }
      }
      for (const candidate of preferredReadCandidates(state, searchResults)) {
        try {
          const safePath = await resolveSafeRepoFile(state.repo.root, candidate);
          return {
            action,
            tool: 'read_file',
            input: { root: state.repo.root, path: safePath },
          };
        } catch (error) {
          if (!(error instanceof CandidateSelectionError)) throw error;
        }
      }
      return {
        action: 'ASK_USER',
        tool: null,
        input: null,
        reason: 'No safe unread repository file is available.',
      };
    }
    case 'RUN_TESTS': {
      const script = selectPendingValidation(state);
      if (!script) {
        return {
          action: 'ASK_USER',
          tool: null,
          input: null,
          reason: hasPassedValidation(state)
            ? 'All required independent checks already passed; review the original task before completion.'
            : 'No declared validation script can cover the pending required checks.',
        };
      }
      if (state.repo.packageManager === 'unknown') {
        return {
          action: 'ASK_USER',
          tool: null,
          input: null,
          reason: 'The package manager could not be detected from a lockfile.',
        };
      }
      return {
        action,
        tool: 'package_script',
        input: {
          root: state.repo.root,
          packageManager: state.repo.packageManager,
          script,
          ...validationCommand(state.repo.packageManager, script),
        },
      };
    }
    case 'CALL_CODEX':
      if (state.codexCalls >= MAX_CODEX_CALLS) {
        return {
          action: 'ASK_USER',
          tool: null,
          input: null,
          reason: `The per-run Codex call limit of ${MAX_CODEX_CALLS} has been reached.`,
        };
      }
      return {
        action,
        tool: 'codex_cli',
        input: {
          root: state.repo.root,
          task: requireBoundedTask(state.task),
          context: buildWorkerContext(state),
        },
      };
    case 'CALL_CLAUDE':
      if (state.claudeCalls >= MAX_CLAUDE_CALLS) {
        return {
          action: 'ASK_USER',
          tool: null,
          input: null,
          reason: `The per-run Claude call limit of ${MAX_CLAUDE_CALLS} has been reached.`,
        };
      }
      return {
        action,
        tool: 'claude_code_cli',
        input: {
          root: state.repo.root,
          task: requireBoundedTask(state.task),
          context: buildWorkerContext(state),
        },
      };
    case 'ASK_USER':
      return {
        action,
        tool: null,
        input: null,
        reason: 'The policy requires user input before work can continue.',
      };
    case 'FINISH':
      return {
        action,
        tool: null,
        input: null,
        reason: 'Approval confirms the original task acceptance criteria are satisfied, supported by passing independent validation.',
      };
    case 'RUN_COMMAND': {
      const diagnostic = selectDiagnosticCommand(state.repo.gitStatus);
      return {
        action,
        tool: 'diagnostic_command',
        input: {
          root: state.repo.root,
          diagnostic: diagnostic.id,
          command: diagnostic.command,
          args: diagnostic.args,
        },
      };
    }
  }
}

export function proposalSignature(proposal: CandidateProposal, state: AgentState): string {
  const semantic = proposal.action === 'CALL_CODEX' || proposal.action === 'CALL_CLAUDE'
    ? { action: proposal.action, evidence: workerEvidenceKey(state) }
    : {
      action: proposal.action,
      input: proposal.input,
      generation: proposal.action === 'RUN_TESTS' ? state.evidence?.validationGeneration ?? 0 : 0,
      evidence: proposal.action === 'RUN_TESTS'
        ? state.evidence?.clarifications.map((item) => item.text) ?? []
        : state.evidence?.revision ?? 0,
    };
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex');
}
