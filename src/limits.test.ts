import { describe, expect, it } from 'vitest';
import {
  limitStrings,
  MAX_TASK_LENGTH,
  requireBoundedTask,
  truncateText,
} from './limits.js';

describe('input limits', () => {
  it('truncates text without exceeding the requested limit', () => {
    expect(truncateText('abcdefghijk', 8)).toBe('abcdefgh');
    expect(truncateText('abcdefghijk', 20)).toBe('abcdefghijk');
  });

  it('bounds both list size and element size', () => {
    expect(limitStrings(['abcdefgh', 'ijklmnop'], 1, 4)).toEqual(['abcd']);
  });

  it('rejects tasks larger than the CLI input limit', () => {
    expect(() => requireBoundedTask('x'.repeat(MAX_TASK_LENGTH + 1))).toThrow(
      `Task exceeds the ${MAX_TASK_LENGTH}-character limit.`,
    );
  });
});
