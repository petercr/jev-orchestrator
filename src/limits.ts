export const MAX_TASK_LENGTH = 4_000;
export const MAX_EVALUATION_TEXT_LENGTH = 2_000;
export const MAX_EVALUATION_LIST_ITEMS = 100;
export const MAX_EVALUATION_COMMANDS = 20;
export const MAX_EVALUATION_COMMAND_OUTPUT_LENGTH = 2_000;

const TRUNCATION_MARKER = '… [truncated]';

export function truncateText(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  if (maximumLength <= 0) return '';
  if (maximumLength <= TRUNCATION_MARKER.length) return value.slice(0, maximumLength);

  const contentLength = maximumLength - TRUNCATION_MARKER.length;
  return `${value.slice(0, contentLength)}${TRUNCATION_MARKER}`;
}

export function limitStrings(
  values: string[],
  maximumItems: number = MAX_EVALUATION_LIST_ITEMS,
  maximumLength: number = MAX_EVALUATION_TEXT_LENGTH,
): string[] {
  return values.slice(0, maximumItems).map((value) => truncateText(value, maximumLength));
}

export function requireBoundedTask(task: string): string {
  if (task.length > MAX_TASK_LENGTH) {
    throw new Error(`Task exceeds the ${MAX_TASK_LENGTH}-character limit.`);
  }
  return task;
}
