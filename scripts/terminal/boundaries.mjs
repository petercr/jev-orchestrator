// Synthetic transport/process boundaries for verify.mjs, never a CLI preload
// for real tasks. Policy, approval, tracing, and the process runner stay real.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.env.TERMINAL_CASE;
const directory = path.dirname(fileURLToPath(import.meta.url));
const forbidden = () => { throw new Error('Live HTTP is forbidden in terminal verification.'); };
http.get = forbidden; http.request = forbidden;
https.get = forbidden; https.request = forbidden;
let evaluations = 0;
const actions = ['SEARCH_REPO', 'READ_FILE', 'READ_ISSUE', 'RUN_COMMAND', 'RUN_TESTS', 'CALL_CODEX', 'CALL_CLAUDE', 'ASK_USER', 'FINISH'];
globalThis.fetch = async (url) => {
  assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone');
  evaluations++;
  if (mode === 'evaluation-interrupt') {
    writeFileSync('evaluating', 'ready');
    return new Promise(() => {});
  }
  const recovery = mode.startsWith('recovery');
  const worker = process.env.TERMINAL_WORKER === 'claude' ? 'CALL_CLAUDE' : 'CALL_CODEX';
  const route = mode.startsWith('saved-resume') ? ['RUN_TESTS', 'RUN_TESTS', 'FINISH']
    : mode === 'inspection' ? [worker, 'RUN_TESTS', 'READ_FILE']
    : mode === 'repair' ? [worker, 'RUN_TESTS', worker, 'RUN_TESTS', 'FINISH'] : [worker, 'RUN_TESTS', 'FINISH'];
  const action = mode.startsWith('information') ? 'ASK_USER'
    : mode === 'iteration-limit' ? worker
      : route[Math.max(0, evaluations - 1 - Number(recovery))] ?? 'FINISH';
  return Response.json({ model: 'synthetic/terminal-verification', answers: {
    taskComplete: { type: 'noul', noul: action === 'FINISH' ? 0.94 : 0.01 },
    needsMoreInformation: { type: 'noul', noul: action === 'ASK_USER' ? 0.99 : 0.01 },
    needsTesting: { type: 'noul', noul: action === 'RUN_TESTS' || (mode === 'repair' && evaluations === 3) ? 0.99 : 0.01 },
    stuck: { type: 'noul', noul: 0.01 },
    nextAction: { type: 'choice', choice: action, confidence: 0.99,
      probabilities: Object.fromEntries(actions.map((known) => [known, known === action ? (recovery && evaluations === 1 ? 0.99 : 1) : 0])) },
  } });
};

const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (command === 'codex' || command === 'claude') {
    assert.equal(command, process.env.TERMINAL_WORKER);
    assert.equal(options.shell, false);
    if (command === 'codex') {
      assert.ok(args.includes('workspace-write'));
      assert.ok(args.includes(`sandbox_workspace_write.network_access=${process.env.TERMINAL_NETWORK === 'true'}`));
      assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'never');
    } else {
      assert.ok(args.includes('--restricted'));
      assert.ok(args.includes('--strict-mcp-config'));
      assert.equal(args[args.indexOf('--tools') + 1], 'Read,Write,Edit,Glob,Grep');
    }
    return spawn(process.execPath, [path.join(directory, 'worker.mjs')], options);
  }
  if (command === 'npm') {
    assert.deepEqual(args, ['run', 'test']);
    assert.equal(options.shell, false);
    return spawn(process.execPath, ['check.mjs'], options);
  }
  assert.equal(command, 'git', 'Only fixture workers/checks and read-only Git inspection may run.');
  return spawn(command, args, options);
};
syncBuiltinESMExports();

// Record application bytes before ConPTY's own screen encoding. ConPTY can
// emit VT sequences even when the application uses completely plain output.
let applicationOutput = '';
const stdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  applicationOutput += chunk.toString();
  assert.ok(Buffer.byteLength(applicationOutput) <= 2 * 1024 * 1024);
  return stdoutWrite(chunk, ...args);
};
const signalCounts = () => ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name));
const before = signalCounts();
const rawModes = [];
if (process.stdin.setRawMode) {
  const setRawMode = process.stdin.setRawMode.bind(process.stdin);
  process.stdin.setRawMode = (raw) => { rawModes.push(raw); return setRawMode(raw); };
}
const terminalMode = () => process.platform === 'win32' || !process.stdin.isTTY ? null
  : childProcess.execFileSync('stty', ['-g'], { stdio: [0, 'pipe', 'ignore'] }).toString().trim();
const beforeMode = terminalMode();
if (mode.endsWith('timeout')) {
  const setTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, duration, ...args) => setTimeout(callback, duration === 900_000 ? 150 : duration, ...args);
}
process.on('exit', () => {
  writeFileSync(process.env.TERMINAL_RECEIPT, JSON.stringify({
    applicationOutput, rawModes, isRaw: process.stdin.isRaw === true,
    term: process.env.TERM,
    signalsBefore: before, signalsAfter: signalCounts(), beforeMode, afterMode: terminalMode(),
  }));
});
