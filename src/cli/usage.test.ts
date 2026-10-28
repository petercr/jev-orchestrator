import { describe, expect, it } from 'vitest';
import { addWorkerUsage, emptyWorkerUsage } from '../agents/usage.js';
import { formatWorkerUsage } from './usage.js';

describe('worker usage presentation', () => {
  it('distinguishes no calls, unavailable usage, and a reported zero', () => {
    const usage = emptyWorkerUsage();
    expect(formatWorkerUsage(usage)).toBe('Worker tokens: no worker calls.');
    addWorkerUsage(usage, 'codex');
    expect(formatWorkerUsage(usage)).toContain('Worker tokens: unavailable; Codex unavailable; Claude no calls.');
    addWorkerUsage(usage, 'claude', { input: 0, output: 0, total: 0 });
    expect(formatWorkerUsage(usage)).toContain('0 reported (partial)');
    expect(formatWorkerUsage(usage)).toContain('Usage reported for 1/2 attempts; 1 unavailable.');
  });

  it('shows a combined total and separate input/output counts with stable number formatting', () => {
    const usage = emptyWorkerUsage();
    addWorkerUsage(usage, 'codex', { input: 1_200, output: 300, total: 1_500 });
    addWorkerUsage(usage, 'claude', { input: 600, output: 200, total: 800 });
    expect(formatWorkerUsage(usage, 'Saved task worker tokens')).toBe(
      'Saved task worker tokens: 2,300 total; Codex 1,500 (1,200 input, 300 output); Claude 800 (600 input, 200 output). Usage reported for 2/2 attempts.',
    );
  });
});
