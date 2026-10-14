"""Prepare the fixed issue-31 protocol outside the timed runs; never launches a worker."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

root = Path(sys.argv[1]).resolve()
dependency_seed = Path(sys.argv[2]).resolve()
manifest = json.loads((root / 'manifest.json').read_text())
source = Path(manifest['sourceCheckout'])
assert root != source and source not in root.parents
scripts = Path(__file__).resolve().parent

def run(command, cwd, log):
    started = time.monotonic()
    with log.open('w') as output:
        result = subprocess.run(command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT, timeout=300)
    receipt = {'command': command, 'cwd': str(cwd), 'exitCode': result.returncode, 'durationMs': round((time.monotonic() - started) * 1000), 'log': str(log)}
    if result.returncode:
        raise RuntimeError(f'Setup failed; inspect {log}')
    return receipt

def fingerprint(repo):
    files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=repo).decode().split('\0')
    return {
        'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip(),
        'status': subprocess.check_output(['git', 'status', '--porcelain'], cwd=repo, text=True),
        'index': hashlib.sha256((repo / '.git/index').read_bytes()).hexdigest(),
        'files': {name: hashlib.sha256((repo / name).read_bytes()).hexdigest() for name in files if name and (repo / name).is_file()},
    }

consumer = root / 'consumer'
consumer.mkdir(exist_ok=True)
(consumer / 'package.json').write_text('{"private":true,"name":"issue31-consumer","version":"1.0.0"}\n')
try:
    run(['pnpm', 'add', '--offline', '--ignore-scripts', str(root / 'jev-orchestrator-0.2.0.tgz')], consumer, root / 'consumer-offline-install.log')
except RuntimeError:
    run(['pnpm', 'add', '--ignore-scripts', str(root / 'jev-orchestrator-0.2.0.tgz')], consumer, root / 'consumer-install.log')
manifest['packageEntry'] = str((consumer / 'node_modules/jev-orchestrator/dist/cli.js').resolve())
manifest['packageSha256'] = hashlib.sha256((root / 'jev-orchestrator-0.2.0.tgz').read_bytes()).hexdigest()
manifest['realExecutables'] = {name: shutil.which(name) for name in ['codex', 'claude', 'pnpm']}
manifest['claudeActualRequestedModel'] = 'claude-sonnet-5-5'
manifest['setupSeed'] = str(dependency_seed)
protected = [source, dependency_seed, *[Path(repo).resolve() for repo in manifest.get('preservedCheckouts', [])]]
(root / 'original-before.json').write_text(json.dumps({str(repo): fingerprint(repo) for repo in protected}, indent=2) + '\n')
snapshot = root / 'harness'
snapshot.mkdir()
for script in scripts.iterdir():
    if script.is_file(): shutil.copyfile(script, snapshot / script.name)
manifest['harnessHashes'] = {script.name: hashlib.sha256(script.read_bytes()).hexdigest() for script in snapshot.iterdir() if script.is_file()}
setup = []
for name in manifest['runOrder']:
    case = root / name
    case.mkdir()
    repo = case / 'repo'
    setup.append(run(['git', 'clone', '--no-hardlinks', '--quiet', str(dependency_seed), str(repo)], root, case / 'clone.log'))
    setup.append(run(['git', 'checkout', '--quiet', '--detach', manifest['targetHead']], repo, case / 'checkout.log'))
    subprocess.run(['git', 'remote', 'set-url', 'origin', 'https://github.com/TrusTrove/TrusTrove-app.git'], cwd=repo, check=True)
    with (repo / '.git/info/exclude').open('a') as exclude:
        exclude.write('\ntraces/\n**/.next/\n**/*.tsbuildinfo\n')
    module_paths = ['node_modules'] + [str(path.parent.relative_to(repo) / 'node_modules') for path in repo.glob('**/package.json') if '.git' not in path.parts]
    for relative in module_paths:
        if (dependency_seed / relative).is_dir() and not (repo / relative).exists():
            subprocess.run(['cp', '-a', '--reflink=auto', str(dependency_seed / relative), str(repo / relative)], check=True)
    setup.append(run(['pnpm', 'install', '--offline', '--frozen-lockfile'], repo, case / 'dependency-setup.log'))
    initial = fingerprint(repo)
    assert initial['head'] == manifest['targetHead'] and initial['status'] == ''
    (case / 'target-before.json').write_text(json.dumps(initial, indent=2) + '\n')
    wrappers = case / 'bin'
    wrappers.mkdir()
    for command in ['codex', 'claude', 'pnpm']:
        wrapper = wrappers / command
        wrapper.write_text('#!/usr/bin/env node\nprocess.argv.splice(2, 0, ' + json.dumps(command) + ');\nawait import(' + json.dumps((snapshot / 'worker-proxy.mjs').as_uri()) + ');\n')
        wrapper.chmod(0o700)
    print(json.dumps({'prepared': name, 'pnpmVersion': subprocess.check_output(['pnpm', '--version'], cwd=repo, text=True).strip()}), flush=True)
(root / 'dependency-setup.json').write_text(json.dumps(setup, indent=2) + '\n')
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
