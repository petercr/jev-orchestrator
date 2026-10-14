"""Audit configuration and preservation; never executes a recorded command."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
manifest = json.loads((root / 'manifest.json').read_text())
before = json.loads((root / 'original-before.json').read_text())
checks = {}
for selected, initial in before.items():
    repo = Path(selected)
    changed = [name for name, expected in initial['files'].items() if not (repo / name).is_file() or hashlib.sha256((repo / name).read_bytes()).hexdigest() != expected]
    allowed = {'PLAN.md', 'README.md'} if selected == manifest['sourceCheckout'] else set()
    checks['preserved_tracked_files:' + selected] = set(changed) <= allowed
    checks['preserved_head:' + selected] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip() == initial['head']
    if selected != manifest['sourceCheckout']:
        checks['preserved_worktree_status:' + selected] = subprocess.check_output(['git', 'status', '--porcelain'], cwd=repo, text=True) == initial['status']
for name in manifest['runOrder']:
    case = root / name
    worker, kind, _ = name.split('-')
    receipt = json.loads((case / 'receipt.json').read_text())
    process = receipt['workerProcesses'][0]
    args = process['args']
    checks['one_worker_attempt:' + name] = len(receipt['workerProcesses']) == 1
    if worker == 'codex':
        checks['codex_permissions_and_model:' + name] = args[args.index('--model') + 1] == 'gpt-5.6-terra' and args[args.index('--sandbox') + 1] == 'workspace-write' and args[args.index('--ask-for-approval') + 1] == 'never' and 'sandbox_workspace_write.network_access=true' in args and '--ignore-user-config' in args and '--ignore-rules' in args
    else:
        checks['claude_permissions_and_model:' + name] = args[args.index('--model') + 1] == 'claude-sonnet-5-5' and '--restricted' in args and '--strict-mcp-config' in args and args[args.index('--setting-sources') + 1] == '' and args[args.index('--tools') + 1] == 'Read,Write,Edit,Glob,Grep' and args[args.index('--allowedTools') + 1] == 'mcp__jev_files__rename_file' and process['servedModels'] == ['claude-sonnet-5-5']
    checks['no_full_access_fallback:' + name] = not any(argument in args for argument in ['danger-full-access', '--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox'])
    checks['target_scope_preserved:' + name] = all(receipt['checks'][key] for key in ['target_head_preserved', 'target_index_has_no_staged_edits', 'only_task_files_changed', 'reverse_patch_check_passed'])
    if kind == 'jev':
        rows = [json.loads(line) for trace in (case / 'repo/traces').glob('*.jsonl') for line in trace.read_text().splitlines() if line.strip()]
        summary = receipt['cliSummary']
        states = [row[field] for row in rows for field in ['stateBefore', 'stateAfter'] if not row[field].get('truncated')]
        checks['selection_and_limits:' + name] = max(row['iteration'] for row in rows) <= 8 and all(state['workerSelection'] == worker and state['codexCalls'] <= 2 and state['claudeCalls'] <= 2 for state in states) and summary['counts']['codexCalls'] <= 2 and summary['counts']['claudeCalls'] <= 2
        phases = summary['timings']
        checks['timing_totals:' + name] = phases['elapsedMs'] == sum(value for key, value in phases.items() if key not in ['elapsedMs', 'activeMs']) and phases['activeMs'] == phases['elapsedMs'] - sum(phases[key] for key in ['approvalWaitMs', 'informationWaitMs', 'recoveryWaitMs'])
        evaluations = [row['evaluation'] for row in rows if row.get('evaluation')]
        checks['fixed_evaluation_model:' + name] = all(evaluation['provider'] == 'typesafe' and evaluation['requestedModel'] == 'jev-1.13.0' and evaluation['servedModel'] == 'jev-1.13.0' for evaluation in evaluations)
        if receipt['loopStatus'] == 'finished':
            final = rows[-1]
            checks['approved_valid_completion:' + name] = summary['validation']['passed'] and summary['validation']['generation'] == 1 and final['proposal']['selected']['action'] == 'FINISH' and final['approval']['kind'] == 'approve'
aggregate = json.loads((root / 'aggregate.json').read_text())
checks['twelve_scheduled_observations'] = len(aggregate['runs']) == 12
checks['three_observations_per_setup'] = all(group['n'] == 3 for group in aggregate['aggregates'])
checks['all_six_contexts_and_arguments_match'] = all(all(pair[key] for key in ['fullContextMatches', 'originalWorkerArgumentsMatch', 'instrumentedWorkerArgumentsMatch']) for pair in aggregate['evidenceMatches'])
result = {'passed': all(checks.values()), 'checks': checks}
(root / 'audit.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'passed': result['passed'], 'checks': len(checks), 'failed': [name for name, passed in checks.items() if not passed]}, indent=2))
raise SystemExit(0 if result['passed'] else 1)
