import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWorkerContext } from '../agents/context.js';
import { createDecisionOutput } from '../cli.js';
import { resolveEvaluationConfiguration } from '../config.js';
import { writeTrace } from '../logging/trace.js';
import { createInitialState, runOrchestration } from '../orchestration/loop.js';
import { applyPolicy } from '../policy.js';
import { ACTIONS, type Action } from '../types.js';
import { NATIVE_EVALUATION_QUESTIONS } from './contract.js';
import { evaluationFailure } from './errors.js';
import { createEvaluator, evaluateAgentState, EVALUATION_TIMEOUT_MS } from './evaluate.js';
import { MAX_EVALUATION_RESPONSE_BYTES } from './transport.js';

const accountId = 'a'.repeat(32);
const token = 'synthetic-cloudflare-secret-value';
const fetchMock = vi.fn<typeof fetch>();
const roots: string[] = [];

function state(root = '/synthetic-fixture') {
  return createInitialState({ root, packageManager: 'pnpm', scripts: ['test'], validationScripts: ['test'],
    gitStatus: [], topLevelFiles: ['README.md'] }, 'Inspect the fixture');
}

function answers(choice: Action = 'SEARCH_REPO', confidence: number | undefined = 0.99): Record<string, Record<string, unknown>> {
  return {
    taskComplete: { type: 'noul', noul: choice === 'FINISH' ? 0.99 : 0 },
    needsMoreInformation: { type: 'noul', noul: 0 }, needsTesting: { type: 'noul', noul: 0 }, stuck: { type: 'noul', noul: 0 },
    nextAction: { type: 'choice', choice, probabilities: Object.fromEntries(ACTIONS.map((action) => [action, action === choice ? 1 : 0])),
      ...(confidence === undefined ? {} : { confidence }),
    },
  };
}

function envelope(model: string, data = answers()) {
  return { success: true, errors: [], messages: [], result: { model, answers: data, usage: { input_tokens: 1, output_tokens: 0 } } };
}

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'jev-cloudflare-'));
  roots.push(root);
  return root;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('ROUTER_PROVIDER', 'cloudflare');
  vi.stubEnv('JEV_PROVIDER', undefined);
  vi.stubEnv('ROUTER_MODEL', '');
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', accountId);
  vi.stubEnv('CLOUDFLARE_AUTH_TOKEN', token);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.each(['clef', 'clef-flash'])('Cloudflare %s', (model) => {
  beforeEach(() => {
    vi.stubEnv('ROUTER_MODEL', model);
    fetchMock.mockImplementation(async () => Response.json(envelope(model)));
  });

  it('uses the fixed account/model path, shared questions, bounded state, and provider attribution', async () => {
    const initial = state();
    initial.workerSelection = 'codex';
    initial.task += ` ${token}`;
    const result = await evaluateAgentState(initial);
    expect(result).toMatchObject({ provider: 'cloudflare', requestedModel: model, servedModel: model, model });
    expect(applyPolicy(initial, result.assessment)).toMatchObject({ selected: 'SEARCH_REPO', override: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    const request = JSON.parse(String(init?.body));
    expect(request.model).toBe(model);
    expect(request.questions).toEqual(NATIVE_EVALUATION_QUESTIONS);
    expect(request.state.progress.workers).toEqual({ selection: 'codex', allowedActions: ['CALL_CODEX'] });
    expect(request.state).not.toHaveProperty('evidence');
    expect(String(init?.body)).not.toContain(token);
    expect(String(init?.body)).not.toContain(accountId);
  });

  it.each([undefined, 0.01])('preserves absent/low confidence (%s) and routes to ASK_USER', async (confidence) => {
    const data = answers();
    if (confidence === undefined) delete data.nextAction!.confidence;
    else data.nextAction!.confidence = confidence;
    fetchMock.mockResolvedValueOnce(Response.json(envelope(model, data)));
    const result = await evaluateAgentState(state());
    if (confidence === undefined) expect(result.assessment.nextAction).not.toHaveProperty('confidence');
    expect(applyPolicy(state(), result.assessment).selected).toBe('ASK_USER');
  });

  it('requires a clear distribution even with high reported confidence', async () => {
    const data = answers();
    data.nextAction!.probabilities = Object.fromEntries(ACTIONS.map((action) => [action,
      action === 'SEARCH_REPO' ? 0.4 : action === 'READ_FILE' || action === 'ASK_USER' ? 0.3 : 0]));
    fetchMock.mockResolvedValueOnce(Response.json(envelope(model, data)));
    expect(applyPolicy(state(), (await evaluateAgentState(state())).assessment).selected).toBe('ASK_USER');
  });

  it('permits a confident worker route and enforces an excluded worker and premature completion', async () => {
    const initial = state();
    initial.workerSelection = 'codex';
    fetchMock.mockResolvedValueOnce(Response.json(envelope(model, answers('CALL_CODEX'))))
      .mockResolvedValueOnce(Response.json(envelope(model, answers('CALL_CLAUDE'))))
      .mockResolvedValueOnce(Response.json(envelope(model, answers('FINISH'))));
    expect(applyPolicy(initial, (await evaluateAgentState(initial)).assessment).selected).toBe('CALL_CODEX');
    expect(applyPolicy(initial, (await evaluateAgentState(initial)).assessment).selected).toBe('ASK_USER');
    expect(applyPolicy(initial, (await evaluateAgentState(initial)).assessment).selected).toBe('RUN_TESTS');
  });

  it.each([
    ['missing question', (data: Record<string, Record<string, unknown>>) => { delete data.stuck; }],
    ['unexpected question', (data: Record<string, Record<string, unknown>>) => { data.privateQuestion = { type: 'noul', noul: 0 }; }],
    ['wrong type', (data: Record<string, Record<string, unknown>>) => { data.stuck!.type = 'boolean'; }],
    ['refusal', (data: Record<string, Record<string, unknown>>) => { data.nextAction = { type: 'refusal', refusal: 'private upstream text' }; }],
    ['invalid probability', (data: Record<string, Record<string, unknown>>) => { data.stuck!.noul = 2; }],
    ['invalid confidence', (data: Record<string, Record<string, unknown>>) => { data.nextAction!.confidence = 'private upstream text'; }],
    ['missing action', (data: Record<string, Record<string, unknown>>) => { data.nextAction!.probabilities = { SEARCH_REPO: 1 }; }],
    ['unknown action', (data: Record<string, Record<string, unknown>>) => { data.nextAction!.choice = 'private upstream text'; }],
    ['unknown option', (data: Record<string, Record<string, unknown>>) => { data.nextAction!.probabilities = { SEARCH_REPO: 1, PRIVATE: 0 }; }],
    ['nonmaximal choice', (data: Record<string, Record<string, unknown>>) => { data.nextAction!.choice = 'FINISH'; }],
  ])('rejects %s without retrying or exposing provider text', async (_name, mutate) => {
    const data = answers();
    mutate(data);
    fetchMock.mockResolvedValueOnce(Response.json(envelope(model, data)));
    const error: unknown = await evaluateAgentState(state()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'invalid_response' });
    expect(String(error)).not.toContain('private upstream text');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retains the sum diagnostic and tolerance without normalizing rejected or accepted distributions', async () => {
    const data = answers();
    data.nextAction!.probabilities = Object.fromEntries(ACTIONS.map((action) => [action, action === 'SEARCH_REPO' ? 0.99 : 0]));
    fetchMock.mockResolvedValueOnce(Response.json(envelope(model, data)));
    const error: unknown = await evaluateAgentState(state()).catch((error: unknown) => error);
    expect(evaluationFailure(error)).toEqual({ code: 'invalid_response', stage: 'distribution', category: 'sum', probabilitySum: 0.99 });
    data.nextAction!.probabilities = Object.fromEntries(ACTIONS.map((action) => [action, action === 'SEARCH_REPO' ? 0.9995 : 0]));
    fetchMock.mockResolvedValueOnce(Response.json(envelope(model, data)));
    expect((await evaluateAgentState(state())).assessment.nextAction.probabilities.SEARCH_REPO).toBe(0.9995);
  });

  it.each([
    ['missing success', { errors: [], result: { model, answers: answers() } }],
    ['inconsistent errors', { ...envelope(model), errors: [{ code: 5018, message: 'private upstream text' }] }],
    ['missing errors', { success: true, result: { model, answers: answers() } }],
    ['flat response', { model, answers: answers() }],
    ['missing result', { success: true, errors: [] }],
    ['invalid served model', { success: true, errors: [], result: { model: 'private upstream text', answers: answers() } }],
    ['missing served model', { success: true, errors: [], result: { answers: answers() } }],
    ['refused result', { ...envelope(model), result: { ...envelope(model).result, refusal: 'private upstream text' } }],
  ])('rejects an invalid envelope: %s', async (_name, data) => {
    fetchMock.mockResolvedValueOnce(Response.json(data));
    await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['question', 'escaped question', 'option', 'envelope'])('rejects duplicate %s names before JSON overwrites them', async (duplicate) => {
    const serialized = JSON.stringify(envelope(model));
    const response = duplicate === 'question' ? serialized.replace('"stuck":', '"stuck":{"type":"noul","noul":1},"stuck":')
      : duplicate === 'escaped question' ? serialized.replace('"stuck":', '"st\\u0075ck":{"type":"noul","noul":1},"stuck":')
      : duplicate === 'option' ? serialized.replace('"SEARCH_REPO":1', '"SEARCH_REPO":0,"SEARCH_REPO":1')
      : serialized.replace('"success":true', '"success":false,"success":true');
    fetchMock.mockResolvedValueOnce(new Response(response));
    await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'invalid_response', diagnostic: { stage: 'json' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts punctuation inside string values without treating it as object nesting', async () => {
    const data = { ...envelope(model), messages: ['value: "stuck": { [ \\ " } ]', 'unicode: \u2603'] };
    fetchMock.mockResolvedValueOnce(Response.json(data));
    await expect(evaluateAgentState(state())).resolves.toMatchObject({ provider: 'cloudflare' });
  });

  it('rejects malformed JSON and redirects without following the supplied location', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{'));
    await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'invalid_response', diagnostic: { stage: 'json' } });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 302, headers: { Location: 'https://private.example/collect' } }));
    await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'request_failed' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith('https://api.cloudflare.com/'))).toBe(true);
  });

  it.each([
    [401, 'authentication', 1], [403, 'authorization', 1], [402, 'billing', 1], [404, 'model_unavailable', 1],
    [429, 'rate_limit', 2], [503, 'service_unavailable', 2],
  ])('classifies HTTP %s as %s with bounded retries', async (status, code, calls) => {
    fetchMock.mockImplementation(async () => new Response('private upstream text', { status }));
    const error: unknown = await evaluateAgentState(state()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain('private upstream text');
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith('https://api.cloudflare.com/'))).toBe(true);
  });

  it.each([[5007, 400, 'model_unavailable'], [3042, 200, 'model_unavailable'], [5018, 200, 'authorization'],
    [3036, 200, 'rate_limit'], [3007, 200, 'timeout'], [99999, 200, 'request_failed']])
    ('classifies documented code %s in HTTP %s as %s', async (code, status, expected) => {
      fetchMock.mockImplementation(async () => Response.json({ success: false, errors: [{ code, message: 'private upstream text' }] }, { status }));
      const error: unknown = await evaluateAgentState(state()).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: expected });
      expect(String(error)).not.toContain('private upstream text');
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
    });

  it('retries a transient failure once using the same frozen account, model, and token', async () => {
    const configuration = { provider: 'cloudflare' as const, model, accountId, apiKey: token };
    const evaluate = createEvaluator(configuration);
    configuration.model = model === 'clef' ? 'clef-flash' : 'clef';
    configuration.accountId = 'b'.repeat(32);
    configuration.apiKey = 'replacement-token';
    vi.stubEnv('ROUTER_PROVIDER', 'typesafe');
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'c'.repeat(32));
    vi.stubEnv('CLOUDFLARE_AUTH_TOKEN', 'replacement-token');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockImplementation(async () => Response.json(envelope(model)));
    await expect(evaluate(state())).resolves.toMatchObject({ provider: 'cloudflare', requestedModel: model });
    await expect(evaluate(state())).resolves.toMatchObject({ provider: 'cloudflare', requestedModel: model });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    }
  });

  it('bounds success and error responses before parsing', async () => {
    for (const status of [200, 503]) {
      fetchMock.mockResolvedValueOnce(new Response('x'.repeat(MAX_EVALUATION_RESPONSE_BYTES + 1), { status }));
      await expect(evaluateAgentState(state())).rejects.toMatchObject({ code: 'invalid_response', diagnostic: { stage: 'transport', category: 'size' } });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('enforces the shared deadline while the transport ignores cancellation', async () => {
    vi.useFakeTimers();
    fetchMock.mockReturnValue(new Promise(() => {}));
    const running = evaluateAgentState(state());
    const assertion = expect(running).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(EVALUATION_TIMEOUT_MS);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps retry backoff inside the same deadline', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
    const running = evaluateAgentState(state());
    const assertion = expect(running).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(EVALUATION_TIMEOUT_MS);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fetch after a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createEvaluator()(state(), { signal: controller.signal })).rejects.toThrow('Run interrupted.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels an unfinished stream and stops retry backoff before another fetch', async () => {
    const cancelled = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel: cancelled,
    })));
    const controller = new AbortController();
    const pending = evaluateAgentState(state(), undefined, { signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow('Run interrupted.');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await assertion;
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));

    fetchMock.mockResolvedValueOnce(new Response('', { status: 429 }));
    const stop = new AbortController();
    const retry = evaluateAgentState(state(), undefined, { signal: stop.signal });
    const retryAssertion = expect(retry).rejects.toThrow('Run interrupted.');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    stop.abort();
    await retryAssertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('redacts tokens from CLI results, traces, worker evidence, and served-model strings', async () => {
    const initial = state();
    initial.task += ` ${token}`;
    initial.evidence!.clarifications.push({ iteration: 1, text: token });
    const data = answers();
    data.nextAction!.note = token;
    fetchMock.mockResolvedValueOnce(Response.json(envelope(`clef-${token}`, data)));
    const result = await evaluateAgentState(initial);
    const policy = applyPolicy(initial, result.assessment);
    const output = createDecisionOutput(initial, result, policy, 'live');
    const trace = await writeTrace(await temporaryRoot(), { state: initial, evaluation: result, policy });
    for (const serialized of [JSON.stringify(output), JSON.stringify(result), await readFile(trace, 'utf8'), JSON.stringify(buildWorkerContext(initial))]) {
      expect(serialized).not.toContain(token);
    }
    expect(result.servedModel).toBe('clef-[REDACTED]');
  });

  it('retains budgets and selection through explicit evaluation recovery before a fresh approval', async () => {
    const initial = state(await temporaryRoot());
    initial.workerSelection = 'codex';
    const invalid = answers();
    invalid.nextAction!.probabilities = Object.fromEntries(ACTIONS.map((action) => [action, 0]));
    fetchMock.mockResolvedValueOnce(Response.json(envelope(model, invalid)))
      .mockResolvedValueOnce(Response.json(envelope(model)));
    const evaluate = createEvaluator(resolveEvaluationConfiguration());
    const approve = vi.fn().mockResolvedValue({ kind: 'stop' });
    const execute = vi.fn();
    const recoverEvaluation = vi.fn().mockImplementation(async () => {
      vi.stubEnv('ROUTER_PROVIDER', 'typesafe');
      vi.stubEnv('ROUTER_MODEL', 'jev-latest');
      return 'continue';
    });
    const result = await runOrchestration(initial, { evaluate, approve, execute, recoverEvaluation,
      askForInformation: async () => 'No context required',
    });
    expect(result).toMatchObject({ status: 'stopped', iterations: 2, state: { codexCalls: 0, claudeCalls: 0, workerSelection: 'codex' } });
    expect(recoverEvaluation).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    const trace = (await readFile(result.tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(trace[0]).toMatchObject({ failure: { code: 'invalid_response', stage: 'distribution', category: 'sum', probabilitySum: 0 }, approval: null });
    expect(trace.at(-1)).toMatchObject({ evaluation: { provider: 'cloudflare', requestedModel: model }, approval: { kind: 'stop' } });
  });

  it('fences late provider responses from approval and execution after cancellation', async () => {
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
    const approve = vi.fn();
    const execute = vi.fn();
    const controller = new AbortController();
    const result = runOrchestration(state(await temporaryRoot()), { evaluate: createEvaluator(), approve, execute,
      askForInformation: async () => 'No context required',
    }, { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort('private interruption reason');
    const stopped = await result;
    expect(stopped.status).toBe('stopped');
    resolveFetch(Response.json(envelope(model)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(approve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    const trace = JSON.parse((await readFile(stopped.tracePath, 'utf8')).trim());
    expect(trace).toMatchObject({ evaluation: null, approval: null, toolResult: null, interruption: { phase: 'evaluation' } });
  });
});

it.each(['../account', '', 'a'.repeat(33)])('rejects malformed programmatic account configuration: %s', (invalid) => {
  expect(() => createEvaluator({ provider: 'cloudflare', model: 'clef', accountId: invalid, apiKey: token }))
    .toThrow('CLOUDFLARE_ACCOUNT_ID must be');
  expect(fetchMock).not.toHaveBeenCalled();
});
