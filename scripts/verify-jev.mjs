import { evaluateAgentState, JevEvaluationError } from '../dist/ai/evaluate.js';
import { createInitialState } from '../dist/orchestration/loop.js';

// Separate opt-in check: one synthetic evaluation, at most two HTTP attempts.
const [optIn, provider, ...extra] = process.argv.slice(2);
if (optIn !== '--live' || !['vercel', 'openrouter', 'typesafe'].includes(provider) || extra.length > 0) {
  console.error('Usage: pnpm verify:jev --live <vercel|openrouter|typesafe> (requires a build and the selected credential).');
  process.exitCode = 2;
} else {
  process.env.JEV_PROVIDER = provider;
  const state = createInitialState({
    root: '/synthetic-fixture', packageManager: 'pnpm', scripts: ['test'],
    validationScripts: ['test'], gitStatus: [], topLevelFiles: ['src'],
  }, 'Choose a safe first inspection action for this synthetic fixture. No implementation has started.');
  try {
    const result = await evaluateAgentState(state);
    console.log(JSON.stringify({
      provider: result.provider, requestedModel: result.requestedModel,
      ...(result.servedModel === undefined ? {} : { servedModel: result.servedModel }),
      outcome: 'normalized',
    }));
  } catch (error) {
    console.log(JSON.stringify({
      provider, outcome: 'failed',
      code: error instanceof JevEvaluationError ? error.code : 'configuration',
    }));
    process.exitCode = 1;
  }
}
