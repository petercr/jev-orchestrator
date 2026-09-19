export function requireGatewayApiKey(environment: NodeJS.ProcessEnv = process.env): void {
  if (!environment.AI_GATEWAY_API_KEY?.trim()) {
    throw new Error(
      'AI_GATEWAY_API_KEY is required for live Jev evaluation. Add it to .env and run Node with --env-file=.env, or export it before running the CLI.',
    );
  }
}
