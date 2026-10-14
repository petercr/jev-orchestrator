// Audit fixed configuration and preservation; never execute a recorded command.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { commandOutput, externalRoot, fileHash, isFile, isMain, loadManifest, readJson, readTraceRows, requireCondition, sha256, writeJson } from './lib.mjs';

export function auditCase(name, receipt, rows) {
  const [worker, kind] = name.split('-');
  const process = receipt.workerProcesses[0];
  const args = process?.args ?? [];
  const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const checks = { ['one_worker_attempt:' + name]: receipt.workerProcesses.length === 1 };
  if (worker === 'codex') {
    checks['codex_permissions_and_model:' + name] = value('--model') === 'gpt-5.6-terra' && value('--sandbox') === 'workspace-write' && value('--ask-for-approval') === 'never' && args.includes('sandbox_workspace_write.network_access=true') && args.includes('--ignore-user-config') && args.includes('--ignore-rules');
  } else {
    checks['claude_permissions_and_model:' + name] = value('--model') === 'claude-sonnet-5-5' && args.includes('--restricted') && args.includes('--strict-mcp-config') && value('--setting-sources') === '' && value('--tools') === 'Read,Write,Edit,Glob,Grep' && value('--allowedTools') === 'mcp__jev_files__rename_file' && process?.servedModels?.length === 1 && process.servedModels[0] === 'claude-sonnet-5-5';
  }
  checks['no_full_access_fallback:' + name] = !args.some((argument) => ['danger-full-access', '--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox'].includes(argument));
  checks['target_scope_preserved:' + name] = ['target_head_preserved', 'target_index_has_no_staged_edits', 'only_task_files_changed', 'reverse_patch_check_passed'].every((key) => receipt.checks[key] === true);
  if (kind === 'jev') {
    const summary = receipt.cliSummary;
    const states = rows.flatMap((row) => [row.stateBefore, row.stateAfter]).filter((state) => state && !state.truncated);
    checks['selection_and_limits:' + name] = rows.length > 0 && Math.max(...rows.map((row) => row.iteration)) <= 8 && states.every((state) => state.workerSelection === worker && state.codexCalls <= 2 && state.claudeCalls <= 2) && summary.counts.codexCalls <= 2 && summary.counts.claudeCalls <= 2;
    const phases = summary.timings;
    const waits = phases.approvalWaitMs + phases.informationWaitMs + phases.recoveryWaitMs;
    checks['timing_totals:' + name] = phases.elapsedMs === Object.entries(phases).filter(([key]) => !['elapsedMs', 'activeMs'].includes(key)).reduce((sum, [, value]) => sum + value, 0) && phases.activeMs === phases.elapsedMs - waits;
    checks['fixed_evaluation_model:' + name] = rows.filter((row) => row.evaluation).every(({ evaluation }) => evaluation.provider === 'typesafe' && evaluation.requestedModel === 'jev-1.13.0' && evaluation.servedModel === 'jev-1.13.0');
    if (receipt.loopStatus === 'finished') {
      const final = rows.at(-1);
      checks['approved_valid_completion:' + name] = summary.validation.passed === true && summary.validation.generation === 1 && final?.proposal?.selected?.action === 'FINISH' && final?.approval?.kind === 'approve';
    }
  }
  return checks;
}

export function buildAudit(root, manifest, aggregate, { recordedSource = false } = {}) {
  const before = readJson(path.join(root, 'original-before.json'));
  const checks = {};
  for (const [repo, initial] of Object.entries(before)) {
    const source = repo === manifest.sourceCheckout;
    if (source && recordedSource) requireCondition(/^[a-f0-9]{40}$/.test(initial.head), 'Invalid recorded source revision.');
    const changed = Object.entries(initial.files).filter(([name, expected]) => {
      if (source && recordedSource) {
        // The source checkout may advance after the study. Verify its immutable
        // Git revision explicitly; never pretend its current checkout is unchanged.
        return sha256(commandOutput(['git', 'show', `${initial.head}:${name}`], repo, { encoding: 'buffer' })) !== expected;
      }
      return !isFile(path.join(repo, name)) || fileHash(path.join(repo, name)) !== expected;
    }).map(([name]) => name);
    checks['preserved_tracked_files:' + repo] = changed.every((name) => source && ['PLAN.md', 'README.md'].includes(name));
    checks['preserved_head:' + repo] = commandOutput(['git', 'rev-parse', source && recordedSource ? initial.head : 'HEAD'], repo).trim() === initial.head;
    if (!source) checks['preserved_worktree_status:' + repo] = commandOutput(['git', 'status', '--porcelain'], repo) === initial.status;
  }
  for (const name of manifest.runOrder) {
    const receipt = readJson(path.join(root, name, 'receipt.json'));
    Object.assign(checks, auditCase(name, receipt, name.includes('-jev-') ? readTraceRows(path.join(root, name, 'repo')) : []));
  }
  checks.twelve_scheduled_observations = aggregate.runs.length === 12;
  checks.three_observations_per_setup = aggregate.aggregates.length === 4 && aggregate.aggregates.every((group) => group.n === 3);
  checks.all_six_contexts_and_arguments_match = aggregate.evidenceMatches.length === 6 && aggregate.evidenceMatches.every((pair) => ['fullContextMatches', 'originalWorkerArgumentsMatch', 'instrumentedWorkerArgumentsMatch'].every((key) => pair[key] === true));
  return { passed: Object.values(checks).every((passed) => passed === true), checks, ...(recordedSource ? { sourceVerification: 'recorded_git_revision' } : {}) };
}

export function audit(directory, { outputDirectory, recordedSource = false } = {}) {
  const { root, manifest } = loadManifest(directory);
  const output = outputDirectory ? externalRoot(outputDirectory, manifest.sourceCheckout) : root;
  mkdirSync(output, { recursive: true });
  const result = buildAudit(root, manifest, readJson(path.join(output, 'aggregate.json')), { recordedSource });
  writeJson(path.join(output, 'audit.json'), result);
  return { passed: result.passed, checks: Object.keys(result.checks).length, failed: Object.entries(result.checks).filter(([, passed]) => !passed).map(([name]) => name) };
}

if (isMain(import.meta.url)) {
  const [directory, ...args] = process.argv.slice(2);
  let outputDirectory;
  let recordedSource = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--recorded-source') recordedSource = true;
    else if (flag === '--output' && args.length) outputDirectory = args.shift();
    else throw new Error('Usage: node audit.mjs EVIDENCE [--output OUTPUT] [--recorded-source]');
  }
  const result = audit(directory, { outputDirectory, recordedSource });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
}
