#!/usr/bin/env node
import path from 'node:path';
import { inspectRepo } from './repo/inspect.js';
import { evaluateAgentState } from './ai/evaluate.js';
import { applyPolicy } from './policy.js';
import { writeTrace } from './logging/trace.js';
import { mockEvaluation } from './mock.js';
import type { Action, AgentState } from './types.js';

type CliOptions = {
  repoPath: string;
  task: string;
  mock: boolean;
  noTrace: boolean;
};

function usage(): string {
  return `jev-agent <repo-path> <task> [--mock] [--no-trace]

Examples:
  pnpm dev -- . "Decide what to inspect first"
  pnpm dev -- ../my-app "Fix preview auth" --mock

Environment:
  AI_GATEWAY_API_KEY   Vercel AI Gateway key
  ROUTER_MODEL         Defaults to typesafe-ai/jev`;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    process.exit(0);
  }
  const mock = argv.includes('--mock');
  const noTrace = argv.includes('--no-trace');
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const repoPath = positional[0];
  const task = positional.slice(1).join(' ').trim();
  if (!repoPath || !task) throw new Error(`Missing repository path or task.\n\n${usage()}`);
  return { repoPath, task, mock, noTrace };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function printDistribution(probabilities: Partial<Record<Action, number>>): void {
  const entries = Object.entries(probabilities).sort(([, a], [, b]) => (b ?? 0) - (a ?? 0));
  for (const [action, probability] of entries) {
    console.log(`  ${action.padEnd(14)} ${percent(probability ?? 0).padStart(4)}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repo = await inspectRepo(options.repoPath);
  const state: AgentState = {
    task: options.task,
    iteration: 1,
    currentGoal: 'Choose the safest useful first action.',
    repo,
    filesRead: [],
    filesModified: [],
    observations: ['Initial repository snapshot collected.'],
    commandsRun: [],
    tests: { ran: false },
    failedApproaches: [],
    codexCalls: 0,
  };

  console.log('\nJev Orchestrator — decision-only milestone\n');
  console.log(`Repo: ${repo.root}`);
  console.log(`Task: ${state.task}`);
  console.log(`Mode: ${options.mock ? 'mock' : 'live Jev'}\n`);

  const evaluation = options.mock ? mockEvaluation() : await evaluateAgentState(state);
  const policy = applyPolicy(state, evaluation.assessment);
  const { assessment } = evaluation;

  console.log(`Task complete       ${percent(assessment.taskComplete.probability)}`);
  console.log(`Needs information  ${percent(assessment.needsMoreInformation.probability)}`);
  console.log(`Needs testing      ${percent(assessment.needsTesting.probability)}`);
  console.log(`Stuck              ${percent(assessment.stuck.probability)}\n`);
  console.log('Next-action distribution');
  printDistribution(assessment.nextAction.probabilities);
  console.log(`\nJev requested: ${policy.requested}`);
  console.log(`Policy selected: ${policy.selected}${policy.override ? ' (override)' : ''}`);
  console.log(`Reason: ${policy.reason}`);
  console.log(`Latency: ${evaluation.latencyMs}ms`);

  if (!options.noTrace) {
    const tracePath = await writeTrace(process.cwd(), { state, evaluation, policy });
    console.log(`Trace: ${path.relative(process.cwd(), tracePath)}`);
  }
}

main().catch((error: unknown) => {
  console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
