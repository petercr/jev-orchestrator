# Jev Orchestrator

A deliberately small Node/TypeScript experiment for testing whether
`typesafe-ai/jev` can make useful next-step decisions around a coding agent.

The current milestone is **decision-only**. It inspects a repository, sends a
compact state object to Jev through Vercel AI Gateway, applies deterministic
policy thresholds, prints the result, and records a JSONL trace. It does not yet
edit files, execute tests, or call Codex.

## Requirements

- Node.js 22+
- pnpm
- A Vercel AI Gateway key for live mode

## Setup

```bash
pnpm install
cp .env.example .env
```

Add your key to `.env`, then use Node's env-file support to load it:

```bash
pnpm exec node --env-file=.env --import tsx src/cli.ts -- \
  . "Inspect this repo and choose the safest useful first action"
```

Never commit `.env`; it is ignored by git.

## Run

First verify the full local flow without spending tokens:

```bash
pnpm dev -- . "Inspect this repo and choose the safest useful first action" --mock
```

Then run the live Jev evaluation with the key from `.env`:

```bash
pnpm exec node --env-file=.env --import tsx src/cli.ts -- \
  . "Inspect this repo and choose the safest useful first action"
```

After exporting `AI_GATEWAY_API_KEY`, the shorter command works as well. Against
another repository:

```bash
pnpm dev -- ../my-app "Fix the preview route returning 401 in production"
```

## Verify

```bash
pnpm check
pnpm test
pnpm build
```

## Current safety boundary

This version is read-only except for trace files written under `./traces` in
the directory where the CLI is launched. The policy refuses to finish a task
until validation has passed and routes ambiguous decisions to `ASK_USER`.
Live Jev evaluations allow standard Gateway data retention
(`zeroDataRetention: false`); run them only with repository data you authorize
for that service.

## Next milestone

Add an approval-gated loop with constrained implementations of:

1. `SEARCH_REPO`
2. `READ_FILE`
3. `RUN_TESTS`
4. `CALL_CODEX`

The hard rules remain authoritative: no deploy, publish, push, destructive git,
filesystem writes outside the selected repository, or secret access.
