import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pty from 'node-pty';
import xterm from '@xterm/headless';

const directory = path.dirname(fileURLToPath(import.meta.url));
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  assert.ok(['--cli', '--output', '--only'].includes(name), `Unknown option: ${name}`);
  assert.ok(process.argv[index + 1], `Missing value for ${name}`);
  options[name.slice(2)] = process.argv[index + 1];
}
assert.ok(options.output, 'Supply --output with a new evidence directory outside the repository.');
const cli = realpathSync(options.cli ?? path.join(directory, '../../dist/cli.js'));
const output = path.resolve(options.output);
assert.ok(!existsSync(output), 'The evidence directory must be new; failed runs are retained.');
mkdirSync(output, { recursive: true });
const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG']);
const baseEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => allowed.has(name.toUpperCase())).map(([name, value]) => [name.toUpperCase(), value]));
const credential = 'terminal-fixture-key';
const task = `Set value to 2 and pass test; inspect quoted "text", Ω, and \u001b[2J\u001b]8;;https://example.invalid\u0007controls\u001b]8;;\u0007\u202e. ${credential}`;
const normalize = (value) => value.replace(/[│┌┐└┘─◇◆]/gu, '').replace(/\s/gu, '');
const reports = [];
const decisionChecks = [];

const scenarios = [
  ...[40, 60, 80, 120].map((columns) => ({ name: `styled-${columns}`, mode: 'complete', columns })),
  { name: 'plain', mode: 'complete', plain: true },
  { name: 'pipe', mode: 'complete', pipe: true },
  { name: 'pipe-eof', mode: 'approval-eof', pipe: true },
  { name: 'no-color', mode: 'complete', environment: { NO_COLOR: '' } },
  { name: 'ci', mode: 'complete', environment: { CI: 'true' } },
  { name: 'dumb', mode: 'complete', environment: { TERM: 'dumb' } },
  { name: 'claude', mode: 'complete', worker: 'claude' },
  { name: 'network', mode: 'complete', network: true },
  { name: 'repair', mode: 'repair' },
  { name: 'recovery', mode: 'recovery' },
  { name: 'invalid-input', mode: 'complete', invalid: true },
  { name: 'iteration-limit', mode: 'iteration-limit' },
  ...['eof', 'timeout', 'interrupt'].flatMap((stop) => [
    { name: `approval-${stop}`, mode: `approval-${stop}` },
    { name: `information-${stop}`, mode: `information-${stop}` },
    { name: `recovery-${stop}`, mode: `recovery-${stop}` },
  ]),
  { name: 'plain-eof', mode: 'approval-eof', plain: true },
  ...(process.platform === 'win32' ? [{ name: 'plain-ctrl-d-enter', mode: 'approval-eof', plain: true, eof: '\u0004\r' }] : []),
  { name: 'escape', mode: 'approval-escape' },
  { name: 'alternative-eof', mode: 'alternative-eof' },
  { name: 'active-interrupt', mode: 'active-interrupt' },
  { name: 'evaluation-interrupt', mode: 'evaluation-interrupt' },
  ...(process.platform === 'win32' ? [] : [{ name: 'active-sigterm', mode: 'active-sigterm' }]),
  { name: 'typed-stop', mode: 'stop' },
  { name: 'typed-quit', mode: 'quit', plain: true },
];

function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux' && /\) Z /u.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
    return true;
  } catch { return false; }
}

async function walkthrough(scenario) {
  const { name, mode, columns = 80 } = scenario;
  const root = path.join(output, name, 'project space Ω', 'long parent directory '.repeat(3).trim());
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'terminal-fixture', type: 'module', scripts: { test: 'node check.mjs' } }));
  writeFileSync(path.join(root, 'package-lock.json'), '{}\n');
  writeFileSync(path.join(root, 'value.mjs'), 'export const value = 1;\n');
  writeFileSync(path.join(root, 'check.mjs'), "import assert from 'node:assert/strict';import {value} from './value.mjs';assert.equal(value,2);\n");
  const worker = scenario.worker ?? 'codex';
  const receiptPath = path.join(output, `${name}.receipt.json`);
  const environment = { ...baseEnvironment, TERM: 'xterm-256color', ROUTER_PROVIDER: 'typesafe',
    TYPESAFE_API_KEY: credential, TERMINAL_CASE: mode, TERMINAL_WORKER: worker,
    TERMINAL_NETWORK: String(scenario.network === true), TERMINAL_RECEIPT: receiptPath, ...scenario.environment };
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']]) {
    const result = spawnSync('git', args, { cwd: root, env: baseEnvironment, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  }
  const args = ['--import', pathToFileURL(path.join(directory, 'boundaries.mjs')).href, cli,
    '.', task, '--orchestrate', '--worker', worker, ...(scenario.network ? ['--codex-network'] : []), ...(scenario.plain ? ['--plain'] : [])];
  const screen = new xterm.Terminal({ cols: columns, rows: 30, scrollback: 10_000, allowProposedApi: true, convertEol: !!scenario.pipe });
  let raw = '';
  let writes = Promise.resolve();
  const receive = (data) => {
    raw += data;
    assert.ok(Buffer.byteLength(raw) <= 2 * 1024 * 1024, `${name}: output bound`);
    writes = writes.then(() => new Promise((resolve) => screen.write(data, resolve)));
  };
  let exit;
  let send;
  let endInput;
  let kill;
  let childPid;
  if (scenario.pipe) {
    const child = spawn(process.execPath, args, { cwd: root, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => receive(chunk.toString()));
    child.stderr.on('data', (chunk) => receive(chunk.toString()));
    child.on('error', (error) => { exit = { error: error.message }; });
    child.on('close', (code) => { exit = { code }; });
    childPid = child.pid;
    send = (answer) => child.stdin.write(answer.replace(/\r/gu, '\n'));
    endInput = () => child.stdin.end();
    kill = () => child.kill('SIGKILL');
  } else {
    const child = pty.spawn(process.execPath, args, { cwd: root, env: environment, name: environment.TERM, cols: columns, rows: 30, useConpty: true, useConptyDll: true });
    child.onData(receive);
    child.onExit((event) => { exit = { code: event.exitCode }; });
    childPid = child.pid;
    send = (answer) => child.write(answer);
    endInput = () => child.write(scenario.eof ?? (scenario.plain && process.platform === 'win32' ? '\u001a\r' : '\u0004'));
    kill = () => {
      if (!exit) child.kill();
      if (process.platform === 'win32') {
        // Pinned node-pty 1.1.0 retains this test-owned worker after natural
        // exit (microsoft/node-pty#965). Keep its workaround outside the CLI;
        // bundled ConPTY avoids the system backend's orphaned console host.
        const agent = child._agent;
        assert.equal(typeof agent?._conoutSocketWorker?.dispose, 'function', 'Review the pinned ConPTY driver cleanup when upgrading.');
        agent._conoutSocketWorker.dispose();
        agent.inSocket.destroy(); agent.outSocket.destroy();
      }
    };
  }
  const reviews = [];
  const responses = [];
  let previousPrompt;
  let activeInterrupted = false;
  const deadline = performance.now() + 30_000;
  const text = () => Array.from({ length: screen.buffer.active.length }, (_, index) => screen.buffer.active.getLine(index).translateToString(true)).join('\n');
  try {
    while (!exit && performance.now() < deadline) {
      await delay(20); await writes;
      const contents = text();
      const lines = contents.split('\n');
      let prompt;
      for (let index = 0; index < lines.length; index++) {
        const tail = normalize(lines.slice(index, index + 4).join(''));
        if (tail.startsWith('Chooseapprove,reject,stop,oranallowedactionname:')) prompt = { kind: 'approval', index };
        if (tail.startsWith('Entercontinuetoreevaluatethisstate,orstop:')) prompt = { kind: 'recovery', index };
        if (tail.startsWith('Providetherequiredinformation:')) prompt = { kind: 'information', index };
      }
      // Clack's completed prompts start with a check/diamond and are no longer
      // input owners. Plain prompts have no such marker.
      if (prompt && !scenario.pipe && !scenario.plain && !scenario.environment && !lines[prompt.index].trimStart().startsWith('◆')) prompt = undefined;
      if (prompt && `${prompt.kind}:${prompt.index}` !== previousPrompt) {
        previousPrompt = `${prompt.kind}:${prompt.index}`;
        reviews.push(contents);
        let answer;
        if (mode === `${prompt.kind}-timeout`) continue;
        if (mode === `${prompt.kind}-eof` || (mode === 'alternative-eof' && responses.at(-1) === 'FINISH')) {
          responses.push('EOF'); endInput(); continue;
        }
        else if (mode === `${prompt.kind}-interrupt`) answer = '\u0003';
        else if (mode === 'approval-escape') answer = '\u001b';
        else if (mode === 'iteration-limit') answer = 'reject\r';
        else if (mode === 'stop' || mode === 'quit') answer = `${mode}\r`;
        else if (scenario.invalid && responses.length < 2) answer = responses.length === 0 ? '\r' : 'not-an-approval\r';
        else if (prompt.kind === 'recovery') answer = responses.length === 0 ? 'approve\r' : 'continue\r';
        else {
          const actions = [...contents.matchAll(/Safe candidate:\s*(\w+)/gu)];
          answer = actions.at(-1)?.[1] === 'ASK_USER' && !mode.startsWith('information') ? 'FINISH\r' : 'approve\r';
        }
        responses.push(answer.replace(/\r$/u, ''));
        send(answer);
      }
      const marker = path.join(root, mode === 'evaluation-interrupt' ? 'evaluating' : 'worker.pid');
      if (!activeInterrupted && (mode.startsWith('active') || mode === 'evaluation-interrupt') && existsSync(marker)) {
        if (mode.startsWith('active') && process.platform !== 'win32' && !existsSync(path.join(root, 'descendant.pid'))) continue;
        activeInterrupted = true;
        if (mode === 'active-sigterm') process.kill(childPid, 'SIGTERM');
        else send('\u0003');
      }
    }
    assert.ok(exit, `${name}: deadline expired`);
    await writes;
    const expectedExit = mode.endsWith('interrupt') ? 130 : mode === 'active-sigterm' ? 143
      : /(?:eof|timeout|escape)$/u.test(mode) || mode === 'iteration-limit' ? 1 : 0;
    assert.equal(exit.code, expectedExit, `${name}: exit status`);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.term, environment.TERM, `${name}: terminal environment`);
    assert.equal(receipt.isRaw, false, `${name}: raw mode restored`);
    assert.deepEqual(receipt.signalsAfter, receipt.signalsBefore, `${name}: signal handlers restored`);
    assert.equal(receipt.afterMode, receipt.beforeMode, `${name}: terminal flags restored`);
    const cursor = [...receipt.applicationOutput.matchAll(/\u001b\[\?25([lh])/gu)].at(-1)?.[1];
    assert.ok(cursor === undefined || cursor === 'h', `${name}: cursor restored`);
    const plain = scenario.pipe || scenario.plain || !!scenario.environment;
    if (plain) assert.ok(!receipt.applicationOutput.includes('\u001b'), `${name}: plain application output`);
    assert.ok(!receipt.applicationOutput.includes(credential), `${name}: credential redaction`);
    assert.ok(!receipt.applicationOutput.includes('\u001b[2J') && !receipt.applicationOutput.includes('\u001b]8;;'), `${name}: terminal injection`);
    const traceFile = readdirSync(path.join(root, 'traces'));
    assert.equal(traceFile.length, 1);
    const traceRaw = readFileSync(path.join(root, 'traces', traceFile[0]), 'utf8');
    assert.ok(!traceRaw.includes('\u001b') && !traceRaw.includes(credential));
    assert.ok(!/"(?:plain|styled|columns|rawModes)":/u.test(traceRaw));
    const records = traceRaw.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(records.every((record) => record.schemaVersion === 2));
    const last = records.at(-1);
    const counts = last.summary.counts;
    assert.ok(last.iteration <= 8 && counts.codexCalls <= 2 && counts.claudeCalls <= 2);
    assert.equal(counts[worker === 'codex' ? 'claudeCalls' : 'codexCalls'], 0);
    for (const record of records) {
      for (const candidate of record.proposal?.considered ?? []) {
        const parameters = JSON.stringify(candidate.input).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
        // Deep trace fields may be deliberately truncated. Check every retained
        // value without treating the trace's marker as the original input.
        const pattern = new RegExp(normalize(`Parameters: ${parameters}`).split('"[TRUNCATED]"')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*?'), 'u');
        assert.ok(reviews.some((review) => normalize(review).includes(normalize(`Safe candidate: ${candidate.action}`))
          && pattern.test(normalize(review))), `${name}: retained ${candidate.action} parameter review`);
      }
    }
    if (['complete', 'repair', 'recovery'].includes(mode)) {
      assert.equal(last.summary.validation.passed, true);
      assert.equal(last.stateAfter.evidence.validationGeneration, mode === 'repair' ? 2 : 1);
      assert.equal(counts[worker === 'codex' ? 'codexCalls' : 'claudeCalls'], mode === 'repair' ? 2 : 1);
      assert.deepEqual(last.approval.history, [{ kind: 'alternative', action: 'FINISH' }, { kind: 'approve' }]);
      assert.equal(counts.evaluationRecoveries, Number(mode === 'recovery'));
      assert.equal(readFileSync(path.join(root, 'value.mjs'), 'utf8'), 'export const value = 2;\n');
    } else if (mode.startsWith('active')) {
      assert.equal(last.interruption.phase, 'execution');
      assert.equal(counts.cancelledExecutions, 1);
      assert.equal(last.summary.validation.passed, false);
      assert.equal(readFileSync(path.join(root, 'value.mjs'), 'utf8'), 'export const value = 3;\n');
      for (const file of ['worker.pid', 'descendant.pid']) {
        if (existsSync(path.join(root, file))) assert.equal(alive(Number(readFileSync(path.join(root, file), 'utf8'))), false, `${name}: ${file} drained`);
      }
    } else if (mode.endsWith('eof') || mode.endsWith('timeout') || mode.endsWith('escape')) {
      const phase = mode.split('-')[0] === 'information' ? 'information' : mode.startsWith('recovery') ? 'recovery' : 'approval';
      assert.deepEqual(last.promptStop, { phase, reason: mode.endsWith('timeout') ? 'input_timeout' : mode.endsWith('escape') ? 'input_cancelled' : 'input_closed' });
      assert.equal(counts.approvals, phase === 'information' ? 1 : mode === 'alternative-eof' ? 2 : 0);
      assert.equal(counts.evaluationRecoveries, 0);
      assert.deepEqual(last.stateAfter.evidence.clarifications, []);
      if (phase !== 'information') assert.notEqual(last.approval?.kind, 'approve');
    } else if (mode === 'iteration-limit') {
      assert.equal(last.iteration, 8); assert.equal(counts.approvals, 0); assert.equal(counts.codexCalls, 0);
    } else if (mode.endsWith('interrupt')) {
      assert.equal(last.interruption.reason, 'signal');
      assert.equal(counts.approvals, mode.startsWith('information') ? 1 : 0);
      assert.equal(counts.codexCalls, 0);
    } else assert.equal(last.approval.kind, 'stop');
    writeFileSync(path.join(output, `${name}.app.log`), receipt.applicationOutput);
    reports.push({ name, mode, columns, plain, exitCode: exit.code, reviews: reviews.length, counts,
      validationPassed: last.summary.validation.passed, terminalRestored: true, rootLength: root.length });
    console.log(`PASS ${name}`);
  } finally {
    // Release the test-owned console only after inspecting the CLI's result.
    if (!exit || (!scenario.pipe && process.platform === 'win32')) kill();
    await writes;
    writeFileSync(path.join(output, `${name}.pty.log`), raw);
    writeFileSync(path.join(output, `${name}.screen.txt`), text());
    screen.dispose();
  }
}

try {
  const selected = scenarios.filter((scenario) => !options.only || scenario.name === options.only);
  assert.ok(selected.length > 0, 'No matching scenario.');
  for (const scenario of selected) await walkthrough(scenario);
  for (const plain of [false, true]) {
    const root = path.join(output, `json-${plain ? 'plain' : 'default'}`);
    mkdirSync(root);
    const json = spawnSync(process.execPath, [cli, root, task, '--mock', '--json', ...(plain ? ['--plain'] : [])],
      { cwd: root, env: { ...baseEnvironment, TYPESAFE_API_KEY: credential }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(json.status, 0, json.stderr);
    assert.ok(!json.stdout.includes('\u001b') && !json.stdout.includes(credential));
    const decision = JSON.parse(json.stdout);
    assert.equal(decision.schemaVersion, 1); assert.equal(decision.status, 'unexecuted');
    const raw = readFileSync(path.join(root, decision.tracePath), 'utf8');
    assert.ok(!raw.includes('\u001b') && !raw.includes(credential));
    assert.ok(!/"(?:plain|styled|columns|rawModes)":/u.test(raw));
    assert.equal(JSON.parse(raw).schemaVersion, 1);
    assert.deepEqual(decision.policy, JSON.parse(raw).policy);
    writeFileSync(path.join(root, 'decision.json'), json.stdout);
    decisionChecks.push({ plain, schemaVersion: 1, status: decision.status, traceSchemaVersion: 1 });
  }
  console.log(`Verified ${reports.length} terminal scenarios and ${decisionChecks.length} schema-v1 JSON/trace checks on ${process.platform}.`);
} finally {
  writeFileSync(path.join(output, 'report.json'), JSON.stringify({ cli, driverPid: process.pid, node: process.version, platform: process.platform,
    os: os.release(), architecture: process.arch, reports, decisionChecks }, null, 2) + '\n');
}
