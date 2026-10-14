"""Independent acceptance/patch receipts. --validate runs the direct control's root checks."""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from report_helpers import parse_acceptance, parse_test_summaries

root = Path(sys.argv[1]).resolve()
name = sys.argv[2]
manifest = json.loads((root / 'manifest.json').read_text())
assert name in manifest['runOrder']
case = root / name
repo = case / 'repo'
worker, kind, repetition = name.split('-')
environment = {**os.environ, 'PATH': str(case / 'bin') + os.pathsep + os.environ['PATH'], 'BENCH_CASE_DIR': str(case), 'BENCH_PACKAGE_ENTRY': manifest['packageEntry'], 'NEXT_TELEMETRY_DISABLED': '1'}
for command, executable in manifest['realExecutables'].items(): environment['BENCH_REAL_' + command.upper()] = executable

def run(label, command, cwd=repo):
    started = time.monotonic()
    timed_out = False
    with (case / (label + '.log')).open('w') as log:
        child = subprocess.Popen(command, cwd=cwd, env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try: code = child.wait(timeout=120)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(child.pid, signal.SIGTERM)
            try: code = child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                code = child.wait()
    result = {'command': command, 'exitCode': code, 'timedOut': timed_out, 'durationMs': round((time.monotonic() - started) * 1000), 'log': label + '.log'}
    print(json.dumps({'case': name, 'check': label, **result}), flush=True)
    return result

def counts(path):
    if not path.is_file(): return {}
    data = json.loads(path.read_text())
    return {key: data[key] for key in ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests']}

def trace_rows():
    return [json.loads(line) for trace in sorted((repo / 'traces').glob('*.jsonl')) for line in trace.read_text().splitlines() if line.strip()]

verification_path = case / 'verification.json'
if not verification_path.exists():
    verification = {'independentRootChecks': [], 'supplementalRootChecks': []}
    if '--validate' in sys.argv:
        assert kind == 'standalone'
        for script in ['test', 'typecheck', 'lint', 'build']:
            result = run('independent-' + script, ['pnpm', 'run', script])
            result['script'] = script
            verification['independentRootChecks'].append(result)
            verification_path.write_text(json.dumps(verification, indent=2) + '\n')
    if '--validate-remaining' in sys.argv:
        assert kind == 'jev' and (case / 'timings.json').exists(), 'Supplemental checks require an already terminated loop.'
        attempted = {row['toolInput']['script'] for row in trace_rows() if (row.get('toolResult') or {}).get('action') == 'RUN_TESTS'}
        for script in ['test', 'typecheck', 'lint', 'build']:
            if script in attempted: continue
            result = run('supplemental-' + script, ['pnpm', 'run', script])
            result.update({'script': script, 'includedInCliMetrics': False})
            verification['supplementalRootChecks'].append(result)
            verification_path.write_text(json.dumps(verification, indent=2) + '\n')
    test = repo / 'apps/web/lib/format.test.ts'
    if test.is_file():
        report = case / 'format-tests.json'
        verification['formatTests'] = run('format-tests', ['pnpm', '--filter', 'web', 'exec', 'vitest', 'run', 'lib/format.test.ts', '--reporter=json', '--outputFile=' + str(report)])
        verification['formatTests']['counts'] = counts(report)
        regression = case / 'regression-web'
        (regression / 'lib').mkdir(parents=True)
        web = repo / 'apps/web'
        for filename in ['vitest.config.ts', 'vitest.setup.ts', 'vitest.d.ts', 'package.json']:
            shutil.copyfile(web / filename, regression / filename)
        shutil.copyfile(test, regression / 'lib/format.test.ts')
        (regression / 'lib/format.ts').write_bytes(subprocess.check_output(['git', 'show', 'HEAD:apps/web/lib/format.ts'], cwd=repo))
        (regression / 'node_modules').symlink_to(web / 'node_modules', target_is_directory=True)
        regression_report = regression / 'tests.json'
        verification['baselineRegression'] = run('baseline-regression', ['node', str(web / 'node_modules/vitest/vitest.mjs'), 'run', 'lib/format.test.ts', '--reporter=json', '--outputFile=' + str(regression_report)], regression)
        verification['baselineRegression']['counts'] = counts(regression_report)
        if regression_report.exists():
            data = json.loads(regression_report.read_text())
            verification['baselineRegression']['failedTitles'] = [assertion['fullName'] for suite in data['testResults'] for assertion in suite['assertionResults'] if assertion['status'] == 'failed']
    probe = case / 'acceptance-probe.mjs'
    probe.write_text('''import { pathToFileURL } from 'node:url';
const { truncateAddress } = await import(pathToFileURL(process.argv[2]));
const fixture = 'GACR43EX3GKZWQEHHTM6XPBSKBJLHNZPJFXZFXMFXSTF34OCDSNZHWGB';
const examples = [['empty', '', ''], ['undefined', undefined, ''], ['null', null, '']];
for (let length = 1; length <= 10; length++) { const text = 'ABCDEFGHIJ'.slice(0, length); examples.push(['length-' + length, text, text]); }
examples.push(['length-11', 'ABCDEFGHIJK', 'ABCDEF...HIJK'], ['stellar-address-56', fixture, 'GACR43...HWGB']);
const results = examples.map(([name, input, expected]) => { const actual = truncateAddress(input); return { name, expected, actual, passed: actual === expected }; });
console.log(JSON.stringify({ fixtureLength: fixture.length, passed: results.every((result) => result.passed), results }));
process.exitCode = results.every((result) => result.passed) ? 0 : 1;
''')
    verification['acceptanceProbe'] = run('acceptance', ['node', str(probe), str(repo / 'apps/web/lib/format.ts')])
    try: verification['acceptanceProbe']['results'] = json.loads((case / 'acceptance.log').read_text())
    except ValueError: verification['acceptanceProbe']['results'] = {'passed': False}
    verification_path.write_text(json.dumps(verification, indent=2) + '\n')
else:
    verification = json.loads(verification_path.read_text())

# Node may append a module-format warning to the combined stdout/stderr log.
# Parse the probe's own JSON line; keep the complete diagnostic log unchanged.
try:
    verification['acceptanceProbe']['results'] = parse_acceptance((case / 'acceptance.log').read_text())
except ValueError:
    verification['acceptanceProbe']['results'] = {'passed': False}
verification_path.write_text(json.dumps(verification, indent=2) + '\n')

initial = json.loads((case / 'target-before.json').read_text())
tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=repo).decode().split('\0')
files = {filename: hashlib.sha256((repo / filename).read_bytes()).hexdigest() for filename in tracked if filename and (repo / filename).is_file()}
changed = {filename for filename in set(files) | set(initial['files']) if files.get(filename) != initial['files'].get(filename)}
if (repo / 'apps/web/lib/format.test.ts').exists(): changed.add('apps/web/lib/format.test.ts')
status = subprocess.check_output(['git', 'status', '--porcelain'], cwd=repo, text=True)
untracked = {line[3:] for line in status.splitlines() if line.startswith('?? ')}
patch = subprocess.check_output(['git', 'diff', 'HEAD', '--binary'], cwd=repo)
if (repo / 'apps/web/lib/format.test.ts').exists():
    added = subprocess.run(['git', 'diff', '--no-index', '--binary', '--', '/dev/null', 'apps/web/lib/format.test.ts'], cwd=repo, capture_output=True)
    if added.returncode == 1: patch += added.stdout
(case / 'issue949.patch').write_bytes(patch)
reverse = subprocess.run(['git', 'apply', '--reverse', '--check', str(case / 'issue949.patch')], cwd=repo, capture_output=True).returncode == 0
rows = trace_rows() if kind == 'jev' else []
tools = [row for row in rows if row.get('toolResult')]
validations = [row for row in tools if row['toolResult']['action'] == 'RUN_TESTS']
root_checks = [{'script': row['toolInput']['script'], 'exitCode': row['toolResult']['exitCode'], 'timedOut': row['toolResult']['timedOut'], 'durationMs': row['toolResult']['durationMs']} for row in validations] if kind == 'jev' else verification['independentRootChecks']
if kind == 'jev': root_checks += verification.get('supplementalRootChecks', [])
proxies = [json.loads(path.read_text()) for path in sorted(case.glob(worker + '-*.json'))]
full_test_logs = [path.with_suffix('.stdout.log') for path in case.glob('pnpm-*.json') if (metadata := json.loads(path.read_text())).get('originalArgs') == ['run', 'test'] and metadata.get('cwd') == str(repo)]
test_summaries = [summary for log in full_test_logs if log.exists() for summary in parse_test_summaries(log.read_text())]
test_counts = [sum(summary.values()) for summary in test_summaries]
unit = verification.get('formatTests', {}).get('counts', {})
regression = verification.get('baselineRegression', {}).get('counts', {})
checks = {
    'target_head_preserved': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip() == initial['head'],
    'target_index_has_no_staged_edits': subprocess.run(['git', 'diff', '--cached', '--quiet'], cwd=repo).returncode == 0,
    'only_task_files_changed': changed == {'apps/web/lib/format.ts', 'apps/web/lib/format.test.ts'} and untracked == {'apps/web/lib/format.test.ts'},
    'reverse_patch_check_passed': reverse,
    'all_fifteen_acceptance_cases_pass': verification['acceptanceProbe']['exitCode'] == 0 and not verification['acceptanceProbe']['timedOut'] and verification['acceptanceProbe']['results'].get('passed') is True and len(verification['acceptanceProbe']['results'].get('results', [])) == 15,
    'new_formatter_tests_pass': unit.get('numTotalTests', 0) > 0 and unit.get('numFailedTests') == 0 and unit.get('numPendingTests') == 0 and verification.get('formatTests', {}).get('exitCode') == 0,
    'new_tests_detect_original_bug': regression.get('numFailedTests', 0) > 0 and regression.get('numPassedTests', 0) > 0 and verification.get('baselineRegression', {}).get('exitCode') == 1,
    'all_four_independent_root_checks_pass': {result['script'] for result in root_checks if result['exitCode'] == 0 and not result['timedOut']} == {'test', 'typecheck', 'lint', 'build'},
    'full_workspace_test_log_recorded': len(test_counts) == 4 and sum(test_counts) > 800,
    'one_successful_worker_process': len(proxies) == 1 and proxies[0].get('completed') is True and proxies[0].get('exitCode') == 0 and not proxies[0].get('outputLimitExceeded'),
}
summary = rows[-1].get('summary') if rows else None
terminal = (case / 'terminal.txt').read_text() if (case / 'terminal.txt').exists() else ''
status_match = re.search(r'Loop status: ([a-z_]+)', terminal)
loop_status = status_match.group(1) if status_match else None
if kind == 'jev' and summary:
    checks['completion_or_explicit_incomplete_status_recorded'] = loop_status is not None
    checks['iteration_and_call_limits_preserved'] = max(row['iteration'] for row in rows) <= 8 and summary['counts']['codexCalls'] <= 2 and summary['counts']['claudeCalls'] <= 2
    checks['fresh_current_generation_validation'] = summary['validation']['passed'] and summary['validation']['generation'] >= 1
receipt = {
    'case': name, 'trackingIssue': 31, 'task': manifest['task'], 'changedPaths': sorted(changed),
    'patchSha256': hashlib.sha256(patch).hexdigest(), 'checks': checks,
    'acceptedPatch': all(checks.values()), 'rootChecks': root_checks,
    'fullWorkspaceTests': sum(test_counts), 'fullTestSummaries': test_summaries, 'workerProcesses': proxies,
    'independentVerification': verification, 'cliSummary': summary, 'loopStatus': loop_status,
    'actionSequence': [{'iteration': row['iteration'], 'action': row['toolResult']['action'], 'script': row.get('toolInput', {}).get('script'), 'ok': row['toolResult']['ok']} for row in tools],
    'manualAlternatives': [item['action'] for row in rows for item in (row.get('approval') or {}).get('history', []) if item['kind'] == 'alternative'],
    'truncatedTraceStates': [{'iteration': row['iteration'], 'field': field} for row in rows for field in ['stateBefore', 'stateAfter'] if row.get(field, {}).get('truncated') is True],
}
(case / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({'case': name, 'acceptedPatch': receipt['acceptedPatch'], 'checks': checks, 'fullWorkspaceTests': sum(test_counts)}, indent=2), flush=True)
raise SystemExit(0 if receipt['acceptedPatch'] else 1)
