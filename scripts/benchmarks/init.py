"""Initialize an external, credential-free manifest for the fixed comparison."""
from pathlib import Path
import datetime
import json
import subprocess
import sys

source = Path(__file__).resolve().parents[2]
root = Path(sys.argv[1]).resolve()
assert root != source and source not in root.parents, 'Use an external output directory.'
assert json.loads((source / 'package.json').read_text())['version'] == '0.2.0', 'This protocol measures the v0.2 package.'
root.mkdir(parents=True)
version = lambda command: subprocess.check_output(command, text=True).strip()
manifest = {
    'trackingIssue': 31,
    'task': 'https://github.com/TrusTrove/TrusTrove-app/issues/949',
    'targetHead': '6cae96e13e950a9e932130ef1a7aebbcddf9c58e',
    'sourceHead': version(['git', '-C', str(source), 'rev-parse', 'HEAD']),
    'sourceCheckout': str(source),
    'preservedCheckouts': [],
    'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'nodeVersion': version(['node', '--version']),
    'codexVersion': version(['codex', '--version']),
    'claudeVersion': version(['claude', '--version']),
    'requestedModels': {'codex': 'gpt-5.6-terra', 'claude': 'sonnet', 'evaluation': 'jev-1.13.0'},
    'efforts': {'codex': 'high', 'claude': 'medium'},
    'maxIterations': 8, 'maxCallsPerAdapter': 2,
    'workerTimeoutMs': 900000, 'validationTimeoutMs': 120000,
    'attemptProtocol': 'One implementation attempt per scheduled observation; failed samples retained without replacement; controlled repair not exercised.',
    'repetitions': 3,
    'runOrder': [
        'codex-jev-1', 'codex-standalone-1', 'claude-standalone-1', 'claude-jev-1',
        'codex-standalone-2', 'codex-jev-2', 'claude-jev-2', 'claude-standalone-2',
        'codex-jev-3', 'codex-standalone-3', 'claude-standalone-3', 'claude-jev-3',
    ],
}
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(root)
