// Run one prepared case. Forward each JEV input from the operator unchanged.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileHash, isFile, isMain, loadManifest, maximumBytes, commandOutput, requireCondition, selectCase, stopProcess, validationEnvironment, writeJson } from './lib.mjs';

export async function runCase(directory, name) {
  const { root, manifest } = loadManifest(directory);
  const selected = selectCase(root, manifest, name);
  const { directory: caseDirectory, repo, worker, kind, repetition } = selected;
  requireCondition(['timings.json', 'terminal.txt', 'invocation.json'].every((file) => !existsSync(path.join(caseDirectory, file))), 'A benchmark observation cannot be overwritten or retried.');
  const entry = manifest.packageEntry;
  const { redactSensitiveText } = await import(pathToFileURL(path.join(path.dirname(entry), 'logging/trace.js')));
  const environment = validationEnvironment(manifest, caseDirectory);
  for (const command of ['codex', 'claude']) {
    const actual = commandOutput([manifest.realExecutables[command], '--version'], repo).trim();
    requireCondition(actual === manifest[command + 'Version'], `${command} version drift: ${actual}`);
  }
  let command;
  if (kind === 'jev') {
    const launcher = `import { pathToFileURL } from 'node:url';
process.env.JEV_PROVIDER = 'typesafe';
process.env.ROUTER_MODEL = 'jev-1.13.0';
const entry = ${JSON.stringify(entry)};
process.argv = [process.execPath, entry, '.', ${JSON.stringify(manifest.task)}, '--orchestrate', '--worker', ${JSON.stringify(worker)}, ...${JSON.stringify(worker === 'codex' ? ['--codex-network'] : [])}];
await import(pathToFileURL(entry).href);
`;
    writeFileSync(path.join(caseDirectory, 'launch.mjs'), launcher);
    command = [process.execPath, '--env-file=' + path.join(manifest.sourceCheckout, '.env'), path.join(caseDirectory, 'launch.mjs')];
  } else {
    command = [process.execPath, path.join(root, 'harness/direct-worker.mjs'), entry, caseDirectory, worker, manifest.task];
  }
  writeJson(path.join(caseDirectory, 'invocation.json'), {
    command, cwd: repo, worker, kind, repetition,
    provider: kind === 'jev' ? 'typesafe' : null, evaluationModel: kind === 'jev' ? 'jev-1.13.0' : null,
    instrumentation: 'identical structured-output proxy', workerTimeoutMs: 900_000,
  });
  const stamps = () => ['apps/web/lib/format.ts', 'apps/web/lib/format.test.ts'].map((name) => isFile(path.join(repo, name)) ? fileHash(path.join(repo, name)) : null).join(':');
  const baseline = stamps();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const log = openSync(path.join(caseDirectory, 'terminal.txt'), 'wx', 0o600);
  const child = spawn(command[0], command.slice(1), { cwd: repo, env: environment, detached: process.platform !== 'win32', stdio: [kind === 'jev' ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  const operatorInputs = [];
  let workerApprovalMs = null;
  let firstEditMs = null;
  let candidate = null;
  let pendingInput = '';
  let display = '';
  let timedOut = false;
  let interrupted = false;
  let outputLimitExceeded = false;
  let spawnFailed = false;
  let killTimer;
  let bytes = 0;
  const stop = () => {
    if (killTimer) return;
    if (kind === 'jev') child.kill('SIGTERM'); // Let the CLI drain its approved process.
    else stopProcess(child);
    killTimer = setTimeout(() => stopProcess(child, 'SIGKILL'), 3_000);
  };
  const interrupt = () => { interrupted = true; stop(); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, interrupt);
  const timer = setTimeout(() => { timedOut = true; stop(); }, kind === 'jev' ? 1_800_000 : 930_000);
  const poll = setInterval(() => {
    if (firstEditMs === null && stamps() !== baseline) {
      firstEditMs = elapsed();
      console.log('\n' + JSON.stringify({ event: 'first_file_change', elapsedMs: firstEditMs }));
    }
  }, 50);
  const onInput = (chunk) => {
    pendingInput += chunk.toString();
    if (Buffer.byteLength(pendingInput) > maximumBytes) { outputLimitExceeded = true; stop(); return; }
    while (pendingInput.includes('\n')) {
      const end = pendingInput.indexOf('\n');
      const choice = pendingInput.slice(0, end).trim();
      pendingInput = pendingInput.slice(end + 1);
      operatorInputs.push({ elapsedMs: elapsed(), choice: redactSensitiveText(choice), candidate });
      if (choice === 'approve' && ['CALL_CODEX', 'CALL_CLAUDE'].includes(candidate)) workerApprovalMs = elapsed();
    }
    if (!child.stdin.destroyed) child.stdin.write(chunk);
  };
  const onEnd = () => child.stdin.end();
  if (kind === 'jev') {
    child.stdin.on('error', () => {}); // A stopped prompt can close its input pipe.
    process.stdin.on('data', onInput);
    process.stdin.once('end', onEnd);
  }
  // Reuse package redaction; never write raw provider output or credentials.
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
    const safe = redactSensitiveText(chunk.toString());
    const buffer = Buffer.from(safe);
    writeSync(log, buffer.subarray(0, Math.max(0, maximumBytes - bytes)));
    bytes += buffer.length;
    if (bytes > maximumBytes) { outputLimitExceeded = true; stop(); }
    process.stdout.write(safe);
    display = (display + safe).slice(-100_000);
    const matches = [...display.matchAll(/^Safe candidate: ([A-Z_]+)/gm)];
    if (matches.length) candidate = matches.at(-1)[1];
  });
  child.on('error', () => { spawnFailed = true; });
  const [code, exitSignal] = await new Promise((resolve) => child.once('close', (...result) => resolve(result)));
  clearTimeout(timer);
  clearInterval(poll);
  if (killTimer) { stopProcess(child, 'SIGKILL'); clearTimeout(killTimer); }
  for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, interrupt);
  if (kind === 'jev') {
    process.stdin.removeListener('data', onInput);
    process.stdin.removeListener('end', onEnd);
    process.stdin.pause();
  }
  closeSync(log);
  const signalNumber = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }[exitSignal];
  const exitCode = spawnFailed ? 1 : code ?? (signalNumber ? -signalNumber : 1);
  const run = {
    kind, worker, startedAt, endedAt: new Date().toISOString(), exitCode, durationMs: elapsed(), timedOut, interrupted, outputLimitExceeded,
    firstFileChangeMsSinceRunStart: firstEditMs, workerApprovalMsSinceRunStart: workerApprovalMs,
    firstFileChangeMsAfterWorkerApproval: firstEditMs !== null && workerApprovalMs !== null ? firstEditMs - workerApprovalMs : null,
    pollResolutionMs: 50, ...(spawnFailed ? { spawnFailed } : {}),
  };
  writeJson(path.join(caseDirectory, 'timings.json'), { run, operatorInputs });
  console.log('\n' + JSON.stringify(run));
  return exitCode || Number(timedOut || interrupted || outputLimitExceeded);
}

if (isMain(import.meta.url)) process.exitCode = Math.abs(await runCase(...process.argv.slice(2)));
