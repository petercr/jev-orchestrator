import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSnapshots, ROUTES, STUDY_VERSION } from './fixtures.mjs';
import { grade, reportedUsage, schedule, summarize } from './metrics.mjs';

export const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function observation(job, snapshot, evaluate, api, signal) {
  const start = performance.now();
  let result;
  try { result = await evaluate(structuredClone(snapshot.state), { signal }); } catch (error) {
    return { ...job, outcome: signal?.aborted ? 'interrupted' : 'failed', durationMs: performance.now() - start,
      failure: signal?.aborted ? { code: 'interrupted' } : api.evaluationFailure(error) };
  }
  const durationMs = performance.now() - start;
  const policy = api.applyPolicy(snapshot.state, result.assessment);
  // Worker candidates have deterministic budget/selection guards and need no
  // filesystem. Read candidates are deliberately not resolved on virtual files.
  const guardedAction = ['CALL_CODEX', 'CALL_CLAUDE'].includes(policy.selected)
    ? (await api.selectCandidate(policy.selected, snapshot.state)).action : policy.selected;
  return { ...job, outcome: 'normalized', durationMs,
    ...(result.servedModel === undefined ? {} : { servedModel: result.servedModel }),
    assessment: result.assessment, requestedAction: result.assessment.nextAction.choice,
    policyAction: policy.selected, guardedAction,
    grade: grade(snapshot, result, policy, guardedAction, api.ACTIONS) };
}

async function runtime() {
  const modules = await Promise.all(['config', 'ai/evaluate', 'ai/contract', 'ai/errors', 'ai/transport',
    'orchestration/loop', 'orchestration/candidate', 'policy', 'types'].map((name) => import(new URL(`../../dist/${name}.js`, import.meta.url))));
  return Object.assign({}, ...modules);
}

export async function main(args = process.argv.slice(2)) {
  const [mode, directory, count, ...extra] = args;
  const repetitions = count === undefined ? 3 : Number(count);
  if ((mode !== '--plan' && mode !== '--live') || (mode === '--plan' && directory !== undefined) ||
    (mode === '--live' && (!directory || extra.length)) || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) {
    throw new Error('Usage: node scripts/decisions/run.mjs --plan | --live /new/external/output [1|2|3] (build first).');
  }
  const api = await runtime();
  const snapshots = buildSnapshots(api.createInitialState);
  const jobs = schedule(snapshots, ROUTES, repetitions);
  const inputs = snapshots.map((snapshot) => ({ id: snapshot.id, label: snapshot.label,
    snapshot: api.boundAgentStateForEvaluation(snapshot.state) }));
  const inputHashes = Object.fromEntries(inputs.map((item) => [item.id, fingerprint(item.snapshot)]));
  const questionsHash = fingerprint(api.NATIVE_EVALUATION_QUESTIONS);
  if (mode === '--plan') {
    console.log(JSON.stringify({ studyVersion: STUDY_VERSION, snapshots: snapshots.length, routes: ROUTES,
      repetitions, evaluations: jobs.length, maxHttpAttempts: jobs.length * 2, inputBytes: inputs.map((item) => ({ id: item.id, bytes: Buffer.byteLength(JSON.stringify(item.snapshot)) })), inputHashes, questionsHash }, null, 2));
    return;
  }
  // Validate ambient selectors, then bind all four explicit configurations once.
  api.resolveEvaluationProvider();
  const evaluators = Object.fromEntries(ROUTES.map((route) => [route.id, api.createEvaluator(api.resolveEvaluationConfiguration({
    ...process.env, ROUTER_PROVIDER: route.provider, JEV_PROVIDER: route.provider, ROUTER_MODEL: route.model,
  }))]));
  const checkout = fileURLToPath(new URL('../..', import.meta.url));
  const output = path.resolve(directory);
  const parent = await realpath(path.dirname(output));
  const canonicalOutput = path.join(parent, path.basename(output));
  const canonicalCheckout = await realpath(checkout);
  if (canonicalOutput === canonicalCheckout || canonicalOutput.startsWith(canonicalCheckout + path.sep)) throw new Error('Output must be outside the checkout.');
  await mkdir(canonicalOutput, { mode: 0o700 }); // Refuse reuse/overwrite/resume.
  const save = (name, data) => writeFile(path.join(canonicalOutput, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const sourceFiles = ['scripts/decisions/fixtures.mjs', 'scripts/decisions/metrics.mjs', 'scripts/decisions/run.mjs',
    'dist/config.js', 'dist/ai/evaluate.js', 'dist/ai/contract.js', 'dist/ai/native.js', 'dist/ai/cloudflare.js',
    'dist/ai/errors.js', 'dist/ai/transport.js', 'dist/policy.js', 'dist/orchestration/candidate.js'];
  const hashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (name) => [name, createHash('sha256').update(await readFile(path.join(checkout, name))).digest('hex')])));
  const manifest = { studyVersion: STUDY_VERSION, startedAt: new Date().toISOString(),
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8', timeout: 5000 }).trim(),
    sourceWorkingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: checkout, encoding: 'utf8', timeout: 5000 }).trim()),
    node: process.version, routes: ROUTES, repetitions, snapshots: snapshots.length, planned: jobs.length,
    deadlineMs: 10_000, maxRetries: 1, responseBytes: 65_536, maxStudyMs: 15 * 60_000,
    hashes, inputHashes, questionsHash, order: jobs };
  await save('manifest.json', manifest);
  await mkdir(path.join(canonicalOutput, 'harness'));
  await Promise.all(['fixtures.mjs', 'metrics.mjs', 'run.mjs'].map((name) => copyFile(new URL(name, import.meta.url), path.join(canonicalOutput, 'harness', name))));
  await save('inputs.json', inputs);
  await writeFile(path.join(canonicalOutput, 'observations.jsonl'), '', { flag: 'wx', mode: 0o600 });
  const controller = new AbortController();
  let exitCode = 0;
  const onInterrupt = () => { exitCode = 130; controller.abort(); };
  const onTerminate = () => { exitCode = 143; controller.abort(); };
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  const timer = setTimeout(() => { exitCode = 1; controller.abort(); }, manifest.maxStudyMs);
  const realFetch = globalThis.fetch;
  let active;
  let invariantFailure = false;
  const rows = [];
  // Observe the existing bounded transport. Never persist headers, URLs/account
  // IDs, raw bodies/errors, refusal text, or credentials. Only numeric usage.
  globalThis.fetch = async (url, init) => {
    const current = active;
    const body = JSON.parse(String(init.body));
    if (!current || fingerprint(body.state) !== inputHashes[current.job.snapshotId] || fingerprint(body.questions) !== questionsHash) {
      invariantFailure = true;
      throw new Error('Benchmark input identity check failed.');
    }
    const attempt = { status: null, usage: null, refusal: false };
    current.attempts.push(attempt);
    const response = await api.boundedResponse(await realFetch(url, init), init.signal);
    const text = await response.text();
    if (active === current && !init.signal.aborted) {
      attempt.status = response.status;
      try {
        const parsed = api.parseEvaluationJson(text);
        attempt.usage = reportedUsage(parsed);
        const result = parsed?.result ?? parsed;
        attempt.refusal = result?.refusal !== undefined || Object.values(result?.answers ?? {}).some((answer) => answer?.type === 'refusal' || answer?.refusal !== undefined);
      } catch { /* The evaluator classifies malformed data; no raw error kept. */ }
    }
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  try {
    for (const job of jobs) {
      if (controller.signal.aborted) break;
      active = { job, attempts: [] };
      const snapshot = snapshots.find((item) => item.id === job.snapshotId);
      const row = await observation(job, snapshot, evaluators[job.routeId], api, controller.signal);
      row.attempts = structuredClone(active.attempts);
      active = undefined;
      rows.push(row);
      await appendFile(path.join(canonicalOutput, 'observations.jsonl'), JSON.stringify(row) + '\n');
      console.log(JSON.stringify({ completed: rows.length, planned: jobs.length, route: row.routeId, snapshot: row.snapshotId,
        outcome: row.outcome, requested: row.requestedAction, guarded: row.guardedAction, durationMs: Math.round(row.durationMs), failure: row.failure?.code }));
      if (invariantFailure) { exitCode = 1; break; }
    }
  } finally {
    globalThis.fetch = realFetch; clearTimeout(timer);
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
    const summary = { studyVersion: STUDY_VERSION, startedAt: manifest.startedAt, endedAt: new Date().toISOString(),
      sourceHead: manifest.sourceHead, sourceWorkingTreeDirty: manifest.sourceWorkingTreeDirty,
      hashes, questionsHash, invariantFailure, inputHashes, ...summarize(rows, ROUTES, jobs.length) };
    await save('summary.json', summary);
    process.exitCode = exitCode;
    console.log(JSON.stringify({ output: canonicalOutput, attempted: rows.length, planned: jobs.length, exitCode }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Decision comparison failed before completion. Check build, arguments, selected credentials, and a new external output path. No upstream error text is retained.'); process.exitCode = 1; });
}
