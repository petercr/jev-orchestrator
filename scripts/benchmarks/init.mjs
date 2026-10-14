// Initialize an external, credential-free manifest for the fixed comparison.
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandOutput, externalRoot, isMain, readJson, requireCondition, writeJson } from './lib.mjs';

export function initialize(directory) {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const root = externalRoot(directory, source);
  requireCondition(readJson(path.join(source, 'package.json')).version === '0.2.0', 'This protocol measures the v0.2 package.');
  requireCondition(!existsSync(root), 'Initialization cannot replace an existing output directory.');
  mkdirSync(root, { recursive: true });
  const version = (command) => commandOutput(command, source).trim();
  const manifest = {
    trackingIssue: 31,
    task: 'https://github.com/TrusTrove/TrusTrove-app/issues/949',
    targetHead: '6cae96e13e950a9e932130ef1a7aebbcddf9c58e',
    sourceHead: version(['git', 'rev-parse', 'HEAD']), sourceCheckout: source, preservedCheckouts: [],
    createdAt: new Date().toISOString(), nodeVersion: version(['node', '--version']),
    codexVersion: version(['codex', '--version']), claudeVersion: version(['claude', '--version']),
    requestedModels: { codex: 'gpt-5.6-terra', claude: 'sonnet', evaluation: 'jev-1.13.0' },
    efforts: { codex: 'high', claude: 'medium' },
    maxIterations: 8, maxCallsPerAdapter: 2, workerTimeoutMs: 900_000, validationTimeoutMs: 120_000,
    attemptProtocol: 'One implementation attempt per scheduled observation; failed samples retained without replacement; controlled repair not exercised.',
    repetitions: 3,
    runOrder: [
      'codex-jev-1', 'codex-standalone-1', 'claude-standalone-1', 'claude-jev-1',
      'codex-standalone-2', 'codex-jev-2', 'claude-jev-2', 'claude-standalone-2',
      'codex-jev-3', 'codex-standalone-3', 'claude-standalone-3', 'claude-jev-3',
    ],
  };
  writeJson(path.join(root, 'manifest.json'), manifest);
  return root;
}

if (isMain(import.meta.url)) console.log(initialize(process.argv[2]));
