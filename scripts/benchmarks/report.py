"""Aggregate all scheduled observations, including unsuccessful workflows."""
from pathlib import Path
import json
import sys
from report_helpers import comparison_outcome, direct_status, timing_statistics

root = Path(sys.argv[1]).resolve()
manifest = json.loads((root / 'manifest.json').read_text())
runs = []
for name in manifest['runOrder']:
    case = root / name
    receipt = json.loads((case / 'receipt.json').read_text())
    timing = json.loads((case / 'timings.json').read_text())
    worker, kind, repetition = name.split('-')
    summary = receipt['cliSummary']
    if kind == 'jev':
        phases = summary['timings']
        status = receipt['loopStatus']
        counts = summary['counts']
        waits = sum(phases[key] for key in ['approvalWaitMs', 'informationWaitMs', 'recoveryWaitMs'])
        evaluation = phases['evaluationMs']
        preparation = phases['preparationMs']
        outside_validation = sum(check['durationMs'] for check in receipt['independentVerification'].get('supplementalRootChecks', []))
        validation = phases['validationMs'] + outside_validation
        active = phases['activeMs'] + outside_validation
        worker_ms = phases['workerMs']
    else:
        direct = json.loads((case / 'direct-result.json').read_text())
        status = direct_status(direct, receipt)
        counts = {'workerCalls': 1, 'adapterRetries': 0}
        waits = 0
        evaluation = 0
        preparation = direct['preparationMs']
        validation = sum(check['durationMs'] for check in receipt['rootChecks'])
        active = direct['activeBeforeValidationMs'] + validation
        worker_ms = direct['durationMs']
        outside_validation = 0
    workflow_success = receipt['acceptedPatch'] and (status == 'finished' if kind == 'jev' else status == 'ready_for_review')
    runs.append({
        'case': name, 'worker': worker, 'kind': kind, 'repetition': int(repetition), 'status': status,
        'outcome': comparison_outcome(status, receipt['rootChecks']),
        'exitCode': timing['run']['exitCode'], 'workflowSuccess': workflow_success, 'acceptedPatch': receipt['acceptedPatch'],
        'rootCheckExitCodes': {check['script']: check['exitCode'] for check in receipt['rootChecks']},
        'workerMs': worker_ms, 'evaluationMs': evaluation, 'preparationMs': preparation,
        'validationMs': validation, 'activeMs': active, 'promptWaitMs': waits,
        'supplementalValidationMs': outside_validation,
        'cliActiveMs': phases['activeMs'] if kind == 'jev' else None,
        'counts': counts, 'reportedUsage': [process.get('usage') for process in receipt['workerProcesses']],
        'reportedCostsUsd': [process['reportedCostUsd'] for process in receipt['workerProcesses'] if 'reportedCostUsd' in process],
        'servedWorkerModels': [model for process in receipt['workerProcesses'] for model in process.get('servedModels', [])],
        'patchSha256': receipt['patchSha256'], 'fullWorkspaceTests': receipt['fullWorkspaceTests'],
    })

aggregates = []
for worker in ['codex', 'claude']:
    for kind in ['jev', 'standalone']:
        selected = [run for run in runs if run['worker'] == worker and run['kind'] == kind]
        metrics = {}
        for field in ['workerMs', 'evaluationMs', 'preparationMs', 'validationMs', 'activeMs', 'promptWaitMs']:
            values = [run[field] for run in selected]
            metrics[field] = timing_statistics(values)
        successful_metrics = {field: timing_statistics([run[field] for run in selected if run['workflowSuccess']]) for field in ['workerMs', 'activeMs']}
        aggregates.append({'worker': worker, 'kind': kind, 'n': len(selected), 'acceptedPatches': sum(run['acceptedPatch'] for run in selected), 'successfulWorkflows': sum(run['workflowSuccess'] for run in selected), 'metrics': metrics, 'successfulWorkflowMetrics': successful_metrics})

evidence_matches = []
for worker in ['codex', 'claude']:
    for repetition in range(1, 4):
        direct = json.loads((root / f'{worker}-standalone-{repetition}' / 'direct-request.json').read_text())
        case = root / f'{worker}-jev-{repetition}'
        rows = [json.loads(line) for trace in (case / 'repo/traces').glob('*.jsonl') for line in trace.read_text().splitlines() if line.strip()]
        worker_row = next((row for row in rows if (row.get('toolResult') or {}).get('action') == 'CALL_' + worker.upper()), None)
        context = worker_row.get('toolInput', {}).get('context') if worker_row else None
        def evidence(context):
            return {'issue': context['issue'], 'instructions': [{key: finding[key] for key in ['source', 'paths', 'excerpt']} for finding in context['findings']]}
        paired_receipts = [json.loads((root / f'{worker}-{kind}-{repetition}' / 'receipt.json').read_text()) for kind in ['jev', 'standalone']]
        def normalized_args(receipt, kind, field):
            processes = receipt['workerProcesses']
            if len(processes) != 1: return None
            selected_root = str(root / f'{worker}-{kind}-{repetition}' / 'repo')
            return [argument.replace(selected_root, '<repo>') for argument in processes[0][field]]
        original = [normalized_args(receipt, kind, 'originalArgs') for receipt, kind in zip(paired_receipts, ['jev', 'standalone'])]
        instrumented = [normalized_args(receipt, kind, 'args') for receipt, kind in zip(paired_receipts, ['jev', 'standalone'])]
        evidence_matches.append({'worker': worker, 'repetition': repetition, 'issueAndInstructionEvidenceMatches': context is not None and evidence(context) == evidence(direct['context']), 'fullContextMatches': context == direct['context'], 'originalWorkerArgumentsMatch': original[0] is not None and original[0] == original[1], 'instrumentedWorkerArgumentsMatch': instrumented[0] is not None and instrumented[0] == instrumented[1]})

receipt = {'manifest': manifest, 'runs': runs, 'aggregates': aggregates, 'evidenceMatches': evidence_matches}
(root / 'aggregate.json').write_text(json.dumps(receipt, indent=2) + '\n')
lines = ['# Issue #31 matched worker comparison', '', 'Three repetitions per setup, twelve observations in the recorded alternating order. Setup and baseline checks are excluded. All scheduled outcomes are retained.', '', '| Run | Outcome | Worker s | Eval s | Prep s | Validation s | Active s | Prompt wait s | Accepted patch |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |']
for run in runs:
    lines.append('| ' + ' | '.join([run['case'], run['outcome'], *[f"{run[field] / 1000:.3f}" for field in ['workerMs', 'evaluationMs', 'preparationMs', 'validationMs', 'activeMs', 'promptWaitMs']], str(run['acceptedPatch'])]) + ' |')
lines.extend(['', '| Setup | n | Accepted patches | Successful workflows | Worker mean / median / range s | Active mean / median / range s |', '| --- | ---: | ---: | ---: | --- | --- |'])
for group in aggregates:
    def formatted(field):
        metric = group['metrics'][field]
        return f"{metric['mean'] / 1000:.3f} / {metric['median'] / 1000:.3f} / {metric['min'] / 1000:.3f}–{metric['max'] / 1000:.3f}"
    lines.append(f"| {group['worker']} + {group['kind']} | {group['n']} | {group['acceptedPatches']} | {group['successfulWorkflows']} | {formatted('workerMs')} | {formatted('activeMs')} |")
lines.extend(['', 'Successful workflows only (failed observations remain in the table above):', '', '| Setup | Successful n | Worker mean / median / range s | Active mean / median / range s |', '| --- | ---: | --- | --- |'])
for group in aggregates:
    def successful_formatted(field):
        metric = group['successfulWorkflowMetrics'][field]
        if not metric['n']: return '—'
        return f"{metric['mean'] / 1000:.3f} / {metric['median'] / 1000:.3f} / {metric['min'] / 1000:.3f}–{metric['max'] / 1000:.3f}"
    lines.append(f"| {group['worker']} + {group['kind']} | {group['successfulWorkflows']} | {successful_formatted('workerMs')} | {successful_formatted('activeMs')} |")
lines.extend(['', 'Each case retains the invocation, original and instrumented worker arguments, full structured worker events, complete root-validation logs, reported usage/cost when present, patch, regression results, 15-case acceptance probe, and receipt. aggregate.json retains means, medians, ranges, sample standard deviations, counters, attribution, and exact evidence comparisons.', '', 'Direct controls use the same installed adapters and bounded issue/instruction preparation. They receive no evaluator or approval loop. The operator reviews each JEV candidate separately and verifies acceptance before approving completion; waits include those audits. Structured-output instrumentation is identical within each pair. Claude uses an explicit claude-sonnet-5-5 model identifier; Codex keeps gpt-5.6-terra/high, workspace-write and explicit command networking. Project tests, typecheck, lint, and build run independently after worker execution.', '', 'JEV comparison active time uses the built-in monotonic summary plus any separately timed post-stop root checks. Supplemental durations are explicit and never change CLI state, metrics, approvals, or completion. Direct active time sums its measured preparation/worker pipeline and the separately measured root checks; gaps between externally scheduled phases and additional acceptance audits are excluded. Prompt waits are reported separately. This does not represent fully unattended end-to-end latency.', '', 'Three samples on one small frontend task cannot establish a general speed advantage, confidence calibration, or broad correctness. Cache warmth, provider latency, and machine load are uncontrolled across repetitions. Only the TypeScript workspace checks are exercised; Go/database, browser E2E, and dependency audits remain outside scope. Codex upstream model versions and evaluator token usage/cost are omitted when unavailable. Claude cost fields are CLI-reported estimates, not billing receipts. Upstream HTTP retries and worker-internal provider retries are unavailable. The fixed protocol compares one implementation attempt per observation and does not exercise controlled repair.'])
(root / 'REPORT.md').write_text('\n'.join(lines) + '\n')
print(json.dumps({'observations': len(runs), 'acceptedPatches': sum(run['acceptedPatch'] for run in runs), 'successfulWorkflows': sum(run['workflowSuccess'] for run in runs), 'matchedEvidencePairs': sum(item['issueAndInstructionEvidenceMatches'] for item in evidence_matches)}, indent=2))
