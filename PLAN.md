# Jev Orchestrator plan

## Goal

`jev-orchestrator` is a small Node/TypeScript CLI that tests whether TypeSafe
AI's Jev can steer a coding-agent workflow. The repository is
[`petercr/jev-orchestrator`](https://github.com/petercr/jev-orchestrator).

Ship a reliable decision-only v0.1 CLI. Given a repository path and coding task,
it collects a bounded repository snapshot, asks Jev for a typed recommendation,
applies local policy, prints the unexecuted decision, and can write a safe JSONL
trace. It does not execute the selected action, modify the target repository, or
invoke Codex or Claude Code.

The governing architecture is:

```text
Jev recommends
      ↓
TypeScript policy authorizes
      ↓
approved tool or coding worker executes
```

Jev supplies probabilistic, high-level judgment only. It must never authorize
destructive work, invent shell commands, or supply arbitrary paths, queries, or
tool arguments.

## Current baseline

- The initial local scaffold was `48cf6f0`, but the GitHub remote is now
  populated and `main` contains subsequent work; do not treat the remote or the
  original scaffold's file list as current state.
- Node.js 22+, TypeScript, pnpm, Vitest, JSONL traces, and AI SDK `7.0.106`.
- Jev is evaluated with `experimental_evaluate()` through Vercel AI Gateway,
  defaulting to `typesafe-ai/jev`; `.env.example` defines
  `AI_GATEWAY_API_KEY` and `ROUTER_MODEL`.
- The CLI gathers an `AgentState`, asks independent completion, information,
  testing, stuck, and next-action questions, normalizes Jev probabilities and
  confidence metadata, and applies deterministic local policy.
- Live evaluation is bounded to 10 seconds and one retry; errors are
  credential-safe. Gateway calls use standard data retention
  (`zeroDataRetention: false`), so send only repository data authorized for
  that service.
- `--mock` remains token-free and offline. `pnpm check`, `pnpm test` (67
  tests), and `pnpm build` currently pass.

The current action vocabulary is:

```ts
type Action =
  | 'SEARCH_REPO'
  | 'READ_FILE'
  | 'RUN_COMMAND'
  | 'RUN_TESTS'
  | 'CALL_CODEX'
  | 'ASK_USER'
  | 'FINISH';
```

## Work plan

1. [x] Make setup predictable.
   - Pin the tested AI SDK release.
   - Document a Node 22 `--env-file=.env` command for live use.
   - Fail before a live request when `AI_GATEWAY_API_KEY` is missing or blank.
   - Keep mock mode independent of credentials.
   - Complete when a fresh checkout can install and run the documented mock
     command, while a keyless live run gives a clear error.

2. [x] Harden Jev evaluation.
   - Add a request deadline and bounded retry policy.
   - Present clear, credential-safe errors for authentication, rate limits,
     unavailable models, and invalid responses.
   - Validate provider confidence metadata at the integration boundary.
   - Complete when provider failures are bounded and predictable.

3. [x] Bound repository inspection.
   - Validate that the input is a directory and safely handle malformed
     `package.json` data and non-Git repositories.
   - Bound repository metadata, task text, Git output, and evaluation input.
   - Complete when large or unusual repositories cannot hang the CLI or create
     oversized evaluation requests.

4. [x] Complete deterministic policy coverage.
   - Cover threshold boundaries, missing choice probabilities or confidence,
     required information, failed validation, and repositories with no
     validation scripts.
   - A `stuck` probability at the user-question threshold now routes to
     `ASK_USER`, as do failed validation and validation requests where no
     detected validation script exists.
   - Keep `FINISH` unavailable until validation evidence has passed.
   - Complete when every accepted route and relevant policy override has a
     deterministic test.

5. [x] Finish the CLI contract.
   - Reject unknown flags and add `--version` and machine-readable `--json`
     output while retaining `--mock` and `--no-trace`.
   - Exit code `0` represents a printed result, `1` an operational failure,
     and `2` invalid usage. Human and JSON decision output explicitly state
     that selected actions remain unexecuted.
   - Complete when people and scripts can consume the same decision reliably.

6. [x] Make traces safe and useful.
   - Add a schema version and a collision-resistant run ID.
   - Bound and redact raw Jev answers, sanitize traced state and policy values,
     and omit raw provider metadata and upstream error bodies.
   - Default trace write failures return the documented operational error;
     `--no-trace` is the explicit unrecorded-run opt-out.
   - Complete when a trace explains a decision without collecting credentials
     or unnecessarily large provider data.

7. [x] Add offline integration coverage and continuous integration.
   - Test inspection, evaluation normalization, CLI output, traces, and failure
     paths with temporary repositories and mocked boundaries; no test requires
     a key, coding agent, or live Jev call.
   - [x] Run `pnpm check`, `pnpm test`, and `pnpm build` in maintainer-authored
     pull-request CI without an API key or live model request.
   - Complete when the complete offline release gate is automated.

8. [x] Verify live Gateway routing.
   - With `AI_GATEWAY_API_KEY` supplied locally, exercise representative tasks:
     locating code, investigating a bug, ambiguous requirements, and premature
     completion.
   - On 2026-09-20, live `typesafe-ai/jev` evaluations returned valid normalized
     confidence metadata for repository location (`READ_FILE`), bug investigation
     (`SEARCH_REPO`), ambiguous requirements (`ASK_USER`), and two unvalidated
     completion prompts (`ASK_USER` on ambiguity, then `RUN_TESTS`). Policy
     accepted or safely overrode each route; no live response was authorized to
     finish without validation.
   - The five calls completed in 464–787 ms (about 628 ms mean). The normalized
     evaluation result exposes no usage metric, so none was recorded rather than
     retaining raw provider metadata.
   - Complete when live responses normalize correctly and policy behavior matches
     the documented rules.

9. [x] Prepare the release package.
   - [x] Update the README and package contents. The production build excludes
     test compilation, and the package allowlist excludes compiled test files.
   - [x] On 2026-09-20, install the packed archive in a separate pnpm project,
     then run `pnpm exec jev-agent --version` and the documented mock command.
     The mock JSON response was `unexecuted`, selected `SEARCH_REPO`, had
     zero mock latency, and wrote no trace.
   - Complete: a local install follows the documented setup and commands.

## Release gate

- `pnpm check`, `pnpm test`, and `pnpm build` pass.
- The documented mock command succeeds without network access or a key.
- A live smoke test succeeds after the user supplies `AI_GATEWAY_API_KEY`.
- The CLI remains decision-only and target-repository inspection remains read-only.

## Next milestone: approval-gated orchestration loop

Implementation status (2026-09-20): complete for the first executable action
set. Decision-only mode remains the default, and `--orchestrate` enables the
manually approved loop. `CALL_CODEX` and arbitrary `RUN_COMMAND` execution
remain out of scope for this completed milestone; Codex delegation is the
follow-on milestone below.

After v0.1's decision-only release gate is met, add a bounded loop that can
perform approved, safe repository work. Manual approval is the default.

```text
user task
   ↓
repository snapshot
   ↓
Jev assessment
   ↓
deterministic policy
   ↓
safe action proposal
   ↓
user approval, rejection, or permitted alternative
   ↓
constrained execution
   ↓
updated state and trace
   ↓
repeat within iteration limits
```

### First executable action set

Enable only these actions in the first loop:

1. `SEARCH_REPO`
2. `READ_FILE`
3. `RUN_TESTS`
4. `ASK_USER`
5. `FINISH`

`RUN_COMMAND` remains non-executable until a separately reviewed, narrow
diagnostic-command policy exists. Add `CALL_CODEX` only after the basic loop is
reliable; it must use a small typed adapter with bounded stdout/stderr, exit
status, timeouts, and iteration/call limits.

### Candidate selection and execution rules

Jev's `choice` is an action label, not a tool invocation. Build a separate,
deterministic candidate-selection layer from repository inspection and prior
observations:

- `SEARCH_REPO` uses `rg` only under the selected repository root, with a
  bounded, sanitized query derived deterministically from the task and known
  repository context.
- `READ_FILE` can select only a bounded repository candidate or a path returned
  by a prior allowed search. Normalize and verify every path stays below the
  selected root; reject traversal and symlink escape.
- `RUN_TESTS` selects only a detected validation script from `package.json`.
  Detect the package manager from lockfiles and recognize `test`, `check`,
  `typecheck`, `lint`, and `build` as validation scripts.
- `ASK_USER` and `FINISH` have no executable repository parameters.

Never execute model-generated shell text. Never allow deploy, publish, push,
destructive Git, package publishing, filesystem deletion, secret reading, or
writes outside the selected repository. Use direct process arguments, not shell
interpolation, for every permitted tool.

### Approval and trace contract

Before execution, print Jev's recommendation and probabilities, the policy
decision and reason, the fully resolved safe candidate and parameters, and the
allowed approval choices. The user may approve, reject, or choose another action
that policy permits. A rejection executes nothing and becomes an observation for
the next iteration.

Every loop record must include bounded, redacted versions of raw Jev answers,
the normalized assessment, policy decision, candidate proposal, approval
decision, tool input, normalized tool result, exit status, duration, resulting
state transition, and iteration count.

### Implementation order and coverage

Before each implementation change, run:

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm dev -- . "Inspect this repo and choose the safest useful first action" --mock --no-trace
```

Work in focused commits. Start with the read-only investigation path
(`SEARCH_REPO` and `READ_FILE`), then validation scripts, then the interactive
approval loop and trace-state updates. Add deterministic tests for approval
rejection, iteration limits, path traversal and symlink escape, missing scripts,
failed tests, malformed tool results, timeouts, and premature completion. Mock
process and provider boundaries rather than policy logic.

The milestone succeeds when the CLI can navigate a small repository
investigation without arbitrary shell access, path escape, premature completion,
or unbounded looping.

## Next milestone: bounded Codex delegation

Implementation status (2026-09-20): complete. `CALL_CODEX` is part of the
approval-gated executable set without enabling arbitrary `RUN_COMMAND`.

The Codex integration must stay behind a small adapter with a common typed
coding-agent result. Invoke the literal `codex` executable with direct
arguments, a selected-repository working directory, `workspace-write`
sandboxing, bounded stdout and stderr, a hard timeout, and no persistent
session. User and repository text cannot change those invocation controls.

Require explicit approval for each call and allow at most two calls per
orchestration run. Record the normalized exit status, timeout, output, updated
repository status, modified-file list, and call count. A failed or timed-out
call must not be repeated unchanged. Any detected Codex change invalidates
prior validation, so completion still requires a later approved validation
script to pass.

Cover successful delegation, malformed adapter results, failures, timeouts,
argument-shaped task text, repository refresh, validation invalidation, and the
call limit without invoking a live coding agent in automated tests. Validate a
real call manually only against an expendable fixture repository before
declaring the milestone complete.

Live verification completed on 2026-09-20 with Codex CLI 0.155.1 against a
disposable Git repository containing one failing Node test. The approved call
created only `src/add.js`, exited successfully in 19,991 ms, and reported its
own passing test. The orchestrator then independently completed search, read,
validation, and approved finish steps in a five-iteration schema-v2 trace. Its
validation command passed one test. The initial trace exposed directory-level
untracked paths and merged progress diagnostics; the follow-up fix records exact
untracked file paths, excludes generated traces from `filesModified`, and keeps
bounded stdout and stderr separate while using stdout as the agent summary.

The follow-on milestone adds Claude Code behind the same adapter contract, then
routes between coding-agent capabilities. `RUN_COMMAND` remains disabled until
a separately reviewed diagnostic-command allowlist exists.

## Reference, not a template

[`gargpratyush/jev-router`](https://github.com/gargpratyush/jev-router) is a
useful reference for hard Jev deadlines, fail-open behavior, explicit user
overrides, deterministic policy, bounded decision history, pinning decisions
within an operation, and avoiding low-confidence downgrades. It routes fresh
Claude/Codex turns to model tiers; this project routes high-level workflow
actions. Do not clone its architecture. Model-tier routing may be added later
as a separate layer.
