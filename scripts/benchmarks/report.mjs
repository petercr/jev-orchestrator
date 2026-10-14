// Aggregate every scheduled observation, including unsuccessful workflows.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { externalRoot, isMain, loadManifest, readJson, readTraceRows, requireCondition, writeJson } from './lib.mjs';
import { comparisonOutcome, directStatus, timingStatistics } from './report-helpers.mjs';

const timingFields = ['workerMs', 'evaluationMs', 'preparationMs', 'validationMs', 'activeMs', 'promptWaitMs'];
const sum = (values) => values.reduce((total, value) => total + value, 0);

export function aggregateRun(name, receipt, timing, direct) {
  const [worker, kind, repetition] = name.split('-');
  const phases = receipt.cliSummary?.timings;
  const supplementalValidationMs = kind === 'jev' ? sum((receipt.independentVerification.supplementalRootChecks ?? []).map((check) => check.durationMs)) : 0;
  const status = kind === 'jev' ? receipt.loopStatus : directStatus(direct, receipt);
  const validationMs = kind === 'jev' ? phases.validationMs + supplementalValidationMs : sum(receipt.rootChecks.map((check) => check.durationMs));
  return {
    case: name, worker, kind, repetition: Number(repetition), status,
    outcome: comparisonOutcome(status, receipt.rootChecks), exitCode: timing.run.exitCode,
    workflowSuccess: receipt.acceptedPatch && (kind === 'jev' ? status === 'finished' : status === 'ready_for_review'),
    acceptedPatch: receipt.acceptedPatch,
    rootCheckExitCodes: Object.fromEntries(receipt.rootChecks.map((check) => [check.script, check.exitCode])),
    workerMs: kind === 'jev' ? phases.workerMs : direct.durationMs,
    evaluationMs: kind === 'jev' ? phases.evaluationMs : 0,
    preparationMs: kind === 'jev' ? phases.preparationMs : direct.preparationMs,
    validationMs,
    activeMs: kind === 'jev' ? phases.activeMs + supplementalValidationMs : direct.activeBeforeValidationMs + validationMs,
    promptWaitMs: kind === 'jev' ? sum(['approvalWaitMs', 'informationWaitMs', 'recoveryWaitMs'].map((key) => phases[key])) : 0,
    supplementalValidationMs, cliActiveMs: kind === 'jev' ? phases.activeMs : null,
    counts: kind === 'jev' ? receipt.cliSummary.counts : { workerCalls: 1, adapterRetries: 0 },
    reportedUsage: receipt.workerProcesses.map((process) => process.usage ?? null),
    reportedCostsUsd: receipt.workerProcesses.filter((process) => 'reportedCostUsd' in process).map((process) => process.reportedCostUsd),
    servedWorkerModels: receipt.workerProcesses.flatMap((process) => process.servedModels ?? []),
    patchSha256: receipt.patchSha256, fullWorkspaceTests: receipt.fullWorkspaceTests,
  };
}

export function aggregateGroups(runs) {
  return ['codex', 'claude'].flatMap((worker) => ['jev', 'standalone'].map((kind) => {
    const selected = runs.filter((run) => run.worker === worker && run.kind === kind);
    const successful = selected.filter((run) => run.workflowSuccess);
    return {
      worker, kind, n: selected.length,
      acceptedPatches: selected.filter((run) => run.acceptedPatch).length,
      successfulWorkflows: successful.length,
      metrics: Object.fromEntries(timingFields.map((field) => [field, timingStatistics(selected.map((run) => run[field]))])),
      successfulWorkflowMetrics: Object.fromEntries(['workerMs', 'activeMs'].map((field) => [field, timingStatistics(successful.map((run) => run[field]))])),
    };
  }));
}

function pairedEvidence(root, worker, repetition) {
  const direct = readJson(path.join(root, `${worker}-standalone-${repetition}`, 'direct-request.json'));
  const rows = readTraceRows(path.join(root, `${worker}-jev-${repetition}`, 'repo'));
  const workerRow = rows.find((row) => row.toolResult?.action === 'CALL_' + worker.toUpperCase());
  const context = workerRow?.toolInput?.context ?? null;
  const evidence = (context) => ({ issue: context.issue, instructions: context.findings.map(({ source, paths, excerpt }) => ({ source, paths, excerpt })) });
  const receipts = ['jev', 'standalone'].map((kind) => readJson(path.join(root, `${worker}-${kind}-${repetition}`, 'receipt.json')));
  const normalizedArgs = (receipt, kind, field) => receipt.workerProcesses.length === 1
    ? receipt.workerProcesses[0][field].map((argument) => argument.replaceAll(path.join(root, `${worker}-${kind}-${repetition}`, 'repo'), '<repo>')) : null;
  const original = receipts.map((receipt, index) => normalizedArgs(receipt, ['jev', 'standalone'][index], 'originalArgs'));
  const instrumented = receipts.map((receipt, index) => normalizedArgs(receipt, ['jev', 'standalone'][index], 'args'));
  return {
    worker, repetition,
    issueAndInstructionEvidenceMatches: context !== null && isDeepStrictEqual(evidence(context), evidence(direct.context)),
    fullContextMatches: isDeepStrictEqual(context, direct.context),
    originalWorkerArgumentsMatch: original[0] !== null && isDeepStrictEqual(original[0], original[1]),
    instrumentedWorkerArgumentsMatch: instrumented[0] !== null && isDeepStrictEqual(instrumented[0], instrumented[1]),
  };
}

export function buildReport(root, manifest) {
  const runs = manifest.runOrder.map((name) => {
    const directory = path.join(root, name);
    return aggregateRun(name, readJson(path.join(directory, 'receipt.json')), readJson(path.join(directory, 'timings.json')), name.includes('-standalone-') ? readJson(path.join(directory, 'direct-result.json')) : null);
  });
  const evidenceMatches = ['codex', 'claude'].flatMap((worker) => [1, 2, 3].map((repetition) => pairedEvidence(root, worker, repetition)));
  return { manifest, runs, aggregates: aggregateGroups(runs), evidenceMatches };
}

export function renderReport({ runs, aggregates }) {
  const seconds = (value) => (value / 1000).toFixed(3);
  const formatted = (metric) => metric.n ? `${seconds(metric.mean)} / ${seconds(metric.median)} / ${seconds(metric.min)}–${seconds(metric.max)}` : '—';
  const lines = ['# Issue #31 matched worker comparison', '', 'Three repetitions per setup, twelve observations in the recorded alternating order. Setup and baseline checks are excluded. All scheduled outcomes are retained.', '', '| Run | Outcome | Worker s | Eval s | Prep s | Validation s | Active s | Prompt wait s | Accepted patch |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |'];
  for (const run of runs) lines.push('| ' + [run.case, run.outcome, ...timingFields.map((field) => seconds(run[field])), run.acceptedPatch ? 'True' : 'False'].join(' | ') + ' |');
  lines.push('', '| Setup | n | Accepted patches | Successful workflows | Worker mean / median / range s | Active mean / median / range s |', '| --- | ---: | ---: | ---: | --- | --- |');
  for (const group of aggregates) lines.push(`| ${group.worker} + ${group.kind} | ${group.n} | ${group.acceptedPatches} | ${group.successfulWorkflows} | ${formatted(group.metrics.workerMs)} | ${formatted(group.metrics.activeMs)} |`);
  lines.push('', 'Successful workflows only (failed observations remain in the table above):', '', '| Setup | Successful n | Worker mean / median / range s | Active mean / median / range s |', '| --- | ---: | --- | --- |');
  for (const group of aggregates) lines.push(`| ${group.worker} + ${group.kind} | ${group.successfulWorkflows} | ${formatted(group.successfulWorkflowMetrics.workerMs)} | ${formatted(group.successfulWorkflowMetrics.activeMs)} |`);
  lines.push('', 'Each case retains the invocation, original and instrumented worker arguments, full structured worker events, complete root-validation logs, reported usage/cost when present, patch, regression results, 15-case acceptance probe, and receipt. aggregate.json retains means, medians, ranges, sample standard deviations, counters, attribution, and exact evidence comparisons.', '', 'Direct controls use the same installed adapters and bounded issue/instruction preparation. They receive no evaluator or approval loop. The operator reviews each JEV candidate separately and verifies acceptance before approving completion; waits include those audits. Structured-output instrumentation is identical within each pair. Claude uses an explicit claude-sonnet-5-5 model identifier; Codex keeps gpt-5.6-terra/high, workspace-write and explicit command networking. Project tests, typecheck, lint, and build run independently after worker execution.', '', 'JEV comparison active time uses the built-in monotonic summary plus any separately timed post-stop root checks. Supplemental durations are explicit and never change CLI state, metrics, approvals, or completion. Direct active time sums its measured preparation/worker pipeline and the separately measured root checks; gaps between externally scheduled phases and additional acceptance audits are excluded. Prompt waits are reported separately. This does not represent fully unattended end-to-end latency.', '', 'Three samples on one small frontend task cannot establish a general speed advantage, confidence calibration, or broad correctness. Cache warmth, provider latency, and machine load are uncontrolled across repetitions. Only the TypeScript workspace checks are exercised; Go/database, browser E2E, and dependency audits remain outside scope. Codex upstream model versions and evaluator token usage/cost are omitted when unavailable. Claude cost fields are CLI-reported estimates, not billing receipts. Upstream HTTP retries and worker-internal provider retries are unavailable. The fixed protocol compares one implementation attempt per observation and does not exercise controlled repair.');
  return lines.join('\n') + '\n';
}

export function report(directory, outputDirectory) {
  const { root, manifest } = loadManifest(directory);
  const output = outputDirectory ? externalRoot(outputDirectory, manifest.sourceCheckout) : root;
  mkdirSync(output, { recursive: true });
  const result = buildReport(root, manifest);
  writeJson(path.join(output, 'aggregate.json'), result);
  writeFileSync(path.join(output, 'REPORT.md'), renderReport(result));
  return { observations: result.runs.length, acceptedPatches: result.runs.filter((run) => run.acceptedPatch).length, successfulWorkflows: result.runs.filter((run) => run.workflowSuccess).length, matchedEvidencePairs: result.evidenceMatches.filter((pair) => pair.issueAndInstructionEvidenceMatches).length };
}

if (isMain(import.meta.url)) {
  const [directory, flag, output] = process.argv.slice(2);
  requireCondition(!flag || (flag === '--output' && output && process.argv.length === 5), 'Usage: node report.mjs EVIDENCE [--output OUTPUT]');
  console.log(JSON.stringify(report(directory, output), null, 2));
}
