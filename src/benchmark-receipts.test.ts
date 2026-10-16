import { execFile, spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const scripts = path.resolve('scripts/benchmarks');
const load = (name: string) => import(pathToFileURL(path.join(scripts, name)).href);
const helpers = await load('report-helpers.mjs');
const reporting = await load('report.mjs');
const auditing = await load('audit.mjs');
const verifying = await load('verify-case.mjs');
const library = await load('lib.mjs');
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'jev-benchmark-receipts-'));
  directories.push(directory);
  return directory;
}

const rootChecks = ['test', 'typecheck', 'lint', 'build'].map((script) => ({ script, exitCode: 0, timedOut: false, durationMs: 10 }));
const context = { issue: { url: 'https://github.com/example/repo/issues/1' }, findings: [{ iteration: 2, source: 'read', paths: ['AGENTS.md'], excerpt: 'Instructions' }] };

function receiptFixture(worker = 'codex') {
  const args = worker === 'codex'
    ? ['--model', 'gpt-5.6-terra', '--sandbox', 'workspace-write', '--ask-for-approval', 'never', '-c', 'sandbox_workspace_write.network_access=true', '--ignore-user-config', '--ignore-rules']
    : ['--model', 'claude-sonnet-5-5', '--restricted', '--strict-mcp-config', '--setting-sources', '', '--tools', 'Read,Write,Edit,Glob,Grep', '--allowedTools', 'mcp__jev_files__rename_file'];
  return {
    acceptedPatch: true,
    rootChecks,
    checks: { target_head_preserved: true, target_index_has_no_staged_edits: true, only_task_files_changed: true, reverse_patch_check_passed: true },
    cliSummary: {
      timings: { elapsedMs: 100, activeMs: 80, workerMs: 20, evaluationMs: 5, preparationMs: 15, validationMs: 40, approvalWaitMs: 10, informationWaitMs: 5, recoveryWaitMs: 5 },
      counts: { codexCalls: worker === 'codex' ? 1 : 0, claudeCalls: worker === 'claude' ? 1 : 0, workerCalls: 1, adapterRetries: 0 },
      validation: { passed: true, generation: 1 },
    },
    loopStatus: 'finished',
    independentVerification: { supplementalRootChecks: [] as { script: string; durationMs: number }[] },
    workerProcesses: [{ args, originalArgs: args, completed: true, exitCode: 0, outputLimitExceeded: false, servedModels: worker === 'claude' ? ['claude-sonnet-5-5'] : [] }],
    patchSha256: 'fixture-hash',
    fullWorkspaceTests: 805,
  };
}

function traceFixture(worker = 'codex') {
  const state = { workerSelection: worker, codexCalls: worker === 'codex' ? 1 : 0, claudeCalls: worker === 'claude' ? 1 : 0 };
  return [{ iteration: 8, stateBefore: state, stateAfter: state, toolResult: { action: 'CALL_' + worker.toUpperCase() }, toolInput: { context }, evaluation: { provider: 'typesafe', requestedModel: 'jev-1.13.0', servedModel: 'jev-1.13.0' }, proposal: { selected: { action: 'FINISH' } }, approval: { kind: 'approve' } }];
}

function acceptanceFixture() {
  return {
    initial: { head: 'baseline' }, currentHead: 'baseline', stagedEdits: false,
    changedPaths: ['apps/web/lib/format.ts', 'apps/web/lib/format.test.ts'], untrackedPaths: ['apps/web/lib/format.test.ts'], reversePatchPassed: true,
    verification: {
      formatTests: { exitCode: 0, counts: { numTotalTests: 5, numFailedTests: 0, numPendingTests: 0 } },
      baselineRegression: { exitCode: 1, counts: { numFailedTests: 3, numPassedTests: 2 } },
      acceptanceProbe: { exitCode: 0, timedOut: false, results: { passed: true, results: Array.from({ length: 15 }, () => ({ passed: true })) } },
    },
    rootChecks, testCounts: [88, 640, 12, 65], workerProcesses: receiptFixture().workerProcesses,
    rows: [] as unknown[],
  };
}

describe('benchmark receipt parsing and classification', () => {
  it('retains failed, pending, and passing test counts', () => {
    expect(helpers.parseTestSummaries(' Tests 88 passed (88)\n Tests 1 failed | 641 passed | 2 skipped | 3 todo (647)\n')).toEqual([{ passed: 88 }, { failed: 1, passed: 641, skipped: 2, todo: 3 }]);
  });

  it('reads probe JSON alongside Node warnings and fails closed without it', () => {
    expect(helpers.parseAcceptance('{"fixtureLength":56,"passed":true}\n(node:1) Warning: module type\n').passed).toBe(true);
    expect(helpers.parseAcceptance('Warning only\n')).toEqual({ passed: false });
    expect(() => helpers.parseAcceptance('{"fixtureLength":broken}\n')).toThrow();
  });

  it.each([
    [{ ok: false, cancelled: true }, [], 'cancelled'],
    [{ ok: false, timedOut: true }, [], 'timed_out'],
    [{ ok: false }, [], 'worker_failed'],
    [{ ok: true }, [{ exitCode: -15, timedOut: true }], 'validation_timed_out'],
    [{ ok: true }, [{ exitCode: 1, timedOut: false }], 'validation_failed'],
    [{ ok: true }, rootChecks, 'ready_for_review'],
  ])('classifies a direct observation from its independent checks', (worker, checks, expected) => {
    expect(helpers.directStatus(worker, { acceptedPatch: true, rootChecks: checks })).toBe(expected);
  });

  it('retains iteration exhaustion and distinguishes failed acceptance', () => {
    expect(helpers.comparisonOutcome('iteration_limit', [{ exitCode: 1, timedOut: true }])).toBe('iteration_limit');
    expect(helpers.comparisonOutcome('stopped', [{ exitCode: 1, timedOut: false }])).toBe('validation_failed');
    expect(helpers.directStatus({ ok: true }, { acceptedPatch: false, rootChecks })).toBe('acceptance_failed');
    expect(helpers.directStatus({ ok: true }, { acceptedPatch: true, rootChecks: [{ exitCode: 0, outputLimitExceeded: true }] })).toBe('validation_failed');
  });

  it('preserves sample counts, sample deviation, and absent values', () => {
    expect(helpers.timingStatistics([10, 20, 60])).toEqual({ n: 3, mean: 30, median: 20, min: 10, max: 60, sampleStandardDeviation: Math.sqrt(700) });
    expect(helpers.timingStatistics([])).toEqual({ n: 0, mean: null, median: null, min: null, max: null, sampleStandardDeviation: null });
    expect(helpers.timingStatistics([5]).sampleStandardDeviation).toBeNull();
    expect(() => helpers.timingStatistics([Number.NaN])).toThrow();
  });
});

describe('benchmark reporting', () => {
  it('keeps supplemental checks outside CLI metrics and operator waits', () => {
    const receipt = receiptFixture();
    receipt.loopStatus = 'iteration_limit';
    receipt.independentVerification.supplementalRootChecks = [{ script: 'build', durationMs: 100 }];
    const result = reporting.aggregateRun('codex-jev-1', receipt, { run: { exitCode: 1 } }, null);
    expect(result).toMatchObject({ acceptedPatch: true, workflowSuccess: false, outcome: 'iteration_limit', activeMs: 180, cliActiveMs: 80, validationMs: 140, supplementalValidationMs: 100, promptWaitMs: 20 });
    expect(receipt.cliSummary.timings.activeMs).toBe(80);
    expect(result.reportedUsage).toEqual([null]);
    expect(result.reportedCostsUsd).toEqual([]);
  });

  it('includes failed attempts while counting successful workflows separately', () => {
    const first = reporting.aggregateRun('codex-standalone-1', receiptFixture(), { run: { exitCode: 0 } }, { ok: true, durationMs: 20, preparationMs: 5, activeBeforeValidationMs: 25 });
    const failedReceipt = { ...receiptFixture(), acceptedPatch: false, rootChecks: [{ script: 'test', exitCode: 1, timedOut: false, durationMs: 10 }] };
    const second = reporting.aggregateRun('codex-standalone-2', failedReceipt, { run: { exitCode: 0 } }, { ok: true, durationMs: 2, preparationMs: 5, activeBeforeValidationMs: 7 });
    const group = reporting.aggregateGroups([first, second]).find((group: { worker: string; kind: string }) => group.worker === 'codex' && group.kind === 'standalone');
    expect(group).toMatchObject({ n: 2, acceptedPatches: 1, successfulWorkflows: 1, metrics: { workerMs: { n: 2, mean: 11 } }, successfulWorkflowMetrics: { workerMs: { n: 1, mean: 20 } } });
  });

  it('rebuilds all scheduled receipts without executing recorded commands or changing inputs', async () => {
    const directory = await temporaryDirectory();
    const runOrder = ['codex', 'claude'].flatMap((worker) => ['jev', 'standalone'].flatMap((kind) => [1, 2, 3].map((repetition) => `${worker}-${kind}-${repetition}`)));
    const manifest = { sourceCheckout: process.cwd(), runOrder };
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    const before: string[] = [];
    for (const name of runOrder) {
      const worker = name.startsWith('codex-') ? 'codex' : 'claude';
      const caseDirectory = path.join(directory, name);
      await mkdir(path.join(caseDirectory, 'repo/traces'), { recursive: true });
      const receipt = JSON.stringify(receiptFixture(worker));
      before.push(receipt);
      await writeFile(path.join(caseDirectory, 'receipt.json'), receipt);
      await writeFile(path.join(caseDirectory, 'timings.json'), JSON.stringify({ run: { exitCode: 0 } }));
      // Untrusted recorded commands are data; the report must never launch them.
      await writeFile(path.join(caseDirectory, 'invocation.json'), JSON.stringify({ command: ['does-not-exist'] }));
      await writeFile(path.join(caseDirectory, 'repo/traces/fixture.jsonl'), JSON.stringify(traceFixture(worker)[0]) + '\n');
      await writeFile(path.join(caseDirectory, 'direct-request.json'), JSON.stringify({ context }));
      await writeFile(path.join(caseDirectory, 'direct-result.json'), JSON.stringify({ ok: true, durationMs: 20, preparationMs: 5, activeBeforeValidationMs: 25 }));
    }
    const output = path.join(directory, 'rebuilt');
    const result = await run(process.execPath, [path.join(scripts, 'report.mjs'), directory, '--output', output]);
    expect(JSON.parse(result.stdout)).toEqual({ observations: 12, acceptedPatches: 12, successfulWorkflows: 12, matchedEvidencePairs: 6 });
    const aggregate = JSON.parse(await readFile(path.join(output, 'aggregate.json'), 'utf8'));
    expect(aggregate.aggregates).toHaveLength(4);
    expect(aggregate.evidenceMatches.every((pair: Record<string, unknown>) => pair.fullContextMatches && pair.originalWorkerArgumentsMatch && pair.instrumentedWorkerArgumentsMatch)).toBe(true);
    for (const [index, name] of runOrder.entries()) expect(await readFile(path.join(directory, name, 'receipt.json'), 'utf8')).toBe(before[index]);
  });
});

describe('benchmark acceptance and configuration audit', () => {
  it('accepts only independently checked, scoped patches with regression evidence', () => {
    expect(Object.values(verifying.acceptanceChecks(acceptanceFixture())).every(Boolean)).toBe(true);
    expect(verifying.acceptanceChecks({ ...acceptanceFixture(), rootChecks: rootChecks.slice(0, 3) }).all_four_independent_root_checks_pass).toBe(false);
    expect(verifying.acceptanceChecks({ ...acceptanceFixture(), changedPaths: [...acceptanceFixture().changedPaths, 'package.json'] }).only_task_files_changed).toBe(false);
    expect(verifying.acceptanceChecks({ ...acceptanceFixture(), reversePatchPassed: false }).reverse_patch_check_passed).toBe(false);
  });

  it('rejects timed out checks and stale validation even when worker output passes', () => {
    expect(verifying.acceptanceChecks({ ...acceptanceFixture(), rootChecks: rootChecks.map((check) => ({ ...check, timedOut: check.script === 'build' })) }).all_four_independent_root_checks_pass).toBe(false);
    const rows = [{ iteration: 8, summary: { ...receiptFixture().cliSummary, validation: { passed: false, generation: 2 } } }];
    expect(verifying.acceptanceChecks({ ...acceptanceFixture(), rows }).fresh_current_generation_validation).toBe(false);
  });

  it.each(['codex', 'claude'])('audits the pinned %s permissions and excludes unsafe fallbacks', (worker) => {
    const name = `${worker}-jev-1`;
    const receipt = receiptFixture(worker);
    expect(Object.values(auditing.auditCase(name, receipt, traceFixture(worker))).every(Boolean)).toBe(true);
    receipt.workerProcesses[0]!.args.push('--dangerously-skip-permissions');
    expect(auditing.auditCase(name, receipt, traceFixture(worker))['no_full_access_fallback:' + name]).toBe(false);
    receipt.workerProcesses[0]!.args = ['--model'];
    expect(auditing.auditCase(name, receipt, traceFixture(worker))[worker + '_permissions_and_model:' + name]).toBe(false);
  });

  it('requires original worker selection, call limits, and completion approval', () => {
    const name = 'codex-jev-1';
    const receipt = receiptFixture();
    const rows = traceFixture();
    rows[0]!.stateAfter.workerSelection = 'claude';
    rows[0]!.stateAfter.codexCalls = 3;
    rows[0]!.approval.kind = 'stop';
    const result = auditing.auditCase(name, receipt, rows);
    expect(result['selection_and_limits:' + name]).toBe(false);
    expect(result['approved_valid_completion:' + name]).toBe(false);
    expect(auditing.auditCase(name, { ...receipt, workerProcesses: [] }, rows)['one_worker_attempt:' + name]).toBe(false);
  });
});

describe('benchmark I/O and command boundaries', () => {
  it('refuses output inside the source checkout, including symlinked ancestors', async () => {
    const directory = await temporaryDirectory();
    await symlink(process.cwd(), path.join(directory, 'source'), 'dir');
    expect(() => library.externalRoot(path.join(directory, 'source/new-output'), process.cwd())).toThrow('external output');
    expect(() => library.externalRoot(process.cwd(), process.cwd())).toThrow('external output');
    expect(library.externalRoot(path.join(directory, 'external'), process.cwd())).toBe(path.join(directory, 'external'));
  });

  it('bounds inputs and refuses to overwrite a command log', async () => {
    const directory = await temporaryDirectory();
    const large = path.join(directory, 'large.json');
    await writeFile(large, ' '.repeat(library.maximumBytes + 1));
    expect(() => library.readJson(large)).toThrow('8 MiB');
    const log = path.join(directory, 'command.log');
    const result = await library.runLogged([process.execPath, '-e', 'console.log("receipt"); process.exitCode=7;'], directory, log);
    expect(result).toMatchObject({ exitCode: 7, timedOut: false });
    expect(await readFile(log, 'utf8')).toBe('receipt\n');
    await expect(library.runLogged([process.execPath, '-e', 'process.exit(0);'], directory, log)).rejects.toThrow('EEXIST');
  });

  it('records spawn failure and cancellation without starting post-abort work', async () => {
    const directory = await temporaryDirectory();
    const failed = await library.runLogged([path.join(directory, 'missing-executable')], directory, path.join(directory, 'failed.log'));
    expect(failed).toMatchObject({ exitCode: 1, spawnFailed: true });
    const controller = new AbortController();
    const pending = library.runLogged([process.execPath, '-e', 'setInterval(()=>{},1000);'], directory, path.join(directory, 'cancelled.log'), { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ cancelled: true, timedOut: false });
    await expect(library.runLogged([process.execPath, '-e', 'process.exit(0);'], directory, path.join(directory, 'post-abort.log'), { signal: controller.signal })).rejects.toThrow('interrupted');
  });

  it('records fixed deadline expiry separately from cancellation', async () => {
    const directory = await temporaryDirectory();
    const result = await library.runLogged([process.execPath, '-e', 'setInterval(()=>{},1000);'], directory, path.join(directory, 'timeout.log'), { timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBeUndefined();
    expect(result.exitCode).not.toBe(0);
  });

  it.skipIf(process.platform === 'win32')('kills a resistant descendant after its parent closes its pipes', async () => {
    const directory = await temporaryDirectory();
    const ready = path.join(directory, 'descendant.pid');
    const descendant = `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid)); setInterval(()=>{},1000);`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}); setInterval(()=>{},1000);`;
    const controller = new AbortController();
    const running = library.runLogged([process.execPath, '-e', parent], directory, path.join(directory, 'group.log'), { signal: controller.signal });
    let pid = 0;
    try {
      await expect.poll(async () => {
        try { pid = Number(await readFile(ready, 'utf8')); return pid > 0; }
        catch { return false; }
      }, { interval: 10, timeout: 2_000 }).toBe(true);
      controller.abort();
      expect(await running).toMatchObject({ cancelled: true, timedOut: false });
      await expect.poll(async () => {
        try { process.kill(pid, 0); }
        catch { return true; }
        if (process.platform !== 'linux') return false;
        try { return /State:\s+Z/u.test(await readFile(`/proc/${pid}/status`, 'utf8')); }
        catch { return true; }
      }, { interval: 10, timeout: 2_000 }).toBe(true);
    } finally {
      controller.abort();
      await running;
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped. */ } }
    }
  });

  it('removes process signal listeners after an interrupted execution scope', async () => {
    const before = ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal));
    await expect(library.withInterrupt(async () => { throw new Error('fixture failure'); })).rejects.toThrow('fixture failure');
    expect(['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal))).toEqual(before);
  });

  it('prepares fresh external clones and baseline receipts using fake command boundaries', async () => {
    const directory = await temporaryDirectory();
    const bin = path.join(directory, 'bin');
    const seed = path.join(directory, 'seed');
    const output = path.join(directory, 'output');
    // The historical protocol measures v0.2 independently of the current release.
    const source = path.join(directory, 'v02-source');
    const frozenScripts = path.join(source, 'scripts/benchmarks');
    await mkdir(path.dirname(frozenScripts), { recursive: true });
    await cp(scripts, frozenScripts, { recursive: true });
    await writeFile(path.join(source, 'package.json'), '{"version":"0.2.0"}');
    await writeFile(path.join(source, '.gitignore'), 'node_modules/\n');
    await symlink(path.resolve('node_modules'), path.join(source, 'node_modules'), 'dir');
    await run('git', ['init', '--quiet', source]);
    await run('git', ['add', '.'], { cwd: source });
    await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture'], { cwd: source });
    await mkdir(bin);
    await mkdir(path.join(seed, 'apps/web/lib'), { recursive: true });
    await writeFile(path.join(seed, 'package.json'), '{"name":"benchmark-fixture"}');
    await writeFile(path.join(seed, '.gitignore'), 'node_modules/\n');
    await writeFile(path.join(seed, 'apps/web/lib/format.ts'), 'export function truncateAddress(text: string) { return text.slice(0,6)+"..."+text.slice(-4); }');
    await run('git', ['init', '--quiet', seed]);
    await run('git', ['add', '.'], { cwd: seed });
    await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture'], { cwd: seed });
    await mkdir(path.join(seed, 'node_modules'));
    await writeFile(path.join(seed, 'node_modules/prepared.txt'), 'Independent dependencies');
    const executable = `#!/usr/bin/env node
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
if (process.argv.includes('--version')) console.log('fixture 1.0');
else if (!process.argv[1].endsWith('pnpm')) process.exitCode=9;
else if (process.argv[2] === 'add') {
  const actual = path.join(process.cwd(), 'node_modules/.pnpm/fixture-package');
  mkdirSync(path.join(actual, 'dist'), { recursive: true });
  writeFileSync(path.join(actual, 'package.json'), '{"type":"module"}');
  writeFileSync(path.join(actual, 'dist/cli.js'), 'import {fileURLToPath} from "node:url"; if (fileURLToPath(import.meta.url) === process.argv[1]) console.log("Fixture entry executed");');
  symlinkSync('.pnpm/fixture-package', path.join(process.cwd(), 'node_modules/jev-orchestrator'), 'dir');
}
`;
    for (const name of ['codex', 'claude', 'pnpm']) await writeFile(path.join(bin, name), executable, { mode: 0o700 });
    const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
    await run(process.execPath, [path.join(frozenScripts, 'init.mjs'), output], { env });
    const manifestPath = path.join(output, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.targetHead = (await run('git', ['rev-parse', 'HEAD'], { cwd: seed })).stdout.trim();
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(path.join(output, 'jev-orchestrator-0.2.0.tgz'), 'fixture archive');
    await run(process.execPath, [path.join(frozenScripts, 'prepare.mjs'), output, seed], { env });
    expect(await readFile(path.join(output, 'codex-jev-1/repo/node_modules/prepared.txt'), 'utf8')).toBe('Independent dependencies');
    const prepared = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
    expect(prepared.harnessHashes['prepare.mjs']).toBeTruthy();
    expect(prepared.packageEntry).toBe(path.join(output, 'consumer/node_modules/.pnpm/fixture-package/dist/cli.js'));
    const launched = await run(process.execPath, ['--input-type=module', '-e', 'const entry=process.argv[1]; process.argv=[process.execPath,entry]; await import((await import("node:url")).pathToFileURL(entry));', prepared.packageEntry]);
    expect(launched.stdout).toBe('Fixture entry executed\n');
    await run(process.execPath, [path.join(frozenScripts, 'baseline.mjs'), output], { env });
    expect(JSON.parse(await readFile(path.join(output, 'baseline-bug.json'), 'utf8')).shortLengthsFailing).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(JSON.parse(await readFile(path.join(output, 'baseline-validation.json'), 'utf8'))).toHaveLength(4);
    expect((await run('git', ['status', '--porcelain'], { cwd: seed })).stdout).toBe('');
    await expect(run(process.execPath, [path.join(frozenScripts, 'prepare.mjs'), output, seed], { env })).rejects.toThrow();
  }, 15_000);
});

async function caseRunnerFixture(program: string) {
  const directory = await temporaryDirectory();
  const source = path.join(directory, 'source');
  const output = path.join(directory, 'evidence');
  const caseDirectory = path.join(output, 'codex-jev-1');
  await mkdir(path.join(source, 'logging'), { recursive: true });
  await mkdir(path.join(caseDirectory, 'repo'), { recursive: true });
  await mkdir(path.join(caseDirectory, 'bin'));
  await writeFile(path.join(source, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(source, '.env'), '');
  await writeFile(path.join(source, 'cli.js'), program);
  await writeFile(path.join(source, 'logging/trace.js'), 'export const redactSensitiveText=(text)=>text.replaceAll("fixture-secret","[REDACTED]");');
  const executable = path.join(source, 'fake-worker.mjs');
  await writeFile(executable, '#!/usr/bin/env node\nif(process.argv.includes("--version"))console.log("fixture 1.0");else process.exitCode=9;\n', { mode: 0o700 });
  const runOrder = ['codex', 'claude'].flatMap((worker) => ['jev', 'standalone'].flatMap((kind) => [1, 2, 3].map((repetition) => `${worker}-${kind}-${repetition}`)));
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ sourceCheckout: source, runOrder, packageEntry: path.join(source, 'cli.js'), task: 'fixture task', codexVersion: 'fixture 1.0', claudeVersion: 'fixture 1.0', realExecutables: { codex: executable, claude: executable } }));
  return { output, caseDirectory };
}

describe('benchmark interactive execution', () => {
  it('forwards the operator response and refuses a second observation', async () => {
    const { output, caseDirectory } = await caseRunnerFixture('console.log("Safe candidate: CALL_CODEX"); process.stdin.once("data", (chunk)=>{ console.log("Operator sent "+chunk.toString().trim()+" fixture-secret"); console.log("Loop status: finished"); process.stdin.pause(); });');
    const child = spawn(process.execPath, [path.join(scripts, 'run-case.mjs'), output, 'codex-jev-1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let approved = false;
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      if (!approved && text.includes('Safe candidate: CALL_CODEX')) {
        approved = true;
        child.stdin.end('approve\n');
      }
    });
    expect(await new Promise((resolve) => child.once('close', resolve))).toBe(0);
    const timings = JSON.parse(await readFile(path.join(caseDirectory, 'timings.json'), 'utf8'));
    expect(timings.operatorInputs).toEqual([{ elapsedMs: expect.any(Number), choice: 'approve', candidate: 'CALL_CODEX' }]);
    expect(timings.run).toMatchObject({ timedOut: false, interrupted: false, workerApprovalMsSinceRunStart: expect.any(Number) });
    expect(await readFile(path.join(caseDirectory, 'terminal.txt'), 'utf8')).toContain('Operator sent approve [REDACTED]');
    const before = await readFile(path.join(caseDirectory, 'timings.json'), 'utf8');
    await expect(run(process.execPath, [path.join(scripts, 'run-case.mjs'), output, 'codex-jev-1'])).rejects.toThrow('cannot be overwritten or retried');
    expect(await readFile(path.join(caseDirectory, 'timings.json'), 'utf8')).toBe(before);
  });

  it('preserves interrupted prompt evidence without recording an approval', async () => {
    const { output, caseDirectory } = await caseRunnerFixture('console.log("Safe candidate: READ_FILE"); setInterval(()=>{},1000);');
    const child = spawn(process.execPath, [path.join(scripts, 'run-case.mjs'), output, 'codex-jev-1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.once('data', () => child.kill('SIGTERM'));
    expect(await new Promise((resolve) => child.once('close', resolve))).not.toBe(0);
    const timings = JSON.parse(await readFile(path.join(caseDirectory, 'timings.json'), 'utf8'));
    expect(timings.run).toMatchObject({ interrupted: true, timedOut: false });
    expect(timings.operatorInputs).toEqual([]);
    expect(await readFile(path.join(caseDirectory, 'terminal.txt'), 'utf8')).toContain('Safe candidate: READ_FILE');
  });
});
