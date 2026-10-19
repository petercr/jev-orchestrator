import { describe, expect, it } from 'vitest';
// @ts-expect-error Offline JavaScript reporting instrument has no declaration file.
import { auditValidationReceipts } from '../scripts/workflows/receipts.mjs';

function fixture() {
  const rows = ['test', 'lint'].map((script, index) => ({
    iteration: index + 5,
    stateBefore: { evidence: { validationGeneration: 2 } },
    stateAfter: { evidence: { validationGeneration: 2, validations: [{ script: '[TRUNCATED]' }] } },
    toolInput: { script },
    approval: { kind: 'approve' },
    proposal: { selected: { action: 'RUN_TESTS', tool: 'package_script' } },
    toolResult: { action: 'RUN_TESTS', ok: true, exitCode: 0, timedOut: false },
  }));
  return [...rows, { iteration: 7,
    stateAfter: { evidence: { validationGeneration: 2 }, tests: { passed: true } },
    summary: { validation: { generation: 2, passed: true, requirementsOmitted: false,
      repoRefreshRequired: false, checks: ['test', 'lint'].map((script) => ({ script, status: 'passed' })) } },
  }];
}

describe('supplemental offline workflow receipt audit', () => {
  it('uses actual approved receipts and current summary despite truncated state labels', () => {
    expect(auditValidationReceipts(fixture())).toEqual([
      { script: 'test', iteration: 5, generation: 2, exitCode: 0 },
      { script: 'lint', iteration: 6, generation: 2, exitCode: 0 },
    ]);
  });

  it('refuses stale receipts after another worker generation', () => {
    const rows = fixture();
    rows[0]!.stateAfter.evidence.validationGeneration = 1;
    expect(auditValidationReceipts(rows)).toBeNull();
  });

  it('refuses missing receipts and does not infer passing evidence from a summary', () => {
    expect(auditValidationReceipts(fixture().slice(1))).toBeNull();
    expect(auditValidationReceipts([])).toBeNull();
  });

  it('refuses a failed later attempt rather than accepting an older success', () => {
    const rows = fixture();
    rows.splice(2, 0, { ...rows[0]!, iteration: 7,
      toolResult: { action: 'RUN_TESTS', ok: false, exitCode: 1, timedOut: false } });
    expect(auditValidationReceipts(rows)).toBeNull();
  });
});
