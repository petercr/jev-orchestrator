import type { EvaluationProvider } from './types.js';

export const EVALUATION_PROVIDERS = {
  vercel: { credential: 'AI_GATEWAY_API_KEY', credentialAliases: [], model: 'typesafe-ai/jev' },
  openrouter: { credential: 'OPENROUTER_API_KEY', credentialAliases: ['OPENROUTE_API_KEY'], model: 'typesafe/jev-1.13' },
  typesafe: { credential: 'TYPESAFE_API_KEY', credentialAliases: ['TYPESAFE_AI_API_KEY'], model: 'jev-latest' },
} as const;

export type EvaluationConfiguration = Readonly<{
  provider: EvaluationProvider;
  model: string;
  apiKey: string;
}>;

function providerSelector(value: string | undefined, name: string): EvaluationProvider | undefined {
  if (value === undefined) return undefined;
  if (value !== 'vercel' && value !== 'openrouter' && value !== 'typesafe') {
    throw new Error(`${name} must be vercel, openrouter, or typesafe.`);
  }
  return value;
}

/** Validate identifier syntax in the transport's namespace, not account access. */
export function validateEvaluationModel(provider: EvaluationProvider, model: string): void {
  const qualifiedModel = /^[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
  const valid = provider === 'typesafe' ? /^jev-[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model)
    : qualifiedModel.test(provider === 'openrouter' && model.startsWith('~') ? model.slice(1) : model);
  if (model.length > 256 || !valid) {
    throw new Error(`ROUTER_MODEL must be a model identifier in the ${provider} namespace, at most 256 characters: ${provider === 'typesafe' ? 'jev-latest or jev-<version>' : `${provider === 'openrouter' ? 'optional ~ followed by ' : ''}vendor/model`}.`);
  }
}

export function resolveEvaluationProvider(environment: NodeJS.ProcessEnv = process.env): EvaluationProvider {
  const canonical = providerSelector(environment.ROUTER_PROVIDER, 'ROUTER_PROVIDER');
  const legacy = providerSelector(environment.JEV_PROVIDER, 'JEV_PROVIDER');
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy) {
    throw new Error('ROUTER_PROVIDER and JEV_PROVIDER must agree when both are supplied.');
  }
  return canonical ?? legacy ?? 'typesafe';
}

export function resolveEvaluationConfiguration(environment: NodeJS.ProcessEnv = process.env): EvaluationConfiguration {
  const selector = resolveEvaluationProvider(environment);
  const settings = EVALUATION_PROVIDERS[selector];
  const apiKey = [settings.credential, ...settings.credentialAliases]
    .map((name) => environment[name]?.trim())
    .find((value) => Boolean(value));
  if (!apiKey) {
    throw new Error(
      `${settings.credential} is required for live evaluation with ${selector}.${settings.credentialAliases.length > 0 ? ` Accepted alias: ${settings.credentialAliases.join(', ')}.` : ''} Export it or load it with Varlock before running the CLI.`,
    );
  }
  const model = environment.ROUTER_MODEL?.trim() ||
    (selector === 'openrouter' ? environment.OPENROUTE_MODEL?.trim() : undefined) || settings.model;
  validateEvaluationModel(selector, model);
  return Object.freeze({ provider: selector, model, apiKey });
}

// Compatibility exports for existing integrations.
export const JEV_PROVIDERS = EVALUATION_PROVIDERS;
export type JevConfiguration = EvaluationConfiguration;
export const resolveJevConfiguration = resolveEvaluationConfiguration;

export function requireGatewayApiKey(environment: NodeJS.ProcessEnv = process.env): void {
  resolveEvaluationConfiguration({ ...environment, ROUTER_PROVIDER: 'vercel', JEV_PROVIDER: 'vercel' });
}
