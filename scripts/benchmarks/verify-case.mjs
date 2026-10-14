// Independent acceptance/patch receipts; root checks run outside the worker.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { commandOutput, fileHash, isFile, isMain, loadManifest, maximumBytes, readJson, readText, readTraceRows, requireCondition, rootScripts, runLogged, selectCase, sha256, validationEnvironment, withInterrupt, writeJson } from './lib.mjs';
import { parseAcceptance, parseTestSummaries } from './report-helpers.mjs';

export function acceptanceChecks({ initial, currentHead, stagedEdits, changedPaths, untrackedPaths, reversePatchPassed, verification, rootChecks, testCounts, workerProcesses, rows }) {
  const unit = verification.formatTests?.counts ?? {};
  const regression = verification.baselineRegression?.counts ?? {};
  const probe = verification.acceptanceProbe;
  const expectedPaths = ['apps/web/lib/format.test.ts', 'apps/web/lib/format.ts'];
  const uninterrupted = (result) => result && !result.timedOut && !result.cancelled && !result.outputLimitExceeded && !result.spawnFailed;
  const checks = {
    target_head_preserved: currentHead === initial.head,
    target_index_has_no_staged_edits: !stagedEdits,
    only_task_files_changed: JSON.stringify([...changedPaths].sort()) === JSON.stringify(expectedPaths) && untrackedPaths.length === 1 && untrackedPaths[0] === 'apps/web/lib/format.test.ts',
    reverse_patch_check_passed: reversePatchPassed,
    all_fifteen_acceptance_cases_pass: probe?.exitCode === 0 && uninterrupted(probe) && probe.results?.passed === true && probe.results.results?.length === 15,
    new_formatter_tests_pass: unit.numTotalTests > 0 && unit.numFailedTests === 0 && unit.numPendingTests === 0 && verification.formatTests?.exitCode === 0 && uninterrupted(verification.formatTests),
    new_tests_detect_original_bug: regression.numFailedTests > 0 && regression.numPassedTests > 0 && verification.baselineRegression?.exitCode === 1 && uninterrupted(verification.baselineRegression),
    all_four_independent_root_checks_pass: rootScripts.every((script) => rootChecks.some((check) => check.script === script && check.exitCode === 0 && uninterrupted(check))) && rootChecks.every((check) => check.exitCode === 0 && uninterrupted(check)),
    full_workspace_test_log_recorded: testCounts.length === 4 && testCounts.reduce((sum, count) => sum + count, 0) > 800,
    one_successful_worker_process: workerProcesses.length === 1 && workerProcesses[0].completed === true && workerProcesses[0].exitCode === 0 && !workerProcesses[0].outputLimitExceeded,
  };
  const summary = rows.at(-1)?.summary;
  if (rows.length && summary) {
    checks.iteration_and_call_limits_preserved = Math.max(...rows.map((row) => row.iteration)) <= 8 && summary.counts.codexCalls <= 2 && summary.counts.claudeCalls <= 2;
    checks.fresh_current_generation_validation = summary.validation.passed === true && summary.validation.generation >= 1;
  }
  return checks;
}

function testCounts(file) {
  if (!isFile(file)) return {};
  const data = readJson(file);
  return Object.fromEntries(['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests'].map((key) => [key, data[key]]));
}

export async function verifyCase(directory, name, flags = [], { signal } = {}) {
  requireCondition(flags.every((flag) => ['--validate', '--validate-remaining'].includes(flag)) && new Set(flags).size === flags.length && flags.length <= 1, 'Use --validate or --validate-remaining.');
  const { root, manifest } = loadManifest(directory);
  const { directory: caseDirectory, repo, worker, kind } = selectCase(root, manifest, name);
  requireCondition(!flags.includes('--validate') || kind === 'standalone', 'Direct root checks require a standalone case.');
  requireCondition(!flags.includes('--validate-remaining') || (kind === 'jev' && existsSync(path.join(caseDirectory, 'timings.json'))), 'Supplemental checks require an already terminated JEV loop.');
  const environment = validationEnvironment(manifest, caseDirectory);
  const verificationPath = path.join(caseDirectory, 'verification.json');
  const run = async (label, command, cwd = repo) => {
    const result = await runLogged(command, cwd, path.join(caseDirectory, label + '.log'), { environment, signal });
    console.log(JSON.stringify({ case: name, check: label, ...result }));
    return result;
  };
  let verification;
  if (!existsSync(verificationPath)) {
    verification = { independentRootChecks: [], supplementalRootChecks: [] };
    // Reserve before execution; interruption must not permit another attempt.
    writeJson(verificationPath, verification);
    if (flags.includes('--validate') || flags.includes('--validate-remaining')) {
      const supplemental = kind === 'jev';
      const attempted = new Set(readTraceRows(repo).filter((row) => row.toolResult?.action === 'RUN_TESTS').map((row) => row.toolInput.script));
      for (const script of rootScripts) {
        if (supplemental && attempted.has(script)) continue;
        const result = { ...await run((supplemental ? 'supplemental-' : 'independent-') + script, ['pnpm', 'run', script]), script, ...(supplemental ? { includedInCliMetrics: false } : {}) };
        verification[supplemental ? 'supplementalRootChecks' : 'independentRootChecks'].push(result);
        writeJson(verificationPath, verification);
      }
    }
    const test = path.join(repo, 'apps/web/lib/format.test.ts');
    if (isFile(test)) {
      const report = path.join(caseDirectory, 'format-tests.json');
      verification.formatTests = { ...await run('format-tests', ['pnpm', '--filter', 'web', 'exec', 'vitest', 'run', 'lib/format.test.ts', '--reporter=json', '--outputFile=' + report]), counts: testCounts(report) };
      writeJson(verificationPath, verification);
      const regression = path.join(caseDirectory, 'regression-web');
      mkdirSync(path.join(regression, 'lib'), { recursive: true });
      const web = path.join(repo, 'apps/web');
      for (const filename of ['vitest.config.ts', 'vitest.setup.ts', 'vitest.d.ts', 'package.json']) copyFileSync(path.join(web, filename), path.join(regression, filename));
      copyFileSync(test, path.join(regression, 'lib/format.test.ts'));
      writeFileSync(path.join(regression, 'lib/format.ts'), commandOutput(['git', 'show', 'HEAD:apps/web/lib/format.ts'], repo, { encoding: 'buffer' }));
      symlinkSync(path.join(web, 'node_modules'), path.join(regression, 'node_modules'), 'dir');
      const regressionReport = path.join(regression, 'tests.json');
      verification.baselineRegression = { ...await run('baseline-regression', ['node', path.join(web, 'node_modules/vitest/vitest.mjs'), 'run', 'lib/format.test.ts', '--reporter=json', '--outputFile=' + regressionReport], regression), counts: testCounts(regressionReport) };
      if (existsSync(regressionReport)) verification.baselineRegression.failedTitles = readJson(regressionReport).testResults.flatMap((suite) => suite.assertionResults.filter((assertion) => assertion.status === 'failed').map((assertion) => assertion.fullName));
      writeJson(verificationPath, verification);
    }
    const probe = path.join(caseDirectory, 'acceptance-probe.mjs');
    writeFileSync(probe, `import { pathToFileURL } from 'node:url';
const { truncateAddress } = await import(pathToFileURL(process.argv[2]));
const fixture = 'GACR43EX3GKZWQEHHTM6XPBSKBJLHNZPJFXZFXMFXSTF34OCDSNZHWGB';
const examples = [['empty', '', ''], ['undefined', undefined, ''], ['null', null, '']];
for (let length = 1; length <= 10; length++) { const text = 'ABCDEFGHIJ'.slice(0, length); examples.push(['length-' + length, text, text]); }
examples.push(['length-11', 'ABCDEFGHIJK', 'ABCDEF...HIJK'], ['stellar-address-56', fixture, 'GACR43...HWGB']);
const results = examples.map(([name, input, expected]) => { const actual = truncateAddress(input); return { name, expected, actual, passed: actual === expected }; });
console.log(JSON.stringify({ fixtureLength: fixture.length, passed: results.every((result) => result.passed), results }));
process.exitCode = results.every((result) => result.passed) ? 0 : 1;
`);
    verification.acceptanceProbe = await run('acceptance', [process.execPath, '--import', path.join(manifest.sourceCheckout, 'node_modules/tsx/dist/loader.mjs'), probe, path.join(repo, 'apps/web/lib/format.ts')]);
    writeJson(verificationPath, verification);
  } else verification = readJson(verificationPath);
  if (verification.acceptanceProbe) {
    try { verification.acceptanceProbe.results = parseAcceptance(readText(path.join(caseDirectory, 'acceptance.log'))); }
    catch { verification.acceptanceProbe.results = { passed: false }; }
    writeJson(verificationPath, verification);
  }
  const initial = readJson(path.join(caseDirectory, 'target-before.json'));
  const tracked = commandOutput(['git', 'ls-files', '-z'], repo).split('\0').filter((name) => name && isFile(path.join(repo, name)));
  const files = Object.fromEntries(tracked.map((name) => [name, fileHash(path.join(repo, name))]));
  const changedPaths = [...new Set([...Object.keys(files), ...Object.keys(initial.files)])].filter((name) => files[name] !== initial.files[name]);
  if (existsSync(path.join(repo, 'apps/web/lib/format.test.ts')) && !changedPaths.includes('apps/web/lib/format.test.ts')) changedPaths.push('apps/web/lib/format.test.ts');
  const status = commandOutput(['git', 'status', '--porcelain'], repo);
  const untrackedPaths = status.split('\n').filter((line) => line.startsWith('?? ')).map((line) => line.slice(3));
  let patch = commandOutput(['git', 'diff', 'HEAD', '--binary'], repo, { encoding: 'buffer' });
  if (existsSync(path.join(repo, 'apps/web/lib/format.test.ts'))) {
    const added = spawnSync('git', ['diff', '--no-index', '--binary', '--', '/dev/null', 'apps/web/lib/format.test.ts'], { cwd: repo, maxBuffer: maximumBytes });
    if (added.status === 1) patch = Buffer.concat([patch, added.stdout]);
  }
  const patchFile = path.join(caseDirectory, 'issue949.patch');
  writeFileSync(patchFile, patch);
  const reversePatchPassed = spawnSync('git', ['apply', '--reverse', '--check', patchFile], { cwd: repo, maxBuffer: maximumBytes }).status === 0;
  const rows = kind === 'jev' ? readTraceRows(repo) : [];
  const tools = rows.filter((row) => row.toolResult);
  const rootChecks = kind === 'jev'
    ? [...tools.filter((row) => row.toolResult.action === 'RUN_TESTS').map((row) => ({ script: row.toolInput.script, exitCode: row.toolResult.exitCode, timedOut: row.toolResult.timedOut, durationMs: row.toolResult.durationMs })), ...(verification.supplementalRootChecks ?? [])]
    : verification.independentRootChecks;
  const workerProcesses = readdirSync(caseDirectory).filter((file) => file.startsWith(worker + '-') && file.endsWith('.json')).sort().map((file) => readJson(path.join(caseDirectory, file)));
  const testSummaries = readdirSync(caseDirectory).filter((file) => file.startsWith('pnpm-') && file.endsWith('.json')).flatMap((file) => {
    const metadata = readJson(path.join(caseDirectory, file));
    const log = path.join(caseDirectory, file.slice(0, -5) + '.stdout.log');
    return JSON.stringify(metadata.originalArgs) === '["run","test"]' && metadata.cwd === repo && isFile(log) ? parseTestSummaries(readText(log)) : [];
  });
  const counts = testSummaries.map((summary) => Object.values(summary).reduce((sum, count) => sum + count, 0));
  const checks = acceptanceChecks({ initial, currentHead: commandOutput(['git', 'rev-parse', 'HEAD'], repo).trim(), stagedEdits: spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: repo }).status !== 0, changedPaths, untrackedPaths, reversePatchPassed, verification, rootChecks, testCounts: counts, workerProcesses, rows });
  const summary = rows.at(-1)?.summary ?? null;
  const terminal = existsSync(path.join(caseDirectory, 'terminal.txt')) ? readText(path.join(caseDirectory, 'terminal.txt')) : '';
  const loopStatus = terminal.match(/Loop status: ([a-z_]+)/)?.[1] ?? null;
  if (kind === 'jev' && summary) checks.completion_or_explicit_incomplete_status_recorded = loopStatus !== null;
  const receipt = {
    case: name, trackingIssue: 31, task: manifest.task, changedPaths: changedPaths.sort(), patchSha256: sha256(patch), checks,
    acceptedPatch: Object.values(checks).every((check) => check === true), rootChecks,
    fullWorkspaceTests: counts.reduce((sum, count) => sum + count, 0), fullTestSummaries: testSummaries, workerProcesses,
    independentVerification: verification, cliSummary: summary, loopStatus,
    actionSequence: tools.map((row) => ({ iteration: row.iteration, action: row.toolResult.action, script: row.toolInput?.script ?? null, ok: row.toolResult.ok })),
    manualAlternatives: rows.flatMap((row) => (row.approval?.history ?? []).filter((item) => item.kind === 'alternative').map((item) => item.action)),
    truncatedTraceStates: rows.flatMap((row) => ['stateBefore', 'stateAfter'].filter((field) => row[field]?.truncated === true).map((field) => ({ iteration: row.iteration, field }))),
  };
  writeJson(path.join(caseDirectory, 'receipt.json'), receipt);
  console.log(JSON.stringify({ case: name, acceptedPatch: receipt.acceptedPatch, checks, fullWorkspaceTests: receipt.fullWorkspaceTests }, null, 2));
  return receipt;
}

if (isMain(import.meta.url)) {
  const [directory, name, ...flags] = process.argv.slice(2);
  process.exitCode = (await withInterrupt((signal) => verifyCase(directory, name, flags, { signal }))).acceptedPatch ? 0 : 1;
}
