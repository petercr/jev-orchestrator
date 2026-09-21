export const DIAGNOSTIC_COMMANDS = {
  git_status: {
    command: 'git',
    args: [
      '--no-pager',
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      'status',
      '--short',
      '--untracked-files=all',
      '--no-renames',
      '--ignore-submodules=all',
      '--',
      '.',
      ':(exclude)traces/**',
    ],
  },
  git_diff_stat: {
    command: 'git',
    args: [
      '--no-pager',
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      'diff',
      '--stat',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--ignore-submodules=all',
      'HEAD',
      '--',
      '.',
      ':(exclude)traces/**',
    ],
  },
} as const;

export type DiagnosticCommandId = keyof typeof DIAGNOSTIC_COMMANDS;

export type DiagnosticCommand = {
  id: DiagnosticCommandId;
  command: string;
  args: string[];
};

export function selectDiagnosticCommand(gitStatus: string[]): DiagnosticCommand {
  const id: DiagnosticCommandId = gitStatus.some((entry) => !entry.startsWith('??'))
    ? 'git_diff_stat'
    : 'git_status';
  const diagnostic = DIAGNOSTIC_COMMANDS[id];
  return {
    id,
    command: diagnostic.command,
    args: [...diagnostic.args],
  };
}

export function isAllowedDiagnosticCommand(
  id: string,
  command: string,
  args: string[],
): boolean {
  if (!Object.hasOwn(DIAGNOSTIC_COMMANDS, id)) return false;
  const diagnostic = DIAGNOSTIC_COMMANDS[id as DiagnosticCommandId];
  return command === diagnostic.command &&
    args.length === diagnostic.args.length &&
    args.every((argument, index) => argument === diagnostic.args[index]);
}
