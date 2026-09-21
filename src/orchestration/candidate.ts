import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { requireBoundedTask } from '../limits.js';
import type { Action, AgentState } from '../types.js';

export const EXECUTABLE_ACTIONS = [
  'SEARCH_REPO',
  'READ_FILE',
  'RUN_TESTS',
  'CALL_CODEX',
  'ASK_USER',
  'FINISH',
] as const satisfies readonly Action[];

export const MAX_CODEX_CALLS = 2;

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

export type CodexProposal = {
  action: 'CALL_CODEX';
  tool: 'codex_cli';
  input: {
    root: string;
    task: string;
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
  | TestProposal
  | CodexProposal
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
  const preferences = ['README.md', 'package.json', 'PLAN.md'];

  const sortedKnownPaths = knownPaths.sort((left, right) => {
    const leftIndex = preferences.indexOf(left);
    const rightIndex = preferences.indexOf(right);
    const leftRank = leftIndex === -1 ? preferences.length : leftIndex;
    const rightRank = rightIndex === -1 ? preferences.length : rightIndex;
    return leftRank - rightRank || left.localeCompare(right);
  });
  return [...searched, ...sortedKnownPaths];
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

function selectValidationScript(scripts: string[]): string | undefined {
  const priority = ['test', 'check', 'typecheck', 'lint', 'build'];
  return [...scripts].sort((left, right) => {
    const rank = (script: string): number => {
      const index = priority.findIndex((name) => script === name || script.startsWith(`${name}:`));
      return index === -1 ? priority.length : index;
    };
    return rank(left) - rank(right) || left.localeCompare(right);
  })[0];
}

export async function selectCandidate(
  action: Action,
  state: AgentState,
  searchResults: string[] = [],
): Promise<CandidateProposal> {
  switch (action) {
    case 'SEARCH_REPO':
      return {
        action,
        tool: 'rg',
        input: { root: state.repo.root, terms: deriveSearchTerms(state.task) },
      };
    case 'READ_FILE': {
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
      const script = selectValidationScript(state.repo.validationScripts);
      if (!script) {
        return {
          action: 'ASK_USER',
          tool: null,
          input: null,
          reason: 'No recognized validation script is available.',
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
        reason: 'Completion requires explicit user approval.',
      };
    case 'RUN_COMMAND':
      return {
        action: 'ASK_USER',
        tool: null,
        input: null,
        reason: 'RUN_COMMAND remains disabled until a reviewed diagnostic allowlist exists.',
      };
  }
}

export function proposalSignature(proposal: CandidateProposal): string {
  return JSON.stringify({ action: proposal.action, input: proposal.input });
}
