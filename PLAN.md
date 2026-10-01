# Jev Orchestrator plan

## Goal

`jev-orchestrator` is a small Node/TypeScript CLI that tests whether TypeSafe
AI's Jev can steer a coding-agent workflow. The repository is
[`petercr/jev-orchestrator`](https://github.com/petercr/jev-orchestrator).

Build on the packaged v0.2 CLI, preserving the decision-only default and
explicit approval-gated orchestration mode. Decision-only collects a bounded
repository snapshot, asks Jev for a typed recommendation, applies local policy,
prints the unexecuted decision, and can write a safe JSONL trace. Orchestration
may execute only repository-owned bounded candidates after manual approval.

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
- Mock Jev evaluation remains token-free and offline; an explicitly approved
  coding-agent alternative still invokes the real agent. The last recorded
  release gate (2026-09-21) passed `pnpm check`, `pnpm test` (111 tests), and
  `pnpm build`.

The current action vocabulary is:

```ts
type Action =
  | 'SEARCH_REPO'
  | 'READ_FILE'
  | 'RUN_COMMAND'
  | 'RUN_TESTS'
  | 'CALL_CODEX'
  | 'CALL_CLAUDE'
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

## v0.1 release gate

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

## Next milestone: bounded Claude delegation and agent routing

Implementation status (2026-09-20): complete. `CALL_CLAUDE` shares the typed
coding-agent result contract and approval-gated execution path with
`CALL_CODEX`; `RUN_COMMAND` remains disabled.

Claude Code is invoked with the literal `claude` executable, direct arguments,
Sonnet, medium effort, restricted mode, no session persistence, and only file
inspection/editing tools. The adapter cannot run shell commands; validation is
kept separate and must be approved through `RUN_TESTS`. Claude and Codex each
have an independent two-call limit, and both refresh repository state and
invalidate old validation after an attempt.

Codex fixture verification for this milestone is pinned to `gpt-5.6-terra`
with high reasoning rather than inheriting a user-configured model. Automated
tests cover exact invocation controls, correct adapter selection, normalized
success/failure/timeout results, repository refresh, validation invalidation,
and both call limits without making live model requests.

Live verification used separate disposable Git fixtures with the same missing
implementation and failing Node test. Claude Code 2.1.278, pinned to Sonnet and
medium effort, created only `src/add.js` in 7,172 ms. Codex CLI 0.155.1, pinned
to `gpt-5.6-terra` and high reasoning, created only `src/add.js` in 33,980 ms;
its bounded stderr trace explicitly confirmed both model settings. Each route
then refreshed repository state, passed a separately approved `pnpm test`, and
finished after explicit approval in three iterations.

## Next milestone: bounded diagnostic commands

Implementation status (2026-09-21): complete. `RUN_COMMAND` is enabled only for
a repository-owned allowlist of immutable, read-only diagnostics; do not accept
model-generated commands, arguments, paths, environment variables, or shell
text.

The first allowlist contains bounded Git status for clean or untracked-only
states and metadata-only `git diff --stat HEAD` for tracked changes. Both
commands use the literal `git` executable with direct arguments, disable
paging, optional locks, repository-configured filesystem monitors, renames, and
submodule inspection, and exclude generated traces. Diff statistics also
disable external diff drivers and text conversion so no source lines enter
command output. Candidate selection is deterministic from the inspected
repository state, and the executor revalidates the exact command identifier and
argument list before spawning it with a 10-second deadline.

Cover clean, untracked-only, and tracked-change selection; exact process
arguments; tampered proposal rejection; failures and timeouts; approval and
rejection; state transitions; bounded traces; and unchanged validation evidence.
Live verification used a disposable Git fixture with one tracked change. The
approved `git_diff_stat` diagnostic completed in 5 ms with exit status `0`,
changed no files, and recorded the exact fixed command in its schema-v2 trace.
The loop then passed a separately approved test and finished after explicit
approval in three iterations.

## v0.2 release candidate

Implementation status (2026-09-21): complete. Package the completed
approval-gated orchestration milestones as version `0.2.0` without changing
their runtime safety boundaries or publishing an artifact.

The release gate requires `pnpm check`, `pnpm test`, and `pnpm build`; the
documented mock decision smoke; a tarball whose production allowlist excludes
tests, traces, credentials, and dependencies; installation into a disposable
project; `jev-agent --version` reporting `0.2.0`; and a token-free installed
binary decision returning `status: "unexecuted"` without writing a trace.

Verification packed the production allowlist into
`jev-orchestrator-0.2.0.tgz`; inspection found only runtime JavaScript and
declarations, package metadata, README, and license. Installing that exact
archive into a disposable pnpm project reported version `0.2.0`, returned a
token-free mock decision with `status: "unexecuted"`, selected `SEARCH_REPO`,
and created no trace. No artifact was published.

## Next milestone: graceful user stop

Implementation status (2026-09-21): complete. The loop now supports a user-only
`stop` approval decision that is not part of Jev's action vocabulary and cannot
be selected by the model or policy. It executes no tool, does not reuse
`FINISH` or claim task completion, and appends a terminal schema-v2 trace record
before returning status `stopped`.

Accept `stop` and `quit` only at an approval prompt. Preserve the considered
proposal for audit context while recording null tool input and result, a
bounded user reason when supplied by an embedding caller, unchanged validation
evidence, and an explicit stopped current goal. Cover direct stop, no execution,
trace contents, status, and iteration count with deterministic tests.

Live verification used a clean disposable Git fixture. Entering `stop` at the
first approval prompt returned status `stopped` after one iteration, executed
no repository tool, left validation untouched, and changed no source file. Its
schema-v2 trace retained the considered `SEARCH_REPO` proposal, recorded the
`stop` approval history, null tool input and result, and the explicit
non-completion state.

## Next milestone: worker context and controlled repair

Completion status (2026-10-01): implementation, offline checks, and disposable
live repair verification through both worker adapters are complete.

The completed milestones above are backed by recorded session history. This
milestone addressed these gaps in the packaged v0.2 baseline:

- `CodingAgentRequest` and both worker candidates contain only `root` and the
  original `task`. Search/read results, user clarifications, and validation
  failures reach Jev's state but do not reach the worker request.
- Failed candidates are identified by their serialized action and input. The
  repeated-failure check runs on the initial candidate, before alternative
  selection; alternatives do not pass through that check again.
- A failed validation script retains the same candidate signature after repair.
  A useful retry therefore needs explicit evidence and validation-generation
  rules, rather than relying on changes to prompt text or approval routes.
- `AGENTS.md` described the first executable action set before this change;
  its milestone description is now synchronized with the approved agent paths.

### Intended workflow

```text
approved search/read + user clarification
                  ↓
bounded worker request, presented for approval
                  ↓
Claude or Codex implementation attempt
                  ↓
refresh repository + invalidate earlier validation
                  ↓
separately approved validation
          ┌───────┴────────┐
        passed           failed
          ↓                ↓
completion policy     ASK_USER: clarify, select an allowed worker, or stop
and approval               ↓
                      approve repair request with failure evidence
                           ↓
                      worker attempt → fresh approved validation
```

Completion still requires passing independent validation and the existing
policy/approval checks. Keep the eight-iteration ceiling, two calls per agent,
fixed adapter controls, and explicit approval for each executable candidate.
The repair path uses the existing actions; it needs no additional model call
to summarize context and no autonomous retry mode.

### Bounded worker request

Add a repository-owned typed context object to the shared worker request.
Build it deterministically from structured loop evidence, without rereading
files or parsing provenance from human-readable observation strings.

| Context | Source and treatment |
| --- | --- |
| Original task and current goal | Keep the task distinct from subsequent evidence; retain its existing 4,000-character limit. |
| User clarifications | Record through the user-input boundary with iteration/source metadata; use recent nonempty answers. |
| Repository findings | Include safe relative paths from approved search/read results and bounded excerpts already read by the loop. |
| Validation evidence | Include the selected script, exit status, timeout flag, validation generation, and bounded output from the latest attempt. |
| Previous worker attempt | Include agent identity, normalized outcome, bounded summary, and refreshed modified-file paths; label its claims as unverified. |
| Failed approaches and remaining calls | Include concise structured facts so a worker can see prior failures and the remaining limits. |

Use initial limits of 6,000 serialized characters for context, at most eight
items in each context list, and at most 1,000 characters for any excerpt or
result summary. Bound the complete rendered prompt, including the task and
fixed instructions, to 16,000 characters. Prioritize the latest clarification
and validation failure, then recent relevant findings; use deterministic
ordering and explicit truncation markers. A packet at the limit must remain
valid structured data.

Apply reusable credential redaction before context reaches the approval
display, an agent, or a trace. Preserve structured fields when truncating;
do not reuse the trace serializer as a domain-object parser. Exclude raw
provider metadata, environment contents, full transcripts, and secret-file
contents. Keep source labels outside untrusted text so an excerpt cannot
masquerade as user authorization.

Present the resolved task and context before approval, then execute that same
request through either adapter. Both adapters consume the same context shape
and retain their existing invocation controls. Revalidate request shape and
bounds at the adapter boundary. Repository findings and worker output are
evidence only: neither may alter execution controls, grant permissions, select
a model, or claim passing orchestrator validation.

### Repair and retry rules

1. A failed validation result remains failed evidence. When policy requires
   validation or completion, retain its `ASK_USER` override. Explain which
   script failed and let the user provide context, select an allowed worker
   alternative, reject, or stop. Selecting a worker resolves a repair packet
   and requires its own approval.
2. Count every worker invocation, including failures, timeouts, and malformed
   results. Refresh repository state and invalidate validation after every
   attempt, including attempts whose final status is uncertain. If repository
   refresh fails, require user intervention and a successful refresh before
   further execution. A worker's reported passing tests never satisfy the
   orchestrator's finish guard.
3. Associate validation evidence with a generation of repository work.
   Every approved worker attempt starts a new generation because it may have
   changed files, even if Git reports the same dirty paths. The same detected
   script may be approved once in the new generation; an unchanged failed
   script within that generation remains blocked pending relevant new user
   information. Never reset call counts or erase failure history.
4. Give failed worker requests a stable identity based on the agent, task,
   and relevant evidence. Iteration numbers, remaining-call counts, derived
   goals, and the failed call's own output must not make that request eligible
   again. A changed user clarification or newly gathered diagnostic evidence
   can justify a new request; record the reason it differs. A whitespace-only
   or repeated answer is not new information.
5. Apply retry eligibility to the initial proposal, every selected alternative,
   and the final candidate before execution. Choosing an alternative must not
   bypass a blocked repeat or a call limit. Rejection and stop execute nothing.
6. If the selected agent has exhausted its calls, present only permitted
   alternatives. Switching agents is a fresh, explicitly approved choice;
   it is never an automatic fallback. Exhausted budgets, unresolved failures,
   and ambiguous routing retain their existing bounded outcomes.

### Implementation slices

1. [x] **Capture evidence and build the shared context.**
   - Update the stale milestone paragraph in `AGENTS.md` to reflect the
     completed execution boundaries before implementation.
   - Extend `src/types.ts` and `src/agents/types.ts` with bounded, typed
     evidence and request context; preserve optional-property semantics.
   - Add a small pure context builder, for example `src/agents/context.ts`,
     and populate its inputs at the user/tool-result boundaries in the loop.
   - Test source attribution, ordering, bounds, redaction, missing context,
     hostile text, and deterministic output without invoking a model.
2. [x] **Carry the approved request through both adapters.**
   - Update candidate selection, execution, both prompt builders, and the CLI
     approval display together. Freeze the resolved request for execution so
     no evidence is added after approval.
   - Trace a bounded context summary, evidence references, request identity,
     and approval history. Keep schema-v2 fields compatible through additive
     metadata; keep decision-only schema-v1 output compatible.
   - Verify both adapters receive the approved packet while preserving their
     exact process controls, result normalization, timeouts, and output bounds.
3. [x] **Enforce controlled repair and verify the complete loop.**
   - Replace raw prompt/JSON equality as the sole retry rule with the explicit
     evidence and validation-generation rules above, enforced on all routes.
   - Keep repair decisions within deterministic policy and shared eligibility
     checks; the CLI only presents permitted choices and collects approval.
   - Update affected test fixtures, loop/adapter/trace tests, and README
     examples in the same change. Exercise the CLI approval text with an
     interactive mock smoke. Document ripgrep as a search prerequisite and
     distinguish natural-language clarification from approval action selection.

### Acceptance and verification

- An offline integration fixture completes an approved implementation,
  failing validation, approved repair, passing independent validation, and
  approved finish within eight iterations and the existing call budgets.
  Its repair request contains the actual bounded validation failure and the
  user's clarification, when supplied.
- Exercise both adapters and a user-selected cross-agent repair with mocked
  process/provider boundaries. Confirm rejection and stop invoke no worker,
  and ambiguous or missing-context routes still become `ASK_USER`.
- Cover identical failed requests through both normal and alternative routes,
  empty/repeated clarification, prompt changes caused only by bookkeeping,
  exhausted budgets, malformed results, timeouts, partial edits, and failed
  repository refresh. No such case can reuse earlier passing validation.
- A test fails, a worker edits an already-dirty file, and that same script can
  be approved in the new generation. Failure without intervening work cannot
  create an unbounded validation retry. Missing validation still blocks finish.
- Trace assertions cover context provenance and truncation, retry reasons,
  validation generations, call counts, approvals, and credential redaction.
- Run the narrowest affected tests first, then `pnpm check`, `pnpm test`,
  `pnpm build`, and the documented mock decision smoke. Automated tests make
  no live Jev, Claude, or Codex calls.
- Before marking the milestone complete, manually verify each worker against
  a disposable repair fixture through the approval loop. Record exact versions,
  approved actions, bounded outcomes, and independent validation results;
  live verification remains a separate explicit action.

The milestone is complete when gathered evidence reaches the approved worker,
a validation failure can lead to one justified repair and fresh validation,
and every failure path remains bounded and traceable. Durable resume, active
process cancellation, model-tier routing, and approval automation remain
separate future milestones.

Offline verification (2026-09-22): `pnpm check`, `pnpm test` (126 tests),
`pnpm build`, and the documented mock decision smoke passed. An interactive
mock run displayed a resolved Codex context packet, rejected it without
execution, then stopped; its two trace records have null tool results. No live
Jev or coding-agent request was made during that offline verification.


Final offline verification (2026-10-01): `pnpm check`, `pnpm test` (136 tests),
`pnpm build`, the documented mock decision smoke, and `git diff --check` passed.
Regression coverage includes serialized context limits with JSON escaping and
credential redaction, required user intervention after failed repository
refresh, and exact tracked-file status columns.

Live repair verification (2026-10-01) used separate disposable Git fixtures
and real worker calls with mock Jev routing; no new live Gateway evaluation was
made. Each manually approved run followed `SEARCH_REPO` → `READ_FILE` →
`RUN_TESTS` (failure) → `ASK_USER` (clarification) → user-selected and approved
worker call → separately approved `RUN_TESTS` (pass) → approved `FINISH`.
Both finished in seven iterations with one worker call, exit code 0, and no
timeout.

| Worker | CLI version | Configured model/effort | Duration | Context / prompt characters |
| --- | --- | --- | --- | --- |
| Codex | 0.159.3 | `gpt-5.6-terra` / high | 16,128 ms | 2,683 / 3,425 |
| Claude Code | 2.1.287 | Sonnet / medium | 5,707 ms | 2,683 / 3,448 |

The approved packets matched the execution traces exactly and included the
real validation failure, user clarification, and search/read provenance.
Generation 0 validation failed three tests; the worker attempt invalidated
validation, and independently approved generation 1 validation passed all
three tests. Only the already-dirty `src/add.js` changed; hashes of the fixed
tests, package manifest, lockfile, README, and `.gitignore` remained unchanged.
The live audit exposed a Git output trim bug that dropped the leading status
column and shortened the recorded path. Preserving status columns and adding
a real-Git regression fixed it; both corrected runs recorded `src/add.js`
exactly. Fixture manifests and traces are local disposable verification
artifacts, not repository contents or durable evidence storage.

## Reference, not a template

[`gargpratyush/jev-router`](https://github.com/gargpratyush/jev-router) is a
useful reference for hard Jev deadlines, fail-open behavior, explicit user
overrides, deterministic policy, bounded decision history, pinning decisions
within an operation, and avoiding low-confidence downgrades. It routes fresh
Claude/Codex turns to model tiers; this project routes high-level workflow
actions. Do not clone its architecture. Model-tier routing may be added later
as a separate layer.
