"""Verify one common pristine baseline, outside every worker observation."""
from pathlib import Path
import json
import os
import signal
import subprocess
import sys
import time

root = Path(sys.argv[1]).resolve()
manifest = json.loads((root / 'manifest.json').read_text())
seed = root / manifest['runOrder'][0] / 'repo'
repo = root / 'baseline'
subprocess.run(['git', 'clone', '--quiet', '--no-hardlinks', str(seed), str(repo)], check=True)
packages = subprocess.check_output(['git', 'ls-files', '-z'], cwd=repo).decode().split('\0')
module_paths = ['node_modules'] + [str(Path(name).parent / 'node_modules') for name in packages if name.endswith('package.json')]
for relative in set(module_paths):
    if (seed / relative).is_dir(): subprocess.run(['cp', '-a', '--reflink=auto', str(seed / relative), str(repo / relative)], check=True)
environment = {**os.environ, 'NEXT_TELEMETRY_DISABLED': '1'}
checks = []
for script in ['typecheck', 'build', 'lint', 'test']:
    clock = time.monotonic()
    timed_out = False
    with (root / ('baseline-' + script + '.log')).open('w') as log:
        child = subprocess.Popen(['pnpm', 'run', script], cwd=repo, env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try: code = child.wait(timeout=120)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(child.pid, signal.SIGTERM)
            try: code = child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                code = child.wait()
    result = {'script': script, 'command': ['pnpm', 'run', script], 'exitCode': code, 'timedOut': timed_out, 'durationMs': round((time.monotonic() - clock) * 1000)}
    checks.append(result)
    (root / 'baseline-validation.json').write_text(json.dumps(checks, indent=2) + '\n')
    print(json.dumps(result), flush=True)
probe = '''import {pathToFileURL} from 'node:url';
const {truncateAddress}=await import(pathToFileURL(process.argv[1]));
const failures=Array.from({length:10},(_,i)=>'ABCDEFGHIJ'.slice(0,i+1)).filter(text=>truncateAddress(text)!==text).map(text=>text.length);
console.log(JSON.stringify({shortLengthsFailing:failures}));
process.exitCode=failures.length===10?0:1;
'''
result = subprocess.run(['node', '--input-type=module', '-e', probe, str(repo / 'apps/web/lib/format.ts')], cwd=repo, capture_output=True, text=True)
(root / 'baseline-bug.json').write_text(result.stdout)
print(result.stdout, flush=True)
assert result.returncode == 0 and all(check['exitCode'] == 0 and not check['timedOut'] for check in checks)
