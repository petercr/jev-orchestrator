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

Each live evaluation has a 10-second deadline and at most one retry for a
transient Gateway failure. The CLI reports authentication, rate-limit,
unavailable-model, timeout, and malformed-response failures without printing
Gateway response data.

## Inspection bounds

The target must be an existing directory. Repository inspection is read-only
and bounds the task to 4,000 characters, package metadata to 64 KiB, and Git
output and snapshot lists to small fixed limits before sending state to Jev.
Malformed or oversized `package.json` files and non-Git directories are handled
as incomplete metadata rather than causing a model request to fail.

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

## Entire Cloud trails and reviews

Entire is enabled for this repository and syncs Codex checkpoints to the
configured remote. The checked-in `.entire/runners/` definitions run in Entire
Cloud: they produce a change summary, confidence, drift, risk, and security
signals, plus line-level review findings. They use read-only repository access
and are triggered from Trail push events; no local `entire review` command or
local model is part of this workflow.

Create a Trail for a branch before pushing its changes:

```bash
entire trail create --title "Describe the change" --type task
```

Review the summary, monitors, and findings in Entire Cloud. The default runner
definitions are intentionally generic; tailor them in a future reviewed change
once the repository has enough conventions to encode.

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
