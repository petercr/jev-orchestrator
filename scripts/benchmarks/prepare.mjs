// Prepare the fixed protocol outside timed runs; never launch a worker.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commandOutput, externalRoot, fileHash, fingerprint, isMain, loadManifest, requireCondition, runLogged, withInterrupt, writeJson } from './lib.mjs';

export async function prepare(directory, dependencyDirectory, { signal } = {}) {
  const { root, manifest } = loadManifest(directory);
  requireCondition(dependencyDirectory, 'A prepared dependency seed is required.');
  const dependencySeed = path.resolve(dependencyDirectory);
  for (const repo of [dependencySeed, ...(manifest.preservedCheckouts ?? [])]) externalRoot(root, repo);
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  requireCondition(!existsSync(path.join(root, 'harness')) && manifest.runOrder.every((name) => !existsSync(path.join(root, name))), 'Preparation cannot replace an existing harness or case.');
  const setup = [];
  const run = async (command, cwd, log) => {
    const result = await runLogged(command, cwd, log, { timeoutMs: 300_000, signal });
    const receipt = { ...result, cwd, log };
    setup.push(receipt);
    writeJson(path.join(root, 'dependency-setup.json'), setup);
    requireCondition(result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded, `Setup failed; inspect ${log}`);
    return receipt;
  };
  const consumer = path.join(root, 'consumer');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(path.join(consumer, 'package.json'), '{"private":true,"name":"issue31-consumer","version":"1.0.0"}\n');
  const archive = path.join(root, 'jev-orchestrator-0.2.0.tgz');
  // Only dependency installation has an online fallback; measured observations never retry.
  const offline = await runLogged(['pnpm', 'add', '--offline', '--ignore-scripts', archive], consumer, path.join(root, 'consumer-offline-install.log'), { timeoutMs: 300_000, signal });
  setup.push({ ...offline, cwd: consumer });
  writeJson(path.join(root, 'dependency-setup.json'), setup);
  requireCondition(!offline.cancelled, 'Dependency setup was interrupted.');
  if (offline.exitCode !== 0 || offline.timedOut || offline.outputLimitExceeded) await run(['pnpm', 'add', '--ignore-scripts', archive], consumer, path.join(root, 'consumer-install.log'));
  manifest.packageEntry = realpathSync(path.join(consumer, 'node_modules/jev-orchestrator/dist/cli.js'));
  manifest.packageSha256 = fileHash(archive);
  manifest.realExecutables = Object.fromEntries(['codex', 'claude', 'pnpm'].map((name) => [name, commandOutput(['which', name], root).trim()]));
  manifest.claudeActualRequestedModel = 'claude-sonnet-5-5';
  manifest.setupSeed = dependencySeed;
  const protectedRepos = [manifest.sourceCheckout, dependencySeed, ...(manifest.preservedCheckouts ?? []).map((repo) => path.resolve(repo))];
  writeJson(path.join(root, 'original-before.json'), Object.fromEntries(protectedRepos.map((repo) => [repo, fingerprint(repo)])));
  const snapshot = path.join(root, 'harness');
  mkdirSync(snapshot);
  for (const entry of readdirSync(scripts, { withFileTypes: true })) if (entry.isFile()) copyFileSync(path.join(scripts, entry.name), path.join(snapshot, entry.name));
  manifest.harnessHashes = Object.fromEntries(readdirSync(snapshot).map((name) => [name, fileHash(path.join(snapshot, name))]));
  writeJson(path.join(root, 'manifest.json'), manifest);
  for (const name of manifest.runOrder) {
    const caseDirectory = path.join(root, name);
    mkdirSync(caseDirectory);
    const repo = path.join(caseDirectory, 'repo');
    await run(['git', 'clone', '--no-hardlinks', '--quiet', dependencySeed, repo], root, path.join(caseDirectory, 'clone.log'));
    await run(['git', 'checkout', '--quiet', '--detach', manifest.targetHead], repo, path.join(caseDirectory, 'checkout.log'));
    commandOutput(['git', 'remote', 'set-url', 'origin', 'https://github.com/TrusTrove/TrusTrove-app.git'], repo);
    appendFileSync(path.join(repo, '.git/info/exclude'), '\ntraces/\n**/.next/\n**/*.tsbuildinfo\n');
    const modulePaths = new Set(['node_modules', ...commandOutput(['git', 'ls-files', '-z'], repo).split('\0').filter((name) => name.endsWith('package.json')).map((name) => path.join(path.dirname(name), 'node_modules'))]);
    for (const relative of modulePaths) {
      if (existsSync(path.join(dependencySeed, relative)) && !existsSync(path.join(repo, relative))) cpSync(path.join(dependencySeed, relative), path.join(repo, relative), { recursive: true, verbatimSymlinks: true });
    }
    await run(['pnpm', 'install', '--offline', '--frozen-lockfile'], repo, path.join(caseDirectory, 'dependency-setup.log'));
    const initial = fingerprint(repo);
    requireCondition(initial.head === manifest.targetHead && initial.status === '', 'Prepared clone differs from the frozen baseline.');
    writeJson(path.join(caseDirectory, 'target-before.json'), initial);
    const wrappers = path.join(caseDirectory, 'bin');
    mkdirSync(wrappers);
    for (const command of ['codex', 'claude', 'pnpm']) {
      const wrapper = path.join(wrappers, command);
      writeFileSync(wrapper, '#!/usr/bin/env node\nprocess.argv.splice(2, 0, ' + JSON.stringify(command) + ');\nawait import(' + JSON.stringify(pathToFileURL(path.join(snapshot, 'worker-proxy.mjs')).href) + ');\n');
      chmodSync(wrapper, 0o700);
    }
    console.log(JSON.stringify({ prepared: name, pnpmVersion: commandOutput(['pnpm', '--version'], repo).trim() }));
  }
}

if (isMain(import.meta.url)) await withInterrupt((signal) => prepare(process.argv[2], process.argv[3], { signal }));
