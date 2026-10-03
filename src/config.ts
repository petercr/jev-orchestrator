import type { JevProvider } from './types.js';

export const JEV_PROVIDERS = {
  vercel: { credential: 'AI_GATEWAY_API_KEY', credentialAliases: [], model: 'typesafe-ai/jev' },
  openrouter: { credential: 'OPENROUTER_API_KEY', credentialAliases: ['OPENROUTE_API_KEY'], model: 'typesafe/jev-1.13' },
  typesafe: { credential: 'TYPESAFE_API_KEY', credentialAliases: ['TYPESAFE_AI_API_KEY'], model: 'jev-latest' },
} as const;

export type JevConfiguration = {
  provider: JevProvider;
  model: string;
  apiKey: string;
};

export function resolveJevConfiguration(environment: NodeJS.ProcessEnv = process.env): JevConfiguration {
  const selector = environment.JEV_PROVIDER ?? 'typesafe';
  if (selector !== 'vercel' && selector !== 'openrouter' && selector !== 'typesafe') {
    throw new Error('JEV_PROVIDER must be vercel, openrouter, or typesafe.');
  }
  const settings = JEV_PROVIDERS[selector];
  const apiKey = [settings.credential, ...settings.credentialAliases]
    .map((name) => environment[name]?.trim())
    .find((value) => Boolean(value));
  if (!apiKey) {
    throw new Error(
      `${settings.credential} is required for live Jev evaluation with ${selector}.${settings.credentialAliases.length > 0 ? ` Accepted alias: ${settings.credentialAliases.join(', ')}.` : ''} Add it to .env and run Node with --env-file=.env, or export it before running the CLI.`,
    );
  }
  const model = environment.ROUTER_MODEL?.trim() ||
    (selector === 'openrouter' ? environment.OPENROUTE_MODEL?.trim() : undefined) || settings.model;
  if (model.length > 256 || /[\s\x00-\x1f\x7f]/.test(model)) {
    throw new Error('ROUTER_MODEL must be a model identifier of at most 256 characters without whitespace.');
  }
  return { provider: selector, model, apiKey };
}

export function requireGatewayApiKey(environment: NodeJS.ProcessEnv = process.env): void {
  resolveJevConfiguration({ ...environment, JEV_PROVIDER: 'vercel' });
}
