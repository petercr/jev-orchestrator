// Supplemental, offline reporting. Added after the pilot exposed truncation of
// stateAfter validation labels. Does not alter the frozen launcher or traces.
export function auditValidationReceipts(rows) {
  const last = rows.at(-1);
  const generation = last?.stateAfter?.evidence?.validationGeneration;
  const validation = last?.summary?.validation;
  if (!Number.isInteger(generation) || generation < 0 ||
      last?.stateAfter?.tests?.passed !== true || validation?.generation !== generation ||
      validation.passed !== true || validation.requirementsOmitted !== false ||
      validation.repoRefreshRequired !== false) return null;

  const receipts = [];
  for (const script of ['test', 'lint']) {
    if (!validation.checks?.some((check) => check.script === script && check.status === 'passed')) return null;
    const row = rows.filter((item) => item.stateAfter?.evidence?.validationGeneration === generation &&
      item.toolInput?.script === script && item.toolResult?.action === 'RUN_TESTS').at(-1);
    if (!row || row.stateBefore?.evidence?.validationGeneration !== generation ||
        row.approval?.kind !== 'approve' || row.proposal?.selected?.action !== 'RUN_TESTS' ||
        row.proposal?.selected?.tool !== 'package_script' || row.toolResult.ok !== true ||
        row.toolResult.exitCode !== 0 || row.toolResult.timedOut !== false ||
        row.toolResult.cancelled === true) return null;
    receipts.push({ script, iteration: row.iteration, generation, exitCode: 0 });
  }
  return receipts;
}
