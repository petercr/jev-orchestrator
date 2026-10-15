#!/usr/bin/env node
// Benchmark instrumentation only. Both paired runs use the same proxy.
import { spawn } from 'node:child_process';
import { closeSync, openSync, writeSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [command, ...originalArgs] = process.argv.slice(2);
if (!['codex', 'claude', 'pnpm'].includes(command)) throw new Error('Unknown benchmark command.');
const directory = process.env.BENCH_CASE_DIR;
const entry = process.env.BENCH_PACKAGE_ENTRY;
const executable = process.env[`BENCH_REAL_${command.toUpperCase()}`];
if (!directory || !entry || !executable) throw new Error('Missing benchmark configuration.');
const { redactSensitiveText } = await import(pathToFileURL(path.join(path.dirname(entry), 'logging/trace.js')));
const prefix = path.join(directory, `${command}-${process.pid}`);
const args = [...originalArgs];
if (command === 'codex') args.splice(args.indexOf('--'), 0, '--json');
if (command === 'claude') {
  args[args.indexOf('--output-format') + 1] = 'stream-json';
  args[args.indexOf('--model') + 1] = 'claude-sonnet-5-5';
  args.splice(args.indexOf('--'), 0, '--verbose');
}
const startedAt = performance.now();
const metadata = {
  command, originalArgs, args, cwd: process.cwd(),
  startedAt: new Date().toISOString(), instrumentation: 'structured output; identical in both setups',
};
const save = () => writeFileSync(`${prefix}.json`, redactSensitiveText(JSON.stringify(metadata, null, 2)) + '\n', { mode: 0o600 });
save();
const stdoutFile = openSync(`${prefix}.${command === 'pnpm' ? 'stdout.log' : 'events.jsonl'}`, 'wx', 0o600);
const stderrFile = openSync(`${prefix}.stderr.log`, 'wx', 0o600);
const environment = { ...process.env };
// Evaluation credentials are never needed by the worker or validation process.
for (const name of ['AI_GATEWAY_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTE_API_KEY', 'TYPESAFE_API_KEY', 'TYPESAFE_AI_API_KEY', 'CLOUDFLARE_AUTH_TOKEN']) delete environment[name];
const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], env: environment });
let pending = '';
let stdoutBytes = 0;
let stderrBytes = 0;
let outputLimitExceeded = false;
let completed = command === 'pnpm';
const servedModels = new Set();
const maximumBytes = 8 * 1024 * 1024;
function log(file, text, stream) {
  const safe = redactSensitiveText(text);
  const bytes = Buffer.byteLength(safe);
  if (stream === 'stdout') stdoutBytes += bytes;
  else stderrBytes += bytes;
  if (stdoutBytes > maximumBytes || stderrBytes > maximumBytes) {
    outputLimitExceeded = true;
    child.kill('SIGTERM');
    return;
  }
  writeSync(file, safe);
}
function usage(value) {
  if (!value || typeof value !== 'object') return undefined;
  const names = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
  return Object.fromEntries(names.filter((name) => Number.isFinite(value[name]) && value[name] >= 0).map((name) => [name, value[name]]));
}
function eventLine(line) {
  log(stdoutFile, line + '\n', 'stdout');
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (command === 'codex') {
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      process.stdout.write(redactSensitiveText(event.item.text) + '\n');
    }
    if (event.type === 'turn.completed') {
      completed = true;
      metadata.usage = usage(event.usage);
    }
    if (event.type === 'turn.failed' || event.type === 'error') metadata.reportedFailure = true;
  } else {
    if (typeof event.message?.model === 'string') servedModels.add(event.message.model);
    if (event.type === 'result') {
      completed = !event.is_error;
      metadata.reportedFailure = event.is_error === true;
      metadata.usage = usage(event.usage);
      metadata.turns = event.num_turns;
      if (Number.isFinite(event.total_cost_usd) && event.total_cost_usd >= 0) metadata.reportedCostUsd = event.total_cost_usd;
      if (typeof event.result === 'string') process.stdout.write(redactSensitiveText(event.result) + '\n');
    }
  }
}
child.stdout.on('data', (chunk) => {
  if (command === 'pnpm') {
    log(stdoutFile, chunk.toString(), 'stdout');
    process.stdout.write(chunk);
    return;
  }
  pending += chunk.toString();
  while (pending.includes('\n')) {
    const end = pending.indexOf('\n');
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    if (line.trim()) eventLine(line);
  }
  if (Buffer.byteLength(pending) > maximumBytes) {
    outputLimitExceeded = true;
    child.kill('SIGTERM');
  }
});
child.stderr.on('data', (chunk) => {
  log(stderrFile, chunk.toString(), 'stderr');
  process.stderr.write(redactSensitiveText(chunk.toString()));
});
child.on('error', () => {
  metadata.spawnFailed = true;
  process.stderr.write('Benchmark child could not start.\n');
});
child.on('close', (exitCode, signal) => {
  if (pending.trim()) eventLine(pending);
  Object.assign(metadata, {
    exitCode, signal, durationMs: Math.round(performance.now() - startedAt),
    endedAt: new Date().toISOString(), completed, outputLimitExceeded,
    stdoutBytes, stderrBytes, servedModels: [...servedModels],
  });
  save();
  closeSync(stdoutFile);
  closeSync(stderrFile);
  process.exitCode = outputLimitExceeded || !completed ? 1 : (exitCode ?? 1);
});
