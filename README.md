# Jev Orchestrator

A deliberately small Node/TypeScript experiment for testing whether
`typesafe-ai/jev` can make useful next-step decisions around a coding agent.

The default mode remains **decision-only**: it inspects a repository, sends a
compact state object to Jev through Vercel AI Gateway, applies deterministic
policy thresholds, prints the result, and records a JSONL trace. The explicit
`--orchestrate` mode adds a bounded, manually approved loop for safe repository
searches, bounded file reads, and detected validation scripts. It cannot edit
files, run arbitrary commands, or call a coding agent.

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

Then exercise the approval loop without spending tokens. Every iteration shows
the Jev distribution, policy result, resolved tool and parameters, and allowed
choices before prompting:

```bash
pnpm dev -- . "Inspect this repo and choose the safest useful first action" \
  --mock --orchestrate
```

Enter `approve`, `reject`, or an allowed action name. Choosing another action
resolves and presents its safe candidate before a second approval prompt.

Then run the live Jev evaluation with the key from `.env`:

```bash
pnpm exec node --env-file=.env --import tsx src/cli.ts -- \
  . "Inspect this repo and choose the safest useful first action"
```

Each live evaluation has a 10-second deadline and at most one retry for a
transient Gateway failure. The CLI reports authentication, rate-limit,
unavailable-model, timeout, and malformed-response failures without printing
Gateway response data.

## CLI contract

Without `--orchestrate`, every successful run prints an **unexecuted** decision.
With it, the CLI enters the manually approved loop described below. Neither
mode invokes a coding agent.

```bash
jev-agent <repo-path> <task> [--mock] [--no-trace] [--json] [--orchestrate]
```

- `--mock` uses the offline deterministic evaluation.
- `--no-trace` suppresses a decision-only JSONL trace file.
- `--json` writes exactly one normalized, machine-readable decision object to
  stdout. It includes the repository snapshot, task, assessment, deterministic
  policy decision, model name, latency, and optional trace path. It omits raw
  provider answers and provider metadata.
- `--orchestrate` enters the interactive loop. It cannot be combined with
  `--json` or `--no-trace`; orchestration always records its safety trace.
- `--version` prints the installed package version; `--help` (or `-h`) prints
  usage.

For example, a token-free machine-readable run is:

```bash
pnpm dev -- . "Inspect this repo and choose the safest useful first action" \
  --mock --no-trace --json
```

Exit code `0` means a decision, completed loop status, help text, or version was
printed. Exit code `1` means an operational failure prevented progress; exit
code `2` means invalid command-line usage. In `--json` mode, errors are one JSON
object on stderr with the same exit code.

## Traces

Unless `--no-trace` is set, each successful decision writes one JSONL record
under `./traces/`. Decision records use trace schema version `1` and a
timestamp-plus-UUID run ID, so concurrent runs do not share a file. A record contains a
sanitized state snapshot, normalized assessment, policy decision, model,
latency, and bounded raw Jev answers. It deliberately excludes raw provider
metadata and upstream error bodies; known credential values and common
credential-shaped fields are redacted before writing.

Orchestration writes schema-version `2` JSONL under the selected repository's
`traces/` directory. Every completed iteration records bounded, redacted raw
answers, normalized assessment, policy decision, all considered and selected
candidates, approval decision, tool input and result, exit status, duration,
and the before/after state. A rejection records an observation and executes no
repository tool.

Trace recording is part of the default auditable run. If the trace directory
cannot be created or written, the CLI returns operational exit code `1` and
does not print a decision. Use `--no-trace` only when an unrecorded
decision-only result is acceptable; the execution loop cannot disable traces.

## Inspection and execution bounds

The target must be an existing directory. Repository inspection is read-only
and bounds the task to 4,000 characters, package metadata to 64 KiB, and Git
output and snapshot lists to small fixed limits before sending state to Jev.
Malformed or oversized `package.json` files and non-Git directories are handled
as incomplete metadata rather than causing a model request to fail.

Orchestration has a hard eight-iteration ceiling. Search uses direct `rg`
arguments, literal bounded terms derived from the task, bounded file results,
and exclusions for Git metadata, dependencies, build output, traces, and common
secret files. Reads are limited to regular files below the selected root,
reject traversal and symlink escape, block common credential paths, and cap
content at 64 KiB. Validation can invoke only a recognized `test`, `check`,
`typecheck`, `lint`, or `build` package script through the package manager
detected from a lockfile. Process output and runtime are bounded.

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

The test suite is offline: it uses temporary repositories and mocked AI SDK
boundaries, so it does not require `AI_GATEWAY_API_KEY`, a coding agent, or a
live Jev evaluation. Pull-request CI runs the same typecheck, test, and build
commands for maintainers.

## Packaged CLI verification

The tarball contains the compiled runtime JavaScript and declarations under
`dist/`, plus the README and license. Test sources and compiled test files are
not published. The `prepack` lifecycle runs the production build before a
tarball is created.

To verify the package in your own separate project, first create a tarball from
this repository:

```bash
pnpm pack --out /absolute/path/to/jev-orchestrator-%v.tgz
```

Then, from the other project, install that exact archive and run the installed
binary against that project:

```bash
pnpm add --save-dev /absolute/path/to/jev-orchestrator-0.1.0.tgz
pnpm exec jev-agent --version
pnpm exec jev-agent . "Inspect this repository and choose the safest useful first action" \
  --mock --no-trace --json
```

The expected mock result is one JSON object with `status: "unexecuted"`; it
must not edit the target project or require an API key. Do not pack or publish
`.env`, traces, build cache, or `node_modules`.

## Continuous integration

The `Verify` workflow runs on pull requests targeting `main` from the trusted
`main` workflow definition. It uses no Gateway credentials and runs
`pnpm check`, `pnpm test`, and `pnpm build` only when GitHub reports the PR
author has effective `write` or `admin` repository permission. The permission
check itself does not check out or execute PR code; only after it passes does
the workflow check out the PR head without persisted credentials. For everyone
else, verification is skipped.

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

Decision-only mode is read-only except for its trace file. Orchestration is
read-only except for trace files and side effects inherent in an explicitly
approved validation script. The policy refuses to finish a task until a
detected validation script has passed, routes high missing-information or stuck
signals to `ASK_USER`, and does the same for ambiguous next actions. If
validation fails or none is available, the policy asks the user rather than
assuming completion or blindly retrying it. An identical failed candidate is
not retried without new user information.

`RUN_COMMAND` and `CALL_CODEX` remain non-executable. The loop never evaluates
model-generated shell text, deploys, publishes, pushes, performs destructive
Git operations, deletes files, or reads known secret-file paths.
Live Jev evaluations allow standard Gateway data retention
(`zeroDataRetention: false`); run them only with repository data you authorize
for that service.

## Next milestone

Stabilize the approval loop against representative repositories, then add
`CALL_CODEX` behind a small typed adapter with bounded stdout/stderr, exit
status, timeouts, and per-run call limits. `RUN_COMMAND` remains disabled until
a separately reviewed diagnostic-command allowlist exists.
