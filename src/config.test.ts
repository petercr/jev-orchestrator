import { describe, expect, it } from 'vitest';
import { requireGatewayApiKey, resolveJevConfiguration } from './config.js';

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
    expect(resolveJevConfiguration({ JEV_PROVIDER: provider, [credential]: 'key', ROUTER_MODEL: 'pinned/model' }).model)
      .toBe('pinned/model');
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
