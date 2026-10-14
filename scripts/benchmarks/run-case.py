"""Run one prepared case. JEV inputs are forwarded individually from the operator."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import re
import select
import signal
import subprocess
import sys
import time

root = Path(sys.argv[1]).resolve()
name = sys.argv[2]
manifest = json.loads((root / 'manifest.json').read_text())
assert name in manifest['runOrder']
case = root / name
assert not (case / 'timings.json').exists(), 'A benchmark observation cannot be overwritten.'
repo = case / 'repo'
worker, kind, repetition = name.split('-')
entry = manifest['packageEntry']
environment = {**os.environ, 'PATH': str(case / 'bin') + os.pathsep + os.environ['PATH'], 'BENCH_CASE_DIR': str(case), 'BENCH_PACKAGE_ENTRY': entry, 'NEXT_TELEMETRY_DISABLED': '1'}
for command, executable in manifest['realExecutables'].items(): environment['BENCH_REAL_' + command.upper()] = executable
for command, expected in [('codex', manifest['codexVersion']), ('claude', manifest['claudeVersion'])]:
    actual = subprocess.check_output([manifest['realExecutables'][command], '--version'], text=True).strip()
    assert actual == expected, f'{command} version drift: {actual}'
if kind == 'jev':
    launcher = '''import { pathToFileURL } from 'node:url';
process.env.JEV_PROVIDER = 'typesafe';
process.env.ROUTER_MODEL = 'jev-1.13.0';
const entry = ENTRY;
process.argv = [process.execPath, entry, '.', TASK, '--orchestrate', '--worker', WORKER, ...NETWORK];
await import(pathToFileURL(entry).href);
'''.replace('ENTRY', json.dumps(entry)).replace('TASK', json.dumps(manifest['task'])).replace('WORKER', json.dumps(worker)).replace('NETWORK', json.dumps(['--codex-network'] if worker == 'codex' else []))
    (case / 'launch.mjs').write_text(launcher)
    command = ['node', '--env-file=' + str(Path(manifest['sourceCheckout']) / '.env'), str(case / 'launch.mjs')]
else:
    command = ['node', str(root / 'harness/direct-worker.mjs'), entry, str(case), worker, manifest['task']]
(case / 'invocation.json').write_text(json.dumps({'command': command, 'cwd': str(repo), 'worker': worker, 'kind': kind, 'repetition': int(repetition), 'provider': 'typesafe' if kind == 'jev' else None, 'evaluationModel': 'jev-1.13.0' if kind == 'jev' else None, 'instrumentation': 'identical structured-output proxy', 'workerTimeoutMs': 900000}, indent=2) + '\n')

def stamps():
    return {name: hashlib.sha256((repo / name).read_bytes()).hexdigest() if (repo / name).is_file() else None for name in ['apps/web/lib/format.ts', 'apps/web/lib/format.test.ts']}

baseline = stamps()
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
clock = time.monotonic()
process = subprocess.Popen(command, cwd=repo, env=environment, stdin=subprocess.PIPE if kind == 'jev' else subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
approvals = []
worker_approval_ms = None
first_edit_ms = None
candidate = None
pending_input = b''
display = ''
timed_out = False
interrupted = False
output_limit = False
stopping_at = None

def elapsed_ms(): return round((time.monotonic() - clock) * 1000)

def stop():
    global stopping_at
    if stopping_at is not None: return
    stopping_at = time.monotonic()
    try:
        if kind == 'jev': process.send_signal(signal.SIGTERM)
        else: os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError: pass

def interrupt(_signal, _frame):
    global interrupted
    interrupted = True
    stop()

signal.signal(signal.SIGINT, interrupt)
signal.signal(signal.SIGTERM, interrupt)
count = 0
with (case / 'terminal.txt').open('xb') as log:
    streams = [process.stdout]
    stdin_open = kind == 'jev'
    while streams:
        now = time.monotonic()
        if now - clock > (1800 if kind == 'jev' else 930) and not timed_out:
            timed_out = True
            stop()
        if stopping_at is not None and now - stopping_at > 3:
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
        if first_edit_ms is None and stamps() != baseline:
            first_edit_ms = elapsed_ms()
            print('\n' + json.dumps({'event': 'first_file_change', 'elapsedMs': first_edit_ms}), flush=True)
        watched = streams + ([sys.stdin] if stdin_open else [])
        ready, _, _ = select.select(watched, [], [], 0.05)
        for stream in ready:
            if stream is sys.stdin:
                chunk = os.read(sys.stdin.fileno(), 4096)
                if not chunk:
                    stdin_open = False
                    process.stdin.close()
                    continue
                pending_input += chunk
                while b'\n' in pending_input:
                    line, pending_input = pending_input.split(b'\n', 1)
                    choice = line.decode().strip()
                    approvals.append({'elapsedMs': elapsed_ms(), 'choice': choice, 'candidate': candidate})
                    if choice == 'approve' and candidate in ['CALL_CODEX', 'CALL_CLAUDE']: worker_approval_ms = elapsed_ms()
                process.stdin.write(chunk)
                process.stdin.flush()
                continue
            chunk = os.read(stream.fileno(), 65536)
            if not chunk:
                streams.remove(stream)
                continue
            count += len(chunk)
            log.write(chunk[:max(0, 8 * 1024 * 1024 - (count - len(chunk)))])
            log.flush()
            if count > 8 * 1024 * 1024:
                output_limit = True
                stop()
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
            display = (display + chunk.decode(errors='replace'))[-100000:]
            matches = re.findall(r'^Safe candidate: ([A-Z_]+)', display, re.MULTILINE)
            if matches: candidate = matches[-1]
code = process.wait()
run = {'kind': kind, 'worker': worker, 'startedAt': started, 'endedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'exitCode': code, 'durationMs': elapsed_ms(), 'timedOut': timed_out, 'interrupted': interrupted, 'outputLimitExceeded': output_limit, 'firstFileChangeMsSinceRunStart': first_edit_ms, 'workerApprovalMsSinceRunStart': worker_approval_ms, 'firstFileChangeMsAfterWorkerApproval': first_edit_ms - worker_approval_ms if first_edit_ms is not None and worker_approval_ms is not None else None, 'pollResolutionMs': 50}
(case / 'timings.json').write_text(json.dumps({'run': run, 'operatorInputs': approvals}, indent=2) + '\n')
print('\n' + json.dumps(run), flush=True)
raise SystemExit(code if code else int(timed_out or interrupted or output_limit))
