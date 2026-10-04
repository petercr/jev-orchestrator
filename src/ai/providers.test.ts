import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDecisionOutput } from '../cli.js';
import { JEV_PROVIDERS } from '../config.js';
import { buildWorkerContext } from '../agents/context.js';
import { appendOrchestrationTrace, createOrchestrationTrace, writeTrace } from '../logging/trace.js';
import { createInitialState, runOrchestration } from '../orchestration/loop.js';
import { applyPolicy } from '../policy.js';
import { ACTIONS, type Action, type JevProvider } from '../types.js';
import { EVALUATION_QUESTIONS } from './contract.js';
import { evaluateAgentState, JEV_EVALUATION_TIMEOUT_MS } from './evaluate.js';
import { NATIVE_JEV_ENDPOINTS } from './native.js';
import { MAX_JEV_RESPONSE_BYTES } from './transport.js';

const providers: JevProvider[] = ['vercel', 'openrouter', 'typesafe'];
const roots: string[] = [];
const fetchMock = vi.fn<typeof fetch>();
const keys = [
  'gateway-secret-value', 'openrouter-secret-value', 'typesafe-secret-value',
  'openroute-alias-secret-value', 'typesafe-alias-secret-value',
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
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('ROUTER_MODEL', '');
  vi.stubEnv('AI_GATEWAY_API_KEY', keys[0]);
  vi.stubEnv('OPENROUTER_API_KEY', keys[1]);
  vi.stubEnv('TYPESAFE_API_KEY', keys[2]);
  vi.stubEnv('OPENROUTE_API_KEY', keys[3]);
  vi.stubEnv('TYPESAFE_AI_API_KEY', keys[4]);
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

describe.each(providers)('%s evaluation transport', (provider) => {
  beforeEach(() => vi.stubEnv('JEV_PROVIDER', provider));

  it('preserves the questions, normalizes answers, attributes models, and permits a confident route', async () => {
    respond(provider);
    const result = await evaluateAgentState(state());
    expect(result).toMatchObject({ provider, model: JEV_PROVIDERS[provider].model, requestedModel: JEV_PROVIDERS[provider].model });
    if (provider !== 'vercel') expect(result.servedModel).toBe(body(provider).model);
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
    vi.stubEnv('ROUTER_MODEL', 'pinned-model');
    respond(provider);
    const result = await evaluateAgentState(state());
    expect(result.requestedModel).toBe('pinned-model');
    const init = fetchMock.mock.calls[0]?.[1];
    expect(provider === 'vercel' ? new Headers(init?.headers).get('ai-model-id') : JSON.parse(String(init?.body)).model).toBe('pinned-model');
  });

  it.each(['ambiguous', 'missing'] as const)('routes %s confidence to ASK_USER', async (mode) => {
    const payload = body(provider, 'SEARCH_REPO', mode === 'ambiguous' ? 0.1 : undefined);
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
    respond(provider, 'FINISH');
    const result = await evaluateAgentState(state());
    expect(applyPolicy(state(), result.assessment).selected).toBe('RUN_TESTS');
    const validated = state();
    validated.tests = { ran: true, passed: true };
    validated.evidence!.validations = [{ iteration: 0, generation: 0, script: 'test', exitCode: 0, timedOut: false, passed: true, summary: 'passed' }];
    expect(applyPolicy(validated, result.assessment).selected).toBe('FINISH');
  });

  it.each([
    ['missing boolean', (answers: Record<string, Record<string, unknown>>) => { delete answers.stuck; }],
    ['invalid probability', (answers: Record<string, Record<string, unknown>>) => { answers.stuck![provider === 'vercel' ? 'probability' : 'noul'] = 1.1; }],
    ['unknown action', (answers: Record<string, Record<string, unknown>>) => { answers.nextAction!.choice = 'DEPLOY'; }],
    ['bad distribution', (answers: Record<string, Record<string, unknown>>) => { answers.nextAction!.probabilities = { SEARCH_REPO: 0.1 }; }],
    ['unknown distribution key', (answers: Record<string, Record<string, unknown>>) => { answers.nextAction!.probabilities = { DEPLOY: 1 }; }],
    ['not highest probability', (answers: Record<string, Record<string, unknown>>) => { answers.nextAction!.choice = 'FINISH'; }],
  ] as const)('rejects %s without retrying', async (_label, mutate) => {
    const payload = body(provider);
    mutate(payload.answers as Record<string, Record<string, unknown>>);
    fetchMock.mockImplementation(async () => Response.json(payload));
    await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed confidence and JSON', async () => {
    const payload = body(provider);
    if (provider === 'vercel') payload.providerMetadata = { typesafe: { confidence: { nextAction: 'secret-value' } } };
    else (payload.answers as Record<string, Record<string, unknown>>).nextAction!.confidence = 'secret-value';
    fetchMock.mockImplementation(async () => Response.json(payload));
    await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'invalid_response' });
    fetchMock.mockImplementation(async () => new Response('not json'));
    await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([0.99, 1.01])('rejects probability sum %s with available diagnostics and no automatic retry', async (total) => {
    const payload = body(provider);
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
    fetchMock.mockResolvedValueOnce(Response.json(body(provider)));
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
    resolveFetch(Response.json(body(provider)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(approve).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

  it('redacts all keys in requests, CLI results, traces, and worker evidence and preserves attribution', async () => {
    respond(provider);
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
      expect(attributed).toMatchObject({ provider, requestedModel: JEV_PROVIDERS[provider].model });
      if (provider === 'vercel') expect(attributed).not.toHaveProperty('servedModel');
      else expect(attributed.servedModel).toBe(body(provider).model);
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

describe.each(['openrouter', 'typesafe'] as const)('%s native response contract', (provider) => {
  beforeEach(() => vi.stubEnv('JEV_PROVIDER', provider));

  it('uses the credential alias when the canonical key is absent', async () => {
    vi.stubEnv(JEV_PROVIDERS[provider].credential, '');
    const aliasKey = provider === 'openrouter' ? keys[3] : keys[4];
    if (provider === 'openrouter') vi.stubEnv('OPENROUTE_MODEL', 'typesafe/jev-1.13');
    respond(provider);
    await expect(evaluateAgentState(state())).resolves.toMatchObject({ provider });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(`Bearer ${aliasKey}`);
  });

  it('requires the reported served model', async () => {
    const payload = body(provider);
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
    const payload = body(provider);
    payload.model = keys[1];
    (payload.answers as Record<string, unknown>)[keys[2]!] = keys[0];
    fetchMock.mockImplementation(async () => Response.json(payload));
    const result = await evaluateAgentState(state());
    expect(result.servedModel).toBe('[REDACTED]');
    for (const key of keys) expect(JSON.stringify(result)).not.toContain(key);
  });
});
