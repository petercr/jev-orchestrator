import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDecisionOutput } from '../cli.js';
import { JEV_PROVIDERS } from '../config.js';
import { buildWorkerContext } from '../agents/context.js';
import { appendOrchestrationTrace, createOrchestrationTrace, writeTrace } from '../logging/trace.js';
import { createInitialState, runOrchestration } from '../orchestration/loop.js';
import { selectCandidate } from '../orchestration/candidate.js';
import { applyPolicy } from '../policy.js';
import { ACTIONS, type Action, type EvaluationProvider } from '../types.js';
import { EVALUATION_QUESTIONS } from './contract.js';
import { createEvaluator, evaluateAgentState, JEV_EVALUATION_TIMEOUT_MS } from './evaluate.js';
import { NATIVE_JEV_ENDPOINTS } from './native.js';
import { MAX_JEV_RESPONSE_BYTES } from './transport.js';

type JevProvider = Exclude<EvaluationProvider, 'cloudflare'>;
const providers: JevProvider[] = ['vercel', 'openrouter', 'typesafe'];
const routes = [
  ...providers.map((provider) => ({ provider, model: JEV_PROVIDERS[provider].model, served: body(provider).model })),
  { provider: 'openrouter' as const, model: 'openai/gpt-6-luna-decisions', served: 'openai/gpt-6-luna-decisions' },
];
const roots: string[] = [];
const fetchMock = vi.fn<typeof fetch>();
const keys = [
  'gateway-secret-value', 'openrouter-secret-value', 'typesafe-secret-value',
  'openroute-alias-secret-value', 'typesafe-alias-secret-value',
  'cloudflare-secret-value',
];

function state() {
  return createInitialState({
    root: '/fixture', packageManager: 'pnpm', scripts: ['test'], validationScripts: ['test'],
    gitStatus: [], topLevelFiles: ['src'],
  }, 'Inspect the fixture');
}

function body(provider: JevProvider, choice: Action = 'SEARCH_REPO', confidence: number | undefined = 0.8): Record<string, unknown> {
  const nextAction: Record<string, unknown> = {
    type: 'choice', choice,
    probabilities: Object.fromEntries(ACTIONS.map((action) => [action, action === choice ? 1 : 0])),
    ...(provider === 'vercel' || confidence === undefined ? {} : { confidence }),
  };
  const boolean = (probability: number) => provider === 'vercel'
    ? { type: 'boolean', probability } : { type: 'noul', noul: probability };
  return {
    model: provider === 'openrouter' ? 'typesafe/jev-1.13-20260917' : 'jev-1.13.0',
    answers: {
      taskComplete: boolean(choice === 'FINISH' ? 0.99 : 0.02),
      needsMoreInformation: boolean(0.08), needsTesting: boolean(0.09), stuck: boolean(0.01), nextAction,
    },
    ...(provider !== 'vercel' || confidence === undefined ? {} : {
      providerMetadata: { typesafe: { confidence: { nextAction: confidence } } },
    }),
  };
}

function respond(provider: JevProvider, choice: Action = 'SEARCH_REPO', confidence: number | undefined = 0.8) {
  fetchMock.mockImplementation(async () => Response.json(body(provider, choice, confidence)));
}

beforeEach(() => {
  vi.stubEnv('ROUTER_PROVIDER', undefined);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('ROUTER_MODEL', '');
  vi.stubEnv('AI_GATEWAY_API_KEY', keys[0]);
  vi.stubEnv('OPENROUTER_API_KEY', keys[1]);
  vi.stubEnv('TYPESAFE_API_KEY', keys[2]);
  vi.stubEnv('OPENROUTE_API_KEY', keys[3]);
  vi.stubEnv('TYPESAFE_AI_API_KEY', keys[4]);
  vi.stubEnv('CLOUDFLARE_AUTH_TOKEN', keys[5]);
  vi.stubEnv('OPENROUTE_MODEL', '');
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('uses direct TypeSafe and its credential alias when no provider is selected', async () => {
  vi.stubEnv('JEV_PROVIDER', undefined);
  vi.stubEnv('AI_GATEWAY_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  vi.stubEnv('OPENROUTE_API_KEY', '');
  vi.stubEnv('TYPESAFE_API_KEY', '');
  respond('typesafe');
  const result = await evaluateAgentState(state());
  expect(result).toMatchObject({ provider: 'typesafe', requestedModel: 'jev-latest', servedModel: 'jev-1.13.0' });
  expect(fetchMock.mock.calls[0]?.[0]).toBe(NATIVE_JEV_ENDPOINTS.typesafe);
  expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(`Bearer ${keys[4]}`);
  expect(applyPolicy(state(), result.assessment).selected).toBe('SEARCH_REPO');
});

describe.each(routes)('$provider $model evaluation transport', ({ provider, model, served }) => {
  beforeEach(() => {
    vi.stubEnv('JEV_PROVIDER', provider);
    vi.stubEnv('ROUTER_MODEL', model);
  });
  function routeBody(choice: Action = 'SEARCH_REPO', confidence: number | undefined = 0.8): Record<string, unknown> {
    return { ...body(provider, choice, confidence), model: served };
  }
  function respondRoute() { fetchMock.mockImplementation(async () => Response.json(routeBody())); }

  it('preserves the questions, normalizes answers, attributes models, and permits a confident route', async () => {
    respondRoute();
    const result = await evaluateAgentState(state());
    expect(result).toMatchObject({ provider, model, requestedModel: model });
    if (provider !== 'vercel') expect(result.servedModel).toBe(routeBody().model);
    else expect(result).not.toHaveProperty('servedModel');
    expect(result.assessment).toMatchObject({
      taskComplete: { probability: 0.02 }, needsMoreInformation: { probability: 0.08 },
      needsTesting: { probability: 0.09 }, stuck: { probability: 0.01 }, nextAction: { confidence: 0.8 },
    });
    expect(applyPolicy(state(), result.assessment)).toMatchObject({ selected: 'SEARCH_REPO', override: false });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(provider === 'vercel' ? 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model' : NATIVE_JEV_ENDPOINTS[provider]);
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${keys[providers.indexOf(provider)]}`);
    const request = JSON.parse(String(init?.body));
    const expected = structuredClone(EVALUATION_QUESTIONS);
    for (const key of ['taskComplete', 'needsMoreInformation', 'needsTesting', 'stuck']) {
      expect(request.questions[key]).toEqual({ ...expected[key as keyof typeof expected], type: provider === 'vercel' ? 'boolean' : 'noul' });
    }
    expect(request.questions.nextAction).toEqual(expected.nextAction);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends only the selected key and supports a pinned override', async () => {
    for (const item of providers) if (item !== provider) vi.stubEnv(JEV_PROVIDERS[item].credential, '');
    const pinned = provider === 'typesafe' ? 'jev-1.13.0' : `${provider === 'vercel' ? 'typesafe-ai' : 'typesafe'}/jev-1.13`;
    vi.stubEnv('ROUTER_MODEL', pinned);
    respondRoute();
    const result = await evaluateAgentState(state());
    expect(result.requestedModel).toBe(pinned);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(provider === 'vercel' ? new Headers(init?.headers).get('ai-model-id') : JSON.parse(String(init?.body)).model).toBe(pinned);
  });

  it('copies configuration and retains it across evaluations and transient retries', async () => {
    const originalModel = model;
    const configuration: { provider: JevProvider; model: string; apiKey: string } = {
      provider, model: originalModel, apiKey: 'synthetic-bound-key',
    };
    const evaluate = createEvaluator(configuration);
    configuration.provider = provider === 'typesafe' ? 'openrouter' : 'typesafe';
    configuration.model = 'wrong/model';
    configuration.apiKey = 'synthetic-altered-key';
    vi.stubEnv('ROUTER_PROVIDER', 'invalid-later-selector');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockImplementation(async () => Response.json(routeBody()));

    for (let index = 0; index < 2; index += 1) {
      expect(await evaluate(state())).toMatchObject({ provider, requestedModel: originalModel });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toBe(provider === 'vercel' ? 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model' : NATIVE_JEV_ENDPOINTS[provider]);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-bound-key');
      expect(provider === 'vercel' ? new Headers(init?.headers).get('ai-model-id') : JSON.parse(String(init?.body)).model).toBe(originalModel);
    }
  });

  it('redacts the bound key from snapshots and returned evidence without relying on the ambient key', async () => {
    const key = 'synthetic-bound-secret-value';
    const evaluate = createEvaluator({ provider, model, apiKey: key });
    const payload = routeBody();
    payload.model = `jev-${key}`;
    if (provider === 'vercel') payload.providerMetadata = { typesafe: { confidence: { nextAction: 0.8 }, note: key } };
    else (payload.answers as Record<string, Record<string, unknown>>).nextAction!.note = key;
    fetchMock.mockImplementation(async () => Response.json(payload));
    const initial = state();
    initial.task += ` ${key}`;
    initial.observations.push(key);
    initial.evidence!.clarifications.push({ iteration: 1, text: key });
    const result = await evaluate(initial);
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).toContain('[REDACTED]');
  });

  it.each(['ambiguous', 'missing'] as const)('routes %s confidence to ASK_USER', async (mode) => {
    const payload = routeBody('SEARCH_REPO', mode === 'ambiguous' ? 0.1 : undefined);
    if (mode === 'missing') {
      delete payload.providerMetadata;
      const answers = payload.answers as Record<string, Record<string, unknown>>;
      delete answers.nextAction!.confidence;
    }
    fetchMock.mockImplementation(async () => Response.json(payload));
    const result = await evaluateAgentState(state());
    expect(applyPolicy(state(), result.assessment).selected).toBe('ASK_USER');
    if (mode === 'missing') expect(result.assessment.nextAction).not.toHaveProperty('confidence');
  });

  it('requires independent validation for premature FINISH', async () => {
    fetchMock.mockImplementation(async () => Response.json(routeBody('FINISH')));
    const result = await evaluateAgentState(state());
    expect(applyPolicy(state(), result.assessment).selected).toBe('RUN_TESTS');
    const validated = state();
    validated.tests = { ran: true, passed: true };
    validated.evidence!.validations = [{ iteration: 0, generation: 0, script: 'test', exitCode: 0, timedOut: false, passed: true, summary: 'passed' }];
    expect(applyPolicy(validated, result.assessment).selected).toBe('FINISH');
    validated.evidence!.validationGeneration = 1;
    expect(applyPolicy(validated, result.assessment).selected).toBe('RUN_TESTS');
  });

  it('enforces the selected worker and retains its independent call budget', async () => {
    const initial = state(); initial.workerSelection = 'codex';
    fetchMock.mockImplementation(async () => Response.json(routeBody('CALL_CLAUDE', 0.99)));
    const excluded = await evaluateAgentState(initial);
    expect(applyPolicy(initial, excluded.assessment)).toMatchObject({ selected: 'ASK_USER', override: true });
    expect(excluded.assessment.nextAction.confidence).toBe(0.99);
    fetchMock.mockImplementation(async () => Response.json(routeBody('CALL_CODEX', 0.99)));
    const permitted = await evaluateAgentState(initial);
    expect(applyPolicy(initial, permitted.assessment)).toMatchObject({ selected: 'CALL_CODEX', override: false });
    initial.codexCalls = 2;
    await expect(selectCandidate(applyPolicy(initial, permitted.assessment).selected, initial))
      .resolves.toMatchObject({ action: 'ASK_USER', reason: expect.stringContaining('call limit') });
    expect(initial.claudeCalls).toBe(0);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.state.progress.workers).toEqual({ selection: 'codex', allowedActions: ['CALL_CODEX'] });
  });

  it('gathers linked task context before a confident worker route', async () => {
    const initial = state();
    initial.task = 'https://github.com/example/project/issues/1';
    initial.repo.topLevelFiles.push('AGENTS.md');
    fetchMock.mockImplementation(async () => Response.json(routeBody('CALL_CODEX', 0.99)));
    const result = await evaluateAgentState(initial);
    expect(applyPolicy(initial, result.assessment).selected).toBe('READ_ISSUE');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).state.progress.taskPreparation)
      .toMatchObject({ issue: 'pending', unreadInstructions: ['AGENTS.md'], nextAction: 'READ_ISSUE' });
  });

  it('keeps model selection and budgets through explicit evaluation recovery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jev-provider-recovery-')); roots.push(root);
    const initial = state(); initial.repo.root = root; initial.workerSelection = 'codex'; initial.codexCalls = 1;
    fetchMock.mockResolvedValueOnce(new Response('not JSON'))
      .mockImplementation(async () => Response.json(routeBody()));
    const evaluate = createEvaluator();
    const recoverEvaluation = vi.fn(async () => {
      vi.stubEnv('ROUTER_PROVIDER', 'typesafe'); vi.stubEnv('ROUTER_MODEL', 'jev-latest');
      return 'continue' as const;
    });
    const approve = vi.fn(async () => ({ kind: 'stop' as const }));
    const execute = vi.fn();
    const result = await runOrchestration(initial, { evaluate, recoverEvaluation, approve, execute, askForInformation: async () => '' });
    expect(result).toMatchObject({ status: 'stopped', iterations: 2, state: { codexCalls: 1, claudeCalls: 0, workerSelection: 'codex' } });
    expect(recoverEvaluation).toHaveBeenCalledOnce(); expect(approve).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
    const trace = (await readFile(result.tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(trace[0]).toMatchObject({ failure: { code: 'invalid_response' }, approval: null });
    expect(trace.at(-1)).toMatchObject({ evaluation: { provider, requestedModel: model }, approval: { kind: 'stop' } });
    for (const [, init] of fetchMock.mock.calls) {
      expect(provider === 'vercel' ? new Headers(init?.headers).get('ai-model-id') : JSON.parse(String(init?.body)).model).toBe(model);
    }
  });

  it.each([
    ['missing boolean', (answers: Record<string, Record<string, unknown>>) => { delete answers.stuck; }],
    ['invalid probability', (answers: Record<string, Record<string, unknown>>) => { answers.stuck![provider === 'vercel' ? 'probability' : 'noul'] = 1.1; }],
    ['unknown action', (answers: Record<string, Record<string, unknown>>) => { answers.nextAction!.choice = 'DEPLOY'; }],
    ['bad distribution', (answers: Record<string, Record<string, unknown>>) => { answers.nextAction!.probabilities = { SEARCH_REPO: 0.1 }; }],
    ['unknown distribution key', (answers: Record<string, Record<string, unknown>>) => { answers.nextAction!.probabilities = { DEPLOY: 1 }; }],
    ['not highest probability', (answers: Record<string, Record<string, unknown>>) => { answers.nextAction!.choice = 'FINISH'; }],
  ] as const)('rejects %s without retrying', async (_label, mutate) => {
    const payload = routeBody();
    mutate(payload.answers as Record<string, Record<string, unknown>>);
    fetchMock.mockImplementation(async () => Response.json(payload));
    await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed confidence and JSON', async () => {
    const payload = routeBody();
    if (provider === 'vercel') payload.providerMetadata = { typesafe: { confidence: { nextAction: 'secret-value' } } };
    else (payload.answers as Record<string, Record<string, unknown>>).nextAction!.confidence = 'secret-value';
    fetchMock.mockImplementation(async () => Response.json(payload));
    await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'invalid_response' });
    fetchMock.mockImplementation(async () => new Response('not json'));
    await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([0.99, 1.01])('rejects probability sum %s with available diagnostics and no automatic retry', async (total) => {
    const payload = routeBody();
    const probabilities = Object.fromEntries(ACTIONS.map((action) => [action, action === 'SEARCH_REPO' ? 0.9 : action === 'READ_FILE' ? total - 0.9 : 0]));
    (payload.answers as Record<string, Record<string, unknown>>).nextAction!.probabilities = probabilities;
    fetchMock.mockImplementation(async () => Response.json(payload));
    await expect(evaluateAgentState(state())).rejects.toMatchObject({
      code: 'invalid_response', diagnostic: provider === 'vercel'
        ? { stage: 'answers', category: 'shape' }
        : { stage: 'distribution', category: 'sum', probabilitySum: total },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([[401, 'authentication'], [403, 'authorization'], [402, 'billing'], [404, 'model_unavailable'], [429, 'rate_limit'], [503, 'service_unavailable'], [529, 'service_unavailable']] as const)
    ('classifies HTTP %i safely with at most one transient retry', async (status, code) => {
      fetchMock.mockImplementation(async () => Response.json({ error: { code: status, message: `Free tier users do not have access to this model. ${keys.join(' ')}` } }, { status }));
      const failure = await evaluateAgentState(state()).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code });
      expect(fetchMock).toHaveBeenCalledTimes(status === 429 || status >= 500 ? 2 : 1);
      for (const key of keys) expect(String(failure)).not.toContain(key);
      if (status === 403) expect(String(failure)).toContain('valid key');
    });

  it('recovers on its single retry', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: 503 } }, { status: 503 }));
    fetchMock.mockResolvedValueOnce(Response.json(routeBody()));
    await expect(evaluateAgentState(state())).resolves.toMatchObject({ provider });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds chunked success and error bodies', async () => {
    for (const status of [200, 503]) {
      fetchMock.mockImplementation(async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_JEV_RESPONSE_BYTES));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }), { status }));
      await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('enforces the overall deadline even when the transport ignores abort', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const running = evaluateAgentState(state());
    const assertion = expect(running).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(JEV_EVALUATION_TIMEOUT_MS);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('does not invoke the transport with a pre-aborted signal', async () => {
    const controller = new AbortController(); controller.abort(keys[0]);
    await expect(evaluateAgentState(state(), undefined, { signal: controller.signal })).rejects.toThrow('Run interrupted.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels during retry backoff without another request', async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: { code: 503 } }, {
      status: 503, headers: { 'retry-after': '10' },
    }));
    const controller = new AbortController();
    const running = evaluateAgentState(state(), undefined, { signal: controller.signal });
    const assertion = expect(running).rejects.toThrow('Run interrupted.');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(keys[1]);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps retries and backoff inside one deadline', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => Response.json({ error: { code: 503 } }, {
      status: 503, headers: { 'retry-after': '60' },
    }));
    const running = evaluateAgentState(state());
    const assertion = expect(running).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(JEV_EVALUATION_TIMEOUT_MS);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds retries after a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError(`fetch failed ${keys.join(' ')}`));
    await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'request_failed' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fences late responses from approval and execution after cancellation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jev-provider-cancel-')); roots.push(root);
    const initial = state(); initial.repo.root = root;
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const controller = new AbortController();
    const approve = vi.fn(async () => ({ kind: 'approve' as const }));
    const execute = vi.fn();
    const running = runOrchestration(initial, {
      evaluate: (current, options) => evaluateAgentState(current, undefined, options), approve, execute,
      askForInformation: async () => '',
    }, { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort(keys[2]);
    expect(await running).toMatchObject({ status: 'stopped', iterations: 1 });
    resolveFetch(Response.json(routeBody()));
    await new Promise((resolve) => setImmediate(resolve));
    expect(approve).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

  it('redacts all keys in requests, CLI results, traces, and worker evidence and preserves attribution', async () => {
    respondRoute();
    const initial = state();
    initial.task += ` ${keys.join(' ')}`;
    initial.currentGoal = keys.join(' ');
    initial.observations = [keys.join(' ')];
    initial.evidence!.clarifications.push({ iteration: 1, text: keys.join(' ') });
    const result = await evaluateAgentState(initial);
    const policy = applyPolicy(initial, result.assessment);
    const output = createDecisionOutput(initial, result, policy, 'live');
    const root = await mkdtemp(path.join(os.tmpdir(), 'jev-provider-trace-')); roots.push(root);
    const tracePath = await writeTrace(root, { state: initial, evaluation: result, policy });
    const loopTrace = await createOrchestrationTrace(root);
    await appendOrchestrationTrace(loopTrace, {
      iteration: 1, stateBefore: initial, evaluation: result, policy,
      proposal: null, approval: null, toolInput: null, toolResult: null, stateAfter: initial,
    });
    const trace = await readFile(tracePath, 'utf8');
    const loop = await readFile(loopTrace.path, 'utf8');
    const worker = buildWorkerContext(initial);
    expect(JSON.stringify(worker)).toContain('[REDACTED]');
    for (const serialized of [String(fetchMock.mock.calls[0]?.[1]?.body), JSON.stringify(output), trace, loop, JSON.stringify(worker)]) {
      for (const key of keys) expect(serialized).not.toContain(key);
    }
    for (const attributed of [output, JSON.parse(trace).evaluation, JSON.parse(loop).evaluation]) {
      expect(attributed).toMatchObject({ provider, requestedModel: model });
      if (provider === 'vercel') expect(attributed).not.toHaveProperty('servedModel');
      else expect(attributed.servedModel).toBe(routeBody().model);
    }
  });

  it('cancels response reading and cleans up an unfinished stream', async () => {
    const cancelled = vi.fn();
    fetchMock.mockImplementation(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      cancel: cancelled,
    })));
    const controller = new AbortController();
    const running = evaluateAgentState(state(), undefined, { signal: controller.signal });
    const assertion = expect(running).rejects.toThrow('Run interrupted.');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort(keys[0]);
    await assertion;
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
  });
});

describe.each(routes.filter(({ provider }) => provider !== 'vercel'))('$provider $model native response contract', ({ provider, model, served }) => {
  beforeEach(() => {
    vi.stubEnv('JEV_PROVIDER', provider);
    vi.stubEnv('ROUTER_MODEL', model);
  });
  function nativeBody(): Record<string, unknown> { return { ...body(provider), model: served }; }

  it.each(Object.keys(EVALUATION_QUESTIONS))('rejects a missing or refused required %s answer without retry or raw text', async (name) => {
    for (const refused of [undefined, { type: 'refusal', refusal: keys.join(' ') }]) {
      const payload = nativeBody();
      const answers = payload.answers as Record<string, unknown>;
      if (refused === undefined) delete answers[name];
      else answers[name] = refused;
      fetchMock.mockImplementation(async () => Response.json(payload));
      const failure = await evaluateAgentState(state()).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'invalid_response' });
      for (const key of keys) expect(JSON.stringify(failure)).not.toContain(key);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['extra', 'renamed', 'array', 'direct predicate', 'top refusal', 'mixed refusal', 'mixed error'] as const)
    ('rejects %s answers instead of translating an incompatible wire format', async (kind) => {
      const payload = nativeBody();
      const answers = payload.answers as Record<string, Record<string, unknown>>;
      if (kind === 'extra') answers.unexpected = { type: 'noul', noul: 0 };
      if (kind === 'renamed') { answers.renamed = answers.stuck!; delete answers.stuck; }
      if (kind === 'array') payload.answers = Object.entries(answers).map(([name, answer]) => ({ name, ...answer }));
      if (kind === 'direct predicate') answers.stuck = { type: 'predicate', probability: 0 };
      if (kind === 'top refusal') payload.refusal = keys.join(' ');
      if (kind === 'mixed refusal') answers.stuck!.refusal = keys.join(' ');
      if (kind === 'mixed error') answers.nextAction!.error = { message: keys.join(' ') };
      fetchMock.mockImplementation(async () => Response.json(payload));
      await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'invalid_response' });
      expect(fetchMock).toHaveBeenCalledOnce();
    });

  it.each([
    ['envelope', (json: string) => json.replace('"answers":', '"answers":{},"answers":')],
    ['question', (json: string) => json.replace('"stuck":', '"stuck":{"type":"refusal"},"stuck":')],
    ['escaped question', (json: string) => json.replace('"stuck":', '"st\\u0075ck":{"type":"refusal"},"stuck":')],
    ['option', (json: string) => json.replace('"SEARCH_REPO":1', '"SEARCH_REPO":0,"SEARCH_REPO":1')],
    ['escaped option', (json: string) => json.replace('"SEARCH_REPO":1', '"SEARCH\\u005fREPO":0,"SEARCH_REPO":1')],
  ] as const)('rejects duplicate %s keys before JSON parsing can overwrite them', async (_label, duplicate) => {
    fetchMock.mockImplementation(async () => new Response(duplicate(JSON.stringify(nativeBody()))));
    await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'invalid_response', diagnostic: { stage: 'json', category: 'shape' } });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('accepts quoted/bracketed metadata strings without confusing them with duplicate keys', async () => {
    const payload = nativeBody();
    payload.usage = { note: '"stuck": {} [ ] \\ "SEARCH_REPO":0', values: [{ repeated: 0 }, { repeated: 1 }] };
    fetchMock.mockImplementation(async () => Response.json(payload));
    await expect(evaluateAgentState(state())).resolves.toMatchObject({ provider, requestedModel: model, servedModel: served });
  });

  it.each(['missing', 'array', 'extra', 'null', 'negative', 'string', 'nonfinite'] as const)
    ('rejects %s option distributions without repairing them', async (kind) => {
      const payload = nativeBody();
      const nextAction = (payload.answers as Record<string, Record<string, unknown>>).nextAction!;
      const probabilities = nextAction.probabilities as Record<string, unknown>;
      if (kind === 'missing') delete probabilities.FINISH;
      if (kind === 'array') nextAction.probabilities = Object.entries(probabilities).map(([value, probability]) => ({ value, probability }));
      if (kind === 'extra') probabilities.DEPLOY = 0;
      if (kind === 'null') probabilities.FINISH = null;
      if (kind === 'negative') probabilities.FINISH = -0.1;
      if (kind === 'string') probabilities.FINISH = '0';
      // JSON's numeric overflow reaches the decoder as Infinity.
      const json = JSON.stringify(payload);
      fetchMock.mockImplementation(async () => new Response(kind === 'nonfinite' ? json.replace('"FINISH":0', '"FINISH":1e999') : json));
      await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'invalid_response' });
      expect(fetchMock).toHaveBeenCalledOnce();
    });

  it.each([0.9995, 1.0005])('retains the existing sum tolerance without renormalizing %s', async (total) => {
    const payload = nativeBody();
    const nextAction = (payload.answers as Record<string, Record<string, unknown>>).nextAction!;
    nextAction.probabilities = Object.fromEntries(ACTIONS.map((action) => [action, action === 'SEARCH_REPO' ? total - 0.1 : action === 'READ_FILE' ? 0.1 : 0]));
    fetchMock.mockImplementation(async () => Response.json(payload));
    const result = await evaluateAgentState(state());
    expect(result.assessment.nextAction.probabilities.SEARCH_REPO).toBe(total - 0.1);
  });

  it.each([[401, 'authentication'], [403, 'authorization'], [402, 'billing'], [404, 'model_unavailable']] as const)
    ('keeps HTTP %s authoritative over conflicting provider codes', async (status, code) => {
      fetchMock.mockImplementation(async () => Response.json({ error: { code: 503, message: keys.join(' ') } }, { status }));
      await expect(evaluateAgentState(state())).rejects.toMatchObject({ code });
      expect(fetchMock).toHaveBeenCalledOnce();
    });

  it.each(['refusal', 'unrecognized', 123] as const)('safely rejects unknown HTTP 200 error type %s without retry', async (code) => {
    fetchMock.mockImplementation(async () => Response.json({ error: { code, message: keys.join(' ') } }));
    await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'request_failed' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses the credential alias when the canonical key is absent', async () => {
    vi.stubEnv(JEV_PROVIDERS[provider].credential, '');
    const aliasKey = provider === 'openrouter' ? keys[3] : keys[4];
    if (provider === 'openrouter') {
      vi.stubEnv('ROUTER_MODEL', '');
      vi.stubEnv('OPENROUTE_MODEL', model);
    }
    fetchMock.mockImplementation(async () => Response.json(nativeBody()));
    await expect(evaluateAgentState(state())).resolves.toMatchObject({ provider });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(`Bearer ${aliasKey}`);
  });

  it('requires the reported served model', async () => {
    const payload = nativeBody();
    delete payload.model;
    fetchMock.mockImplementation(async () => Response.json(payload));
    await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('classifies a typed upstream error carried inside HTTP 200', async () => {
    fetchMock.mockImplementation(async () => Response.json({
      error: { metadata: { error_type: 'insufficient_credits' }, message: keys.join(' ') },
    }));
    await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'billing' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('redacts the served model and additional answer fields', async () => {
    const payload = nativeBody();
    payload.model = keys[1];
    (payload.answers as Record<string, Record<string, unknown>>).nextAction![keys[2]!] = keys[0];
    fetchMock.mockImplementation(async () => Response.json(payload));
    const result = await evaluateAgentState(state());
    expect(result.servedModel).toBe('[REDACTED]');
    for (const key of keys) expect(JSON.stringify(result)).not.toContain(key);
  });
});
