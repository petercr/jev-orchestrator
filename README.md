# Jev Orchestrator

A deliberately small Node/TypeScript experiment for testing whether
`typesafe-ai/jev` can make useful next-step decisions around a coding agent.

The default mode remains **decision-only**: it inspects a repository, sends a
compact state object to Jev through Vercel AI Gateway, applies deterministic
policy thresholds, prints the result, and records a JSONL trace. The explicit
`--orchestrate` mode adds a bounded, manually approved loop for safe repository
searches, bounded file reads, detected validation scripts, and Codex CLI
delegation. It cannot run arbitrary commands, and Codex runs only after the
resolved call receives explicit approval.

## Requirements

- Node.js 22+
- pnpm
- A Vercel AI Gateway key for live mode
- An installed and authenticated Codex CLI for approved `CALL_CODEX` actions

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

After validation passes, a clear Jev `FINISH` recommendation can be completed
manually even when the separate task-completion probability remains below the
95% automatic threshold. Enter `FINISH` at the approval prompt, review the
resolved completion candidate, then enter `approve`. This twice-confirmed
override is unavailable before passing validation and is recorded in the trace.

The mock flag applies only to Jev evaluation. If you choose `CALL_CODEX` as an
alternative and approve its resolved candidate, the installed Codex CLI makes
a real coding-agent call, may edit the selected repository, and may consume
tokens. Reject the candidate to execute nothing.

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
With it, the CLI enters the manually approved loop described below. Only an
approved `CALL_CODEX` candidate invokes a coding agent.

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
repository tool. Alternative selections and their final confirmation are kept
as an approval-history array so manual completion overrides remain auditable.

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

`CALL_CODEX` uses a typed adapter and the literal `codex` executable with direct
arguments, never a shell. It runs in `workspace-write` mode rooted at the
selected repository, ignores user configuration and execution rules, cannot
request further approvals, does not persist its session, and has a 15-minute
deadline. Stdout and stderr are separately capped at 16 KiB, and each
orchestration run permits at most two Codex calls. After every attempt the loop
refreshes repository metadata; detected changes invalidate prior validation and
must pass a separately approved validation script before completion.

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

Decision-only mode is read-only except for its trace file. Orchestration writes
trace files and may run an explicitly approved validation script or Codex call.
The policy refuses to finish a task until a detected validation script has
passed, routes high missing-information or stuck signals to `ASK_USER`, and
does the same for ambiguous next actions. If validation fails or none is
available, the policy asks the user rather than assuming completion or blindly
retrying it. An identical failed candidate is not retried without new user
information.

Automatic completion still requires the configured 95% task-completion
threshold. Once validation has passed, a user may explicitly override that
confidence threshold only when Jev itself clearly recommends `FINISH`; the
resolved completion candidate must then be approved a second time.

`RUN_COMMAND` remains non-executable. The loop never evaluates model-generated
shell text. The Codex adapter explicitly forbids deployment, publishing,
pushing, commits, destructive Git, secret reads, and writes outside the selected
repository; its workspace sandbox and fixed direct arguments provide the local
execution boundary.
Live Jev evaluations allow standard Gateway data retention
(`zeroDataRetention: false`); run them only with repository data you authorize
for that service.

## Next milestone

Stabilize approved Codex delegation against representative repositories, then
add Claude Code behind the same typed adapter result contract. `RUN_COMMAND`
remains disabled until a separately reviewed diagnostic-command allowlist
exists.
