import { describe, expect, it } from 'vitest';
import { EVALUATION_PROVIDERS, JEV_PROVIDERS, requireGatewayApiKey, resolveEvaluationConfiguration, resolveJevConfiguration } from './config.js';

describe('requireGatewayApiKey', () => {
  it('accepts a non-blank gateway key', () => {
    expect(() => requireGatewayApiKey({ AI_GATEWAY_API_KEY: 'test-key' })).not.toThrow();
  });

  it('rejects a missing or blank gateway key', () => {
    expect(() => requireGatewayApiKey({})).toThrow('AI_GATEWAY_API_KEY is required');
    expect(() => requireGatewayApiKey({ AI_GATEWAY_API_KEY: '   ' })).toThrow(
      'AI_GATEWAY_API_KEY is required',
    );
  });
});

describe('provider-neutral configuration', () => {
  it.each(['vercel', 'openrouter', 'typesafe'] as const)('accepts the new %s selector, its legacy alias, and an agreeing pair', (provider) => {
    const key = { [EVALUATION_PROVIDERS[provider].credential]: 'synthetic-selected-key' };
    const selected = resolveEvaluationConfiguration({ ...key, ROUTER_PROVIDER: provider });
    expect(selected.provider).toBe(provider);
    expect(resolveEvaluationConfiguration({ ...key, JEV_PROVIDER: provider })).toEqual(selected);
    expect(resolveEvaluationConfiguration({ ...key, ROUTER_PROVIDER: provider, JEV_PROVIDER: provider })).toEqual(selected);
    expect(Object.isFrozen(selected)).toBe(true);
  });

  it('retains the legacy resolver and provider settings as aliases', () => {
    expect(resolveJevConfiguration).toBe(resolveEvaluationConfiguration);
    expect(JEV_PROVIDERS).toBe(EVALUATION_PROVIDERS);
  });

  it.each([
    { ROUTER_PROVIDER: 'typesafe', JEV_PROVIDER: 'openrouter' },
    { ROUTER_PROVIDER: 'openrouter', JEV_PROVIDER: 'typesafe' },
  ])('rejects conflicting selectors before checking credentials: %j', (environment) => {
    expect(() => resolveEvaluationConfiguration(environment)).toThrow('ROUTER_PROVIDER and JEV_PROVIDER must agree');
  });

  it.each(['ROUTER_PROVIDER', 'JEV_PROVIDER'])('rejects malformed %s values without echoing them', (selector) => {
    for (const value of ['', ' typesafe ', 'unavailable-provider', 'private-selector-value']) {
      expect(() => resolveEvaluationConfiguration({ [selector]: value })).toThrow(`${selector} must be`);
    }
  });

  it.each([
    ['typesafe', 'jev-1.13.0'],
    ['openrouter', 'typesafe/jev-1.13'],
    ['openrouter', '~typesafe/jev-latest'],
    ['vercel', 'typesafe-ai/jev'],
  ] as const)('accepts a %s model in its namespace: %s', (provider, model) => {
    expect(resolveEvaluationConfiguration({ ROUTER_PROVIDER: provider,
      [EVALUATION_PROVIDERS[provider].credential]: 'key', ROUTER_MODEL: model }).model).toBe(model);
  });

  it.each([
    ['typesafe', 'typesafe-ai/jev'], ['typesafe', 'typesafe/jev-1.13'],
    ['openrouter', 'jev-latest'], ['vercel', 'jev-latest'], ['vercel', '~typesafe/jev-latest'],
    ['openrouter', 'https://private.test/model'], ['openrouter', 'vendor/../model'],
    ['typesafe', 'jev-private\nvalue'], ['typesafe', `jev-${'x'.repeat(253)}`],
  ] as const)('rejects an invalid %s namespace without echoing the model', (provider, model) => {
    try {
      resolveEvaluationConfiguration({ ROUTER_PROVIDER: provider,
        [EVALUATION_PROVIDERS[provider].credential]: 'key', ROUTER_MODEL: model });
      expect.fail('Expected model rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('ROUTER_MODEL must be');
      expect((error as Error).message).not.toContain(model);
    }
  });
});

describe('Cloudflare configuration', () => {
  const accountId = 'a'.repeat(32);
  const credentials = { CLOUDFLARE_AUTH_TOKEN: ' synthetic-cloudflare-token ', CLOUDFLARE_ACCOUNT_ID: accountId };

  it.each(['clef', 'clef-flash'])('selects %s using only the Cloudflare token and account', (model) => {
    expect(resolveEvaluationConfiguration({ ...credentials, ROUTER_PROVIDER: 'cloudflare', ROUTER_MODEL: model }))
      .toEqual({ provider: 'cloudflare', apiKey: 'synthetic-cloudflare-token', accountId, model });
  });

  it('defaults to clef and permits the agreeing compatibility selector', () => {
    expect(resolveEvaluationConfiguration({ ...credentials, ROUTER_PROVIDER: 'cloudflare', JEV_PROVIDER: 'cloudflare',
      OPENROUTE_MODEL: 'ignored/model' })).toEqual({ provider: 'cloudflare', apiKey: 'synthetic-cloudflare-token', accountId, model: 'clef' });
    expect(resolveEvaluationConfiguration({ ...credentials, JEV_PROVIDER: 'cloudflare' }).provider).toBe('cloudflare');
  });

  it.each([undefined, '', '../private', `${'a'.repeat(32)}/..`, 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33),
    `https://private.example/${'a'.repeat(32)}`, `${'a'.repeat(31)}\n`])('rejects an invalid account ID before a request: %j', (invalid) => {
    const environment: NodeJS.ProcessEnv = { ...credentials, ROUTER_PROVIDER: 'cloudflare', ...(invalid === undefined ? {} : { CLOUDFLARE_ACCOUNT_ID: invalid }) };
    if (invalid === undefined) delete environment.CLOUDFLARE_ACCOUNT_ID;
    expect(() => resolveEvaluationConfiguration(environment)).toThrow('CLOUDFLARE_ACCOUNT_ID must be');
  });

  it.each(['@cf/cloudflare/clef', 'other-model', 'clef/../clef-flash', 'clef?account=private', 'clef flash', 'https://private.example'])
    ('rejects model paths instead of the fixed selectors: %s', (model) => {
      expect(() => resolveEvaluationConfiguration({ ...credentials, ROUTER_PROVIDER: 'cloudflare', ROUTER_MODEL: model }))
        .toThrow('ROUTER_MODEL for cloudflare must be clef or clef-flash.');
    });

  it('rejects a missing token and conflicting provider without consulting another credential', () => {
    expect(() => resolveEvaluationConfiguration({ ROUTER_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: accountId, TYPESAFE_API_KEY: 'unrelated-key' }))
      .toThrow('CLOUDFLARE_AUTH_TOKEN is required');
    expect(() => resolveEvaluationConfiguration({ ...credentials, ROUTER_PROVIDER: 'cloudflare', JEV_PROVIDER: 'typesafe' }))
      .toThrow('must agree');
  });

  it('does not require or inspect Cloudflare settings for another provider', () => {
    expect(resolveEvaluationConfiguration({ TYPESAFE_API_KEY: 'key', CLOUDFLARE_ACCOUNT_ID: 'unused-invalid-value' }))
      .toEqual({ provider: 'typesafe', apiKey: 'key', model: 'jev-latest' });
  });
});

describe('resolveJevConfiguration', () => {
  it.each([
    ['vercel', 'AI_GATEWAY_API_KEY', 'typesafe-ai/jev'],
    ['openrouter', 'OPENROUTER_API_KEY', 'typesafe/jev-1.13'],
    ['typesafe', 'TYPESAFE_API_KEY', 'jev-latest'],
  ])('requires only the selected %s credential', (provider, credential, model) => {
    expect(resolveJevConfiguration({ JEV_PROVIDER: provider, [credential]: ' selected-key ' }))
      .toEqual({ provider, apiKey: 'selected-key', model });
    expect(() => resolveJevConfiguration({ JEV_PROVIDER: provider, [credential]: ' ' }))
      .toThrow(`${credential} is required`);
    expect(resolveJevConfiguration({ JEV_PROVIDER: provider, [credential]: 'key', ROUTER_MODEL: model }).model)
      .toBe(model);
  });

  it('defaults to direct TypeSafe and uses its default model for a blank override', () => {
    expect(resolveJevConfiguration({ TYPESAFE_AI_API_KEY: 'key', ROUTER_MODEL: '' })).toMatchObject({
      provider: 'typesafe', model: 'jev-latest',
    });
    expect(resolveJevConfiguration({ TYPESAFE_API_KEY: 'key' }).provider).toBe('typesafe');
  });

  it('accepts the supplied credential aliases and OpenRouter model alias', () => {
    expect(resolveJevConfiguration({
      JEV_PROVIDER: 'openrouter', OPENROUTE_API_KEY: ' alias-key ', OPENROUTE_MODEL: 'typesafe/jev-1.13',
    })).toEqual({ provider: 'openrouter', apiKey: 'alias-key', model: 'typesafe/jev-1.13' });
    expect(resolveJevConfiguration({
      JEV_PROVIDER: 'typesafe', TYPESAFE_AI_API_KEY: 'alias-key', OPENROUTE_MODEL: 'ignored/model',
    })).toEqual({ provider: 'typesafe', apiKey: 'alias-key', model: 'jev-latest' });
  });

  it('prefers canonical credentials and ROUTER_MODEL when both names are supplied', () => {
    expect(resolveJevConfiguration({
      JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'canonical-key', OPENROUTE_API_KEY: 'alias-key',
      ROUTER_MODEL: 'pinned/model', OPENROUTE_MODEL: 'alias/model',
    })).toEqual({ provider: 'openrouter', apiKey: 'canonical-key', model: 'pinned/model' });
  });

  it('rejects unknown selection and malformed model identifiers without echoing values', () => {
    expect(() => resolveJevConfiguration({ JEV_PROVIDER: 'secret-selector' })).toThrow('JEV_PROVIDER must be');
    expect(() => resolveJevConfiguration({ TYPESAFE_API_KEY: 'key', ROUTER_MODEL: 'secret model' })).toThrow('ROUTER_MODEL must be');
  });
});
