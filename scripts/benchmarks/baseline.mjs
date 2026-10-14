// Verify one common pristine baseline, outside every worker observation.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { commandOutput, isMain, loadManifest, maximumBytes, requireCondition, runLogged, validationEnvironment, withInterrupt, writeJson } from './lib.mjs';

export async function baseline(directory, { signal } = {}) {
  const { root, manifest } = loadManifest(directory);
  const seed = path.join(root, manifest.runOrder[0], 'repo');
  const repo = path.join(root, 'baseline');
  commandOutput(['git', 'clone', '--quiet', '--no-hardlinks', seed, repo], root);
  const packages = commandOutput(['git', 'ls-files', '-z'], repo).split('\0');
  const modulePaths = new Set(['node_modules', ...packages.filter((name) => name.endsWith('package.json')).map((name) => path.join(path.dirname(name), 'node_modules'))]);
  for (const relative of modulePaths) if (existsSync(path.join(seed, relative))) cpSync(path.join(seed, relative), path.join(repo, relative), { recursive: true, verbatimSymlinks: true });
  const environment = validationEnvironment(manifest, root);
  const checks = [];
  for (const script of ['typecheck', 'build', 'lint', 'test']) {
    const result = { script, ...await runLogged(['pnpm', 'run', script], repo, path.join(root, 'baseline-' + script + '.log'), { environment, signal }) };
    checks.push(result);
    writeJson(path.join(root, 'baseline-validation.json'), checks);
    console.log(JSON.stringify(result));
    requireCondition(!result.cancelled, 'Baseline validation was interrupted.');
  }
  // tsx is part of the pinned source toolchain; Node 22 need not strip types natively.
  const probe = `import {pathToFileURL} from 'node:url';
const {truncateAddress}=await import(pathToFileURL(process.argv[1]));
const failures=Array.from({length:10},(_,i)=>'ABCDEFGHIJ'.slice(0,i+1)).filter(text=>truncateAddress(text)!==text).map(text=>text.length);
console.log(JSON.stringify({shortLengthsFailing:failures}));
process.exitCode=failures.length===10?0:1;`;
  const result = spawnSync(process.execPath, ['--import', path.join(manifest.sourceCheckout, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', probe, path.join(repo, 'apps/web/lib/format.ts')], { cwd: repo, env: environment, encoding: 'utf8', timeout: 120_000, maxBuffer: maximumBytes });
  writeFileSync(path.join(root, 'baseline-bug.json'), result.stdout ?? '');
  writeJson(path.join(root, 'baseline-probe.json'), { exitCode: result.status, signal: result.signal, timedOut: result.error?.code === 'ETIMEDOUT' });
  console.log((result.stdout ?? '').trim());
  requireCondition(result.status === 0 && !result.error, 'Baseline defect probe failed; inspect baseline-bug.json.');
  requireCondition(checks.every((check) => check.exitCode === 0 && !check.timedOut && !check.outputLimitExceeded), 'A baseline check failed.');
}

if (isMain(import.meta.url)) await withInterrupt((signal) => baseline(process.argv[2], { signal }));
