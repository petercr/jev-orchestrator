#!/usr/bin/env node
// Fixed direct control: prepare the same bounded evidence, then call the installed adapter once.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [entry, directory, worker, task] = process.argv.slice(2);
if (!entry || !directory || !['codex', 'claude'].includes(worker) || !task) throw new Error('Invalid direct-control arguments.');
const load = (name) => import(pathToFileURL(path.join(path.dirname(entry), name)));
const { inspectRepo } = await load('repo/inspect.js');
const { createInitialState } = await load('orchestration/loop.js');
const { executeCandidate } = await load('orchestration/execute.js');
const { buildWorkerContext } = await load('agents/context.js');
const { truncateText } = await load('limits.js');
const { redactSensitiveText } = await load('logging/trace.js');
const adapterModule = await load(`agents/${worker}.js`);
const save = (name, value) => writeFile(path.join(directory, name), redactSensitiveText(JSON.stringify(value, null, 2)) + '\n', { mode: 0o600 });
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
const startedAt = performance.now();
const snapshot = await inspectRepo(process.cwd());
const state = createInitialState(snapshot, task, worker, worker === 'codex' ? true : undefined);
const preparation = [];
const issue = await executeCandidate({ action: 'READ_ISSUE', tool: 'github_issue', input: { url: task } }, undefined, { signal: controller.signal });
if (!issue.ok || !issue.issue) throw new Error('Direct-control issue preparation failed.');
state.evidence.issue = issue.issue;
preparation.push({ action: 'READ_ISSUE', durationMs: issue.durationMs, ok: issue.ok });
let iteration = 2;
for (const file of ['AGENTS.md', 'CONTRIBUTING.md', 'CLAUDE.md'].filter((name) => snapshot.topLevelFiles.includes(name))) {
  const result = await executeCandidate({ action: 'READ_FILE', tool: 'read_file', input: { root: snapshot.root, path: file } });
  if (!result.ok) throw new Error('Direct-control instruction preparation failed.');
  state.filesRead.push(...result.files);
  state.evidence.findings.push({ iteration: iteration++, source: 'read', paths: result.files.slice(0, 8), excerpt: truncateText(result.output, 1_000) });
  preparation.push({ action: 'READ_FILE', path: file, durationMs: result.durationMs, ok: result.ok });
}
state.currentGoal = 'Validate the repository after inspection.';
const context = buildWorkerContext(state);
const preparationMs = Math.round(performance.now() - startedAt);
await save('direct-preparation.json', { preparationMs, preparation, context });
const request = { root: snapshot.root, task, context, ...(worker === 'codex' ? { networkAccess: true } : {}) };
await save('direct-request.json', request);
console.log('Prepared exact issue and repository instructions; beginning direct worker.');
const adapter = worker === 'codex' ? adapterModule.createCodexAdapter() : adapterModule.createClaudeAdapter();
const result = await adapter(request, { signal: controller.signal });
await save('direct-result.json', { ...result, preparationMs, activeBeforeValidationMs: Math.round(performance.now() - startedAt) });
console.log(JSON.stringify({ worker, ok: result.ok, exitCode: result.exitCode, workerMs: result.durationMs, timedOut: result.timedOut, cancelled: result.cancelled === true }));
process.exitCode = result.ok ? 0 : 1;
