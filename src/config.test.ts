import { describe, expect, it } from 'vitest';
import { requireGatewayApiKey } from './config.js';

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
