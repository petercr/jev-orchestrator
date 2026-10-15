// Shared bounded I/O and fixed-command execution for the opt-in benchmark.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const maximumBytes = 8 * 1024 * 1024;
export const rootScripts = ['test', 'typecheck', 'lint', 'build'];
const credentialNames = ['AI_GATEWAY_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTE_API_KEY', 'TYPESAFE_API_KEY', 'TYPESAFE_AI_API_KEY', 'CLOUDFLARE_AUTH_TOKEN'];

export function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export function readText(file) {
  requireCondition(statSync(file).size <= maximumBytes, `Input exceeds 8 MiB: ${file}`);
  return readFileSync(file, 'utf8');
}

export const readJson = (file) => JSON.parse(readText(file));
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const fileHash = (file) => sha256(readFileSync(file));
export const isFile = (file) => existsSync(file) && statSync(file).isFile();
export const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
export const isMain = (url) => Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === url;

export function externalRoot(directory, source) {
  requireCondition(directory, 'An external output directory is required.');
  const root = path.resolve(directory);
  // Resolve existing ancestors too, so a symlink cannot place output in source.
  let ancestor = root;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const resolved = path.resolve(realpathSync(ancestor), path.relative(ancestor, root));
  const selectedSource = realpathSync(source);
  const relative = path.relative(selectedSource, resolved);
  requireCondition(relative !== '' && (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)), 'Use an external output directory.');
  return resolved;
}

export function loadManifest(directory) {
  requireCondition(directory, 'An evidence directory is required.');
  const root = realpathSync(path.resolve(directory));
  const manifest = readJson(path.join(root, 'manifest.json'));
  externalRoot(root, manifest.sourceCheckout);
  requireCondition(Array.isArray(manifest.runOrder) && manifest.runOrder.length === 12 && new Set(manifest.runOrder).size === 12, 'Expected twelve unique scheduled observations.');
  requireCondition(manifest.runOrder.every((name) => /^(codex|claude)-(jev|standalone)-[1-3]$/.test(name)), 'Invalid scheduled case.');
  return { root, manifest };
}

export function selectCase(root, manifest, name) {
  requireCondition(manifest.runOrder.includes(name), 'Select a case in the frozen run order.');
  const [worker, kind, repetition] = name.split('-');
  const directory = path.join(root, name);
  return { directory, repo: path.join(directory, 'repo'), worker, kind, repetition: Number(repetition) };
}

export function commandOutput(command, cwd, options = {}) {
  const result = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8', timeout: 300_000, maxBuffer: maximumBytes, ...options });
  if (result.error) throw result.error;
  requireCondition(result.status === 0, `Command failed: ${command[0]} ${command[1] ?? ''}`);
  return result.stdout;
}

export function fingerprint(repo) {
  const files = commandOutput(['git', 'ls-files', '-z'], repo).split('\0').filter((name) => name && isFile(path.join(repo, name)));
  return {
    head: commandOutput(['git', 'rev-parse', 'HEAD'], repo).trim(),
    status: commandOutput(['git', 'status', '--porcelain'], repo),
    index: fileHash(path.resolve(repo, commandOutput(['git', 'rev-parse', '--git-path', 'index'], repo).trim())),
    files: Object.fromEntries(files.map((name) => [name, fileHash(path.join(repo, name))])),
  };
}

export function validationEnvironment(manifest, directory) {
  const environment = { ...process.env, PATH: path.join(directory, 'bin') + path.delimiter + process.env.PATH, BENCH_CASE_DIR: directory, BENCH_PACKAGE_ENTRY: manifest.packageEntry, NEXT_TELEMETRY_DISABLED: '1' };
  for (const [command, executable] of Object.entries(manifest.realExecutables)) environment['BENCH_REAL_' + command.toUpperCase()] = executable;
  for (const name of credentialNames) delete environment[name];
  return environment;
}

export async function withInterrupt(run) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, interrupt);
  try { return await run(controller.signal); }
  finally { for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, interrupt); }
}

export function redact(text, environment = process.env) {
  for (const name of credentialNames) {
    if (environment[name]) text = text.replaceAll(environment[name], '[REDACTED]');
  }
  return text;
}

export function stopProcess(child, signal = 'SIGTERM') {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else if (child.pid) process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export async function runLogged(command, cwd, log, { environment = process.env, timeoutMs = 120_000, signal } = {}) {
  requireCondition(!signal?.aborted, 'Execution interrupted before command start.');
  const started = performance.now();
  const file = openSync(log, 'wx', 0o600);
  const child = spawn(command[0], command.slice(1), { cwd, env: environment, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let timedOut = false;
  let cancelled = false;
  let outputLimitExceeded = false;
  let bytes = 0;
  let killTimer;
  let spawnFailed = false;
  const stop = () => {
    if (killTimer) return;
    stopProcess(child);
    // Kill the entire group even if the parent exits before its descendants.
    killTimer = setTimeout(() => stopProcess(child, 'SIGKILL'), 3_000);
  };
  const abort = () => { cancelled = true; stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
    const safe = Buffer.from(redact(redact(chunk.toString(), environment)));
    const available = Math.max(0, maximumBytes - bytes);
    writeSync(file, safe.subarray(0, available));
    bytes += safe.length;
    if (bytes > maximumBytes) { outputLimitExceeded = true; stop(); }
  });
  child.on('error', () => { spawnFailed = true; });
  const [code, exitSignal] = await new Promise((resolve) => child.once('close', (...result) => resolve(result)));
  clearTimeout(timer);
  signal?.removeEventListener('abort', abort);
  if (killTimer) {
    stopProcess(child, 'SIGKILL');
    clearTimeout(killTimer);
  }
  closeSync(file);
  const signalNumber = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }[exitSignal];
  return { command, exitCode: spawnFailed ? 1 : code ?? (signalNumber ? -signalNumber : 1), timedOut, durationMs: Math.round(performance.now() - started), log: path.basename(log), ...(cancelled ? { cancelled } : {}), ...(outputLimitExceeded ? { outputLimitExceeded } : {}), ...(spawnFailed ? { spawnFailed } : {}) };
}

export function readTraceRows(repo) {
  // Sort traces consistently without loading directory contents recursively.
  const directory = path.join(repo, 'traces');
  if (!existsSync(directory)) return [];
  return traceFiles(directory).flatMap((file) => readText(file).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)));
}

export const traceFiles = (directory) => readdirSync(directory).filter((file) => file.endsWith('.jsonl')).sort().map((file) => path.join(directory, file));
