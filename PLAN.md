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
- Jev defaults to direct TypeSafe with `jev-latest`; `JEV_PROVIDER` can also
  select OpenRouter or the existing Vercel AI SDK evaluation transport.
  `.env.example` documents each provider's credential and model namespace.
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
  | 'READ_ISSUE'
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
and every failure path remains bounded and traceable. Active process
cancellation is completed below; durable resume, model-tier routing, and
approval automation remain separate future milestones.

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

## Active process cancellation

Implementation, offline verification, and live worker signal verification
status (2026-10-01): complete.

Ctrl+C/SIGINT and SIGTERM interrupt approval-gated runs at pending Jev,
approval, information, or approved execution boundaries. First-signal latching
preserves exit codes 130/143 through repeated signals and cleanup; typed
stop/quit retains exit 0 and existing validation semantics. Decision-only
behavior, policy authority, manual approval, fixed direct invocations,
eight iterations, and two calls per adapter remain unchanged.

Cancellation is a separate execution option, never part of the approved
CandidateProposal, worker context packet, or signature. Pre-aborted execution
spawns nothing. Active POSIX process groups receive TERM and KILL escalation
after one second; escalation survives early parent exit so TERM-resistant
descendants cannot continue in that group. Windows uses Node-supported child
termination and does not guarantee independent descendant-tree cleanup.
Existing deadlines and output bounds remain intact; cancelled results are
unsuccessful even with exit zero and are distinct from timeouts.

Pending read-only boundaries can return promptly with late responses fenced
from execution. Side-effecting executors are awaited through cleanup, never
abandoned through a race. Every begun worker attempt is counted once, then
repository inspection drains independently of the aborted run signal and
invalidates prior validation with a new generation, including partial edits or
refresh failure. Initial read-only inspection drains its existing bounded
operations before the stopped run is recorded, without evaluation or approval.

Schema-v2 interruption records contain only fixed phase/reason text, bounded
state, actual approved execution inputs/results when begun, and pre-attempt
worker identity metadata. Unreached evaluation/policy/approval fields are null;
actual alternative history is retained. An interruption during trace writing
adds one terminal interruption record after any ordinary record already
written. No arbitrary AbortSignal reasons or provider error bodies enter the
record, and cancellation at the last iteration or finish finalization returns
stopped.

Deterministic coverage includes pre-abort/no spawn, active abort, parent-exit
with TERM-resistant descendants, unchanged deadlines, both adapters, pending
evaluation/approval/information with late responses, approval-to-execution
cancellation, partial edits and exact refreshed paths, call/generation counts,
refresh failure, non-passing interrupted validation, final-iteration/finish
interruption, approved worker trace identity, alternative history, and CLI
signal latching, listener restoration, trace contents, and exit codes.

Earlier independent coordinator subprocess verification used five disposable
fixtures with mock Jev and local fake workers, without live model calls: pending
approval SIGINT (130), pending information SIGTERM (143), partial worker edits
with SIGINT followed by SIGTERM (130), interrupted validation (130), and typed
stop (0). It verified exact refreshed `src/add.js`, one worker call, generation
invalidation, TERM-resistant descendant cleanup, non-passing interrupted tests,
and exactly one interruption record per cancelled run. These offline checks
did not spend model tokens; separate real coding-worker signal verification
is recorded below.

Offline verification (2026-10-01): `pnpm check`, `pnpm test` (171 tests),
`pnpm build`, the documented mock decision smoke, and `git diff --check` passed.
No live Jev or coding-agent calls were made during that offline gate. A
process-test readiness race exposed by the full suite was corrected to wait
for output flush before announcing readiness; output bounds are asserted for
both streams.

Live signal verification (2026-10-01) used real product workers in separate
disposable fixtures with mock Jev routing and no new live Gateway evaluation.
Each fixture first passed a separately approved `pnpm` validation script
(three Node tests), then the user selected and approved a worker. Each worker
saved its first edit before a real signal interrupted its active execution.

| Worker version | Configured model / effort | Signals to orchestrator | CLI exit | Worker exit | Worker duration | Signal to CLI exit |
| --- | --- | --- | --- | --- | --- | --- |
| Codex CLI 0.159.3 | `gpt-5.6-terra` / high | SIGINT, then SIGTERM during cleanup | 130 | `null` | 14,561 ms | 1,044 ms |
| Claude Code 2.1.287 | Sonnet / medium | SIGTERM | 143 | 143 | 5,485 ms | 1,033 ms |

Both runs returned `stopped` after two orchestration iterations and one worker
call, with `cancelled: true` and `timedOut: false`. Each retained exactly
`src/add.js`, with protected fixture hashes unchanged. The approved context
packet matched trace `toolInput`; worker metadata retained pre-attempt
generation 0, while refreshed state advanced to generation 1 with
`tests: { ran: false }` and `repoRefreshRequired: false`. Prior independent
validation was invalidated, and neither run claimed task completion. Trace,
approval, and local process identity/group checks found no subsequent action,
late edits, or surviving observed worker processes; no emergency harness
cleanup was required. The coordinator independently reviewed the assertions
against local summaries, cleanup audits, manifests, approved request captures,
and per-fixture traces. These disposable artifacts remain local. The checks
establish local process cleanup, without establishing remote model termination
or portability across all operating systems; the Windows descendant cleanup
limit above still applies.

## Jev evaluation providers — issue #22

Implementation, offline verification, and authorized live account checks
status (2026-10-03): complete.

- [x] Explicit `JEV_PROVIDER=vercel|openrouter|typesafe`, direct TypeSafe default,
  provider-specific credentials/defaults, and `ROUTER_MODEL` override.
- [x] Shared bounded state and five unchanged questions, Vercel SDK boundary,
  OpenRouter native Decisions API, and direct TypeSafe System One API.
- [x] Native Noul/Choice normalization, finite probabilities, allowed actions,
  valid distributions/confidence, and absent confidence preserved for policy.
- [x] One overall 10-second deadline, at most one transient retry with SDK
  retries disabled, bounded response streams, abortable backoff, and late
  response fencing. Selected credentials use fixed endpoints without redirects.
- [x] Credential-safe authentication, authorization/model-plan, billing,
  availability, rate-limit, timeout, and malformed-response classifications;
  pilot `403` restriction fixture does not call a valid key necessarily invalid.
- [x] Redaction of all three configured keys in evaluation snapshots, CLI
  output, errors, both trace formats, and worker evidence; additive provider
  and requested/served model attribution, with existing `model` retained.
- [x] Setup, model namespaces, account prerequisites, retention differences,
  `.env.example`, and separate bounded opt-in live verification command.
- [x] Live OpenRouter check using authorized credentials, with only sanitized
  provider/model/outcome evidence recorded.
- [x] Live direct TypeSafe check using authorized credentials, with only
  sanitized provider/model/outcome evidence recorded.

Deterministic tests exercise each actual SDK/HTTP boundary through mocked
fetch, successful and malformed answers, confident routes, missing/ambiguous
confidence, premature completion, retry limits, billing/access failures,
stream bounds, deadlines, cancellation in requests/backoff, no post-abort
approval/execution, redaction, and trace attribution. Mock mode remains
keyless and offline even with an invalid selector. Worker routing, manual
approval, eight iterations, two calls per worker adapter, controlled repair,
and independent validation are unchanged.

Offline verification (2026-10-03): focused provider tests (93 tests),
`pnpm check`, `pnpm test` (269 tests), `pnpm build`, the keyless mock decision
smoke with an invalid selector, and `git diff --check` passed. The exact
`0.2.0` archive was packed and installed offline into a disposable consumer;
all three selections produced keyless mock decisions and actionable missing
selected-credential errors before a live request, with no traces written.
The opt-in checker rejects a missing live flag and records only a sanitized
configuration outcome for either missing new-provider credential. No live
Jev, Codex, or Claude call occurred in these checks.

Authorized live verification (2026-10-03): the user supplied
`OPENROUTE_API_KEY`, `OPENROUTE_MODEL`, and `TYPESAFE_AI_API_KEY` in local
`.env` and explicitly requested the checks. Credential aliases are supported
and redacted alongside canonical keys; canonical keys take precedence, and
`OPENROUTE_MODEL` is an OpenRouter-only fallback beneath `ROUTER_MODEL`.
The existing global Gateway model override was replaced in process for the
OpenRouter check and cleared in process for the TypeSafe default. `.env` was
not changed. Each opt-in run sent only the checker's synthetic fixture and
used the shared ten-second/two-attempt cap; no repository tool or coding
worker ran. Both commands exited 0. Sanitized evidence:

| Provider | Requested model | Served model | Outcome |
| --- | --- | --- | --- |
| OpenRouter | `typesafe/jev-1.13` | `typesafe/jev-1.13-20260917` | normalized |
| TypeSafe | `jev-latest` | `jev-1.13.0` | normalized |

Alias follow-up verification passed focused config/provider tests, typecheck,
all 273 tests, and build. Regression coverage includes both live credential
aliases, canonical-name precedence, the OpenRouter model fallback, and
redaction of canonical and alias values in requests, output, traces, and
worker evidence.

Default-provider follow-up (2026-10-03): at the user's request, an unset
`JEV_PROVIDER` now selects direct TypeSafe with `jev-latest`. Explicit Vercel
and OpenRouter selection and the global model override remain available.
The local `.env` old Gateway model override was cleared without changing
credentials, so its supplied TypeSafe credential alias works with the default.
Help, setup instructions, `.env.example`, and default-route tests were updated.
Focused tests, `pnpm check`, all 274 tests, `pnpm build`, and
`git diff --check` passed. Loading the local `.env` with the built configuration
resolved to `typesafe` / `jev-latest` with a configured selected credential;
this verification made no additional live request.

## Orchestration recovery, issue context, and validation — issue #24

Implementation and offline verification status (2026-10-03): complete.

- [x] Allowlisted evaluation failure codes, stages, categories, and optional
  answer fields; no exception messages, response bodies, headers, or causes in
  failure evidence. Rejected distributions and confidence remain invalid.
- [x] Failure trace before recovery input, explicit in-process continuation,
  preserved edits/evidence/history/call budgets, and failed evaluations counted
  toward the same eight-iteration ceiling. Cancellation fences continuation
  prompts, late responses, and recovery trace writes.
- [x] Approved `READ_ISSUE` for the task's exact public GitHub issue, a fixed
  credential-free endpoint, no redirects, bounded responses/context, safe
  errors, and cancellation. Repository instructions precede other read
  candidates; issue data and worker claims remain untrusted.
- [x] Bounded prior evidence and independent validation progress reach Jev.
  Completion requires all current-generation checks, including issue-named
  scripts. Missing or omitted requirements cannot silently permit completion.
- [x] Detected `verify` scripts and conservative declared conjunction coverage;
  each resolved script remains typed and manually approved. Bare package
  manager builtins, flags, ORs, and pipelines prove no extra coverage.
- [x] Worker-reported loopback binding restrictions have explicit attribution
  and never pass validation or broaden worker permissions. Every worker
  attempt still requires fresh independent checks before completion.
- [x] Offline regressions for post-edit evaluation rejection, explicit recovery
  budgets/history, ambiguous routing, multi-check completion, malformed issue
  metadata, request bounds, credential redaction, sandbox reports, and signal
  cleanup. Existing policy thresholds and worker capabilities remain intact.

`pnpm check`, all 335 tests across 23 files, `pnpm build`, and
`git diff --check` passed. An existing process cleanup assertion encountered
a kernel timing race in one full-suite run; its focused rerun and the final
full suite passed without changes to process execution or that test.

Packed `0.2.0` and installed it offline into a disposable consumer. From a
separate fixture directory, the installed binary produced a keyless mock
decision and completed `SEARCH_REPO → READ_FILE → RUN_TESTS → FINISH` after
four explicit approvals. It read `CONTRIBUTING.md`, independently ran
`npm run verify` (four passing tests plus a syntax check), and credited the
declared `verify`, `test`, and `typecheck` workflow before completion. No live
Jev evaluation or coding worker ran in that mock verification. Recovery/issue
transport regressions use mocked provider, process, and HTTP boundaries.
Recovery is in-process, not persisted execution from a trace.

Live issue #80 rerun (2026-10-03 local time): used the installed package from
a fresh `jspdf-md-renderer` checkout at the earlier baseline commit, with only
the issue URL as the task. TypeSafe served `jev-1.13.0` for all eight valid
evaluations. It selected `READ_ISSUE` first and read `CONTRIBUTING.md`; manual
action selection then read `CLAUDE.md` and approved one Codex call (113.7 s).
The worker made only the identical-content config rename and TypeScript
include update, reporting sandbox listener restrictions as unverified claims.
Independent loop validation ran `verify` and `build`, passing lint,
typechecking, all 296 tests, and the build. A full standalone `npm test` log
confirmed the original warning is gone. The original checkout was preserved.

The live pilot remains incomplete as an orchestration workflow: after every
required current-generation check passed, Jev proposed duplicate `verify`
runs on iterations 7 and 8. Both were rejected; the same run ended at
`iteration_limit` without `FINISH` or a restart. CLI exit code was 0 despite
that incomplete status. This identified completion routing and duplicate
validation handling as follow-up work. No live evaluation failure
occurred, so recovery remains verified by offline regressions. Twenty receipt
checks passed; evidence is saved under `/tmp/jev-issue80-rerun-p5yoj2p2`.

Completion follow-up (2026-10-03 local time): required validation selection
now returns no candidate when nothing is pending, including manual
`RUN_TESTS` alternatives. A confident redundant validation request becomes
a policy-owned `ASK_USER` completion review with a typed `completionReview`
reason. Selecting `FINISH` and approving its resolved candidate confirms
original task acceptance; automatic completion still requires 95% confidence,
and current-generation validation, ambiguity, missing-information, stuck,
inspection and omitted-requirement guards remain intact. Jev receives a
derived `allRequiredPassed` flag and explicit criteria distinguishing
validation coverage from task outcome evidence. `iteration_limit` returns
exit 1 and explains that completion was not approved.

Focused regressions reproduced the original duplicate-validation and exit
failures, then passed with the fixes. The pilot-derived regression completes
in seven iterations after a redundant test request, with one worker and only
`verify`/`build` validation; rejection, stop, interruption during the resolved
completion prompt, and invalid/stale/incomplete evidence cannot fabricate
completion. `pnpm check`, all 356 tests across 24 files, `pnpm build` and
`git diff --check` passed. The installed CLI separately returned exit 1 after
eight rejected mock proposals. An installed-package evaluation fixture ran
one real Node test and completed the new redundant-validation review path
after selecting `FINISH` and approving it, with no live model or worker.

A fresh live issue #80 pilot then finished in the same eight-iteration run.
It used four initial manual routing choices, one approved Codex call (134.5 s),
independent passing `verify`/`build`, and a reviewed manual `FINISH` on the last
iteration. A `distribution/sum` rejection on iteration 7 exercised real
in-process recovery: explicit continuation retained edits, passing generation-1
checks, one used worker call, the same trace, and the one remaining iteration.
The live model requested `FINISH`; the new redundant-test fallback is verified
by the offline regressions and installed fixture. All 296 tests passed and a
full independent test log confirmed the warning was gone before completion
approval. The original checkout was preserved. All 24 receipt checks passed;
artifacts are under `/tmp/jev-issue80-completion-72kig8hb`. Early routing still
needed manual choices; this result does not establish an autonomous pilot.

## Linked-issue task preparation

Implementation (2026-10-04): address the early manual rerouting observed in the
issue #80 pilot. For a confident linked-issue route, deterministic policy first
proposes the exact public issue read, then each known root instruction file
(`AGENTS.md`, `CONTRIBUTING.md`, `CLAUDE.md`) before testing or delegation.
Preparation is enforced in candidate selection, manual alternatives, and the
final approval check, including before completion. Jev receives explicit
bounded preparation progress, and its criteria distinguish missing external
information from context available through supported reads.

A failed issue read proposes `ASK_USER`. Approved supplied context remains a
clarification in worker evidence, never a fabricated fetched issue, and does
not bypass repository instructions. Safe internal instruction symlinks retain
both the approved name and resolved path as read evidence; escaping or secret
targets stay blocked. Recognized validation references from user clarification
share the issue reader's bounded extraction and independent required-check
rules; missing or omitted requirements cannot establish completion.

After preparation, a clear first coding-worker request can proceed without a
high testing score forcing baseline tests. The exception applies before any
worker attempt or validation run and never suppresses a failed check. Every
worker attempt still requires fresh independent validation. Preparation routing
applies to linked-issue tasks. Confidence thresholds, manual approvals, eight
iterations, two calls per worker adapter, recovery, and cancellation boundaries
remain unchanged.

Offline regressions exercise the pilot workflow while Jev recommends a worker
with a high testing score on all four preparatory/implementation turns. The
loop reads the issue and both contributor files, uses one approved worker,
records independently scheduled `verify`/`build` checks, then resolves explicit
completion review without early manual alternatives. Additional cases cover unavailable issues,
supplied-context attribution, named checks, instruction aliases and escape,
premature manual alternatives, stale approval, stop, and interruption. Worker,
evaluation, and validation process boundaries are mocked in those regressions;
repository reads and fixture edits are real.

Verification passed `pnpm check`, all 390 tests across 25 files,
`pnpm build`, and `git diff --check`. The packed `0.2.0` archive includes the
new preparation module and excludes tests, traces, credentials, and dependencies.
It was installed offline into a fresh consumer. From a separate fixture
directory, the installed binary reported `0.2.0` and returned a keyless mock
decision with `status: "unexecuted"`, overriding `SEARCH_REPO` to `READ_ISSUE`
for an issue-URL task. The fixture remained unchanged and no trace was written.

A fresh installed-package live issue #80 pilot (2026-10-04) completed from an
external clone at the same `5a910ba` baseline, using direct TypeSafe
`jev-latest` (served as `jev-1.13.0`) and Codex CLI 0.160.0. The only supplied
task was the issue URL. The first three approved proposals read the issue,
`CONTRIBUTING.md`, and `CLAUDE.md` without manual routing. Iteration 4's worker
distribution was ambiguous (Codex 27%), so policy required a reviewed manual
`CALL_CODEX` selection. One worker call took 136.0 s and made only the config
rename and TypeScript filename-reference change. Its sandbox-reported test
limitations remained unverified; independent `verify` and `build` passed.

A `distribution/sum` rejection at iteration 6 required explicit in-process
continuation, preserving edits, generation-1 validation, worker counts, and
the two remaining iterations. After build, the iteration-8 `FINISH` request
had 73% confidence and required a reviewed manual finish selection and approval.
The full independent test log showed all 296 tests passing and no original Vite
warning before completion approval. The run finished with exit 0, without
restart or budget reset. Early manual routing fell from four choices to one;
completion review and one evaluation recovery were still required. The run
used all eight iterations and does not establish autonomous completion.

All 25 pilot receipt checks passed, including a complete reverse-checked patch,
unchanged lockfile, byte-identical renamed config, and preservation of the
original checkout's HEAD, status, diff, and 184 file hashes. Trace, terminal log,
full test log, patch, fingerprints, and receipt are under
`/tmp/jev-issue80-routing-KupNZ9`.

## Actionable evaluation-failure diagnostics

Implementation (2026-10-04): make the recurring live-pilot
`distribution/sum` rejection diagnosable without changing acceptance rules.
The [TypeSafe API schema](https://api.typesafe.ai/openapi.json) describes
approximate probability sums without specifying a tolerance; prior failure
traces retained only the classification, not the observed total. Local response
validation now retains its computed `probabilitySum`. The failure boundary
accepts it only for `invalid_response` at `distribution/sum`, as a finite
number between zero and the known action count. Arbitrary text, extra fields,
nonfinite numbers, out-of-range totals, and unrelated classifications cannot
introduce numeric evidence.

The CLI shows the observed sum, expected total, and existing `0.001` tolerance
in recovery prompts and terminal errors. Decision-only JSON evaluation errors
include allowlisted diagnostics under `error.failure`. Gateway SDK failures
that precede local normalization keep their existing classification without
fabricated totals. Recovery explains that explicit continuation requests a new
evaluation within the remaining budget and does not approve an action. Invalid
answers remain rejected without automatic retries or probability rescaling;
confidence rules, completion guards, cancellation, and budgets are unchanged.

Focused regressions passed 162 tests across five files. `pnpm check`, all 412
tests across 25 files, and `pnpm build` passed. Tests cover missing/unsafe numeric
diagnostics, unchanged accepted probabilities and confidence, native and SDK
rejections, JSON compatibility, and retention of the computed sum through
failure tracing and explicit recovery after edits.

An offline installed-package check used a fresh consumer and fixture outside
this repository. An intercepted provider response with total `0.99` produced
exit 1 in both human and JSON decision-only modes. The interactive CLI rejected
`approve` at the recovery prompt without another request, reevaluated only after
`continue`, then required separate review of the new candidate. Stopping there
returned exit 0 with two iterations, no worker calls, no tool execution, and
unchanged fixture files. All 13 receipt checks passed. Transport calls were
intercepted; no live Jev request, coding worker, or new issue #80 pilot ran.
Artifacts are under `/tmp/jev-evaluation-diagnostics-51I2Ii`.

## Standalone Codex comparison

Live benchmark (2026-10-04): ran standalone Codex against issue #80 in a
fresh external clone at the same `5a910ba` baseline as the PR #26 JEV pilot.
It used Codex CLI 0.160.0, `gpt-5.6-terra`, high reasoning, the same
`workspace-write` sandbox and noninteractive approval settings, and a
15-minute limit. The task contained only the issue URL plus general execution
boundaries; no issue body, file hints, or prepared worker evidence was supplied.
Live public web search was enabled so Codex could retrieve the issue itself.

| Observation | Recorded PR #26 JEV pilot | Standalone Codex |
| --- | --- | --- |
| Codex processes | 1 | 1 |
| Codex elapsed time | 136.0 s | 132.7 s |
| Root instructions | Read both contributor files before delegation | No recorded reads of `CONTRIBUTING.md` or `CLAUDE.md` |
| Interactive decisions | Seven candidate approvals, including manual worker/completion choices; one explicit evaluation recovery | None during the Codex run |
| Worker validation | Reported sandbox listener restrictions | Two `verify` attempts failed with `listen EPERM` |
| Independent validation | 296 tests, verify, and build passed | 296 tests, verify, and build passed |
| Patch | Config rename and filename reference update | Identical contents to the JEV patch |

Standalone Codex exited 0 and accurately disclosed its blocked test verification.
Independent `npm run verify` then passed lint, typechecking, and all 296 tests
across 28 files, with the original warning absent; `npm run build` also passed.
The config remained byte-identical, the lockfile was unchanged, and no other
tracked files changed. A complete unstaged patch passed reverse application
checking. All 21 acceptance/evidence checks passed. The original test checkout's
184 files and the orchestrator's existing source changes were preserved during
the benchmark; this section is the subsequent documentation update.

Codex reported 226,409 input tokens, including 198,912 cached input tokens,
and 2,591 output tokens. Comparable JEV token totals were not recorded.
These timings cover different context preparation: JEV supplied approved
evidence, while standalone Codex fetched the issue itself. JEV's approximate
293-second recorded overall window also includes operator approvals and
independent checks. This single small issue does not establish general speed,
cost, or autonomous completion performance. The JEV column uses the existing
live pilot; this benchmark made no new JEV evaluation request.

Events, invocation, final message, full independent logs, patch, fingerprints,
and receipt are under `/tmp/jev-issue80-codex-am91kovj`.

## Explicit per-run worker selection

Implementation (2026-10-04): add `--worker codex|claude` to both CLI modes,
including `--worker=value` syntax. Omission retains both adapters. Missing,
unsupported, or repeated values produce usage exit 2; flag-like task text
after `--` remains literal. An explicit selection appears in human output,
decision-only JSON, and serializable orchestration state and traces.

Jev receives the operator selection and worker actions allowed by the selection
and remaining per-adapter budgets. Deterministic policy, candidate selection,
manual alternatives, and final approval independently enforce the restriction.
Excluded recommendations become `ASK_USER`, without redirection or probability
changes. The run retains its original selection across state updates and
recovery; stale worker approval after a changed selection is rejected. Worker
failures, clarifications, and an exhausted selected budget cannot enable the
other adapter. Linked-task preparation, independent current-generation
validation, completion thresholds, eight iterations, and two calls per adapter
remain in force. Provider and worker-model configuration is separate.

Focused regressions passed 164 tests across seven files, with a further
18-test worker regression run after correcting fixture signal forwarding.
`pnpm check`, all 452 tests across 26 files, and `pnpm build` passed. Coverage
includes both workers, ambiguous routing, excluded and stale manual approvals,
linked-task preparation, fresh validation before completion, failures,
timeouts, malformed results, cancellation and partial edits, recovery, and
exhausted budgets without switching workers.

The packed CLI was installed offline into an external consumer. Decision-only
checks verified explicit/omitted JSON selection, help, and usage errors. Two
interactive mock-evaluation runs rejected the opposite worker alias, resolved
the chosen worker for a separate approval, executed only that worker's fixture
shim, and passed a real independent Node test before finishing in five
iterations. All 20 installed-package receipt checks passed, including selection
retention in every trace and package exclusions. No live evaluator or coding
worker was called. Invocation logs, transcripts, fixtures, traces, archive, and
receipt are under `/tmp/jev-worker-selection-fv5hw1cn`.

Live Claude issue #80 verification (2026-10-04) used the installed package with
`--worker claude`, direct TypeSafe `jev-latest` (served as `jev-1.13.0`), and
Claude Code 2.1.289 configured for Sonnet / medium. A fresh external clone used
the same `5a910ba` baseline as the Codex pilot; the only task input was the
issue URL. The first three approved actions read the issue, `CONTRIBUTING.md`,
and `CLAUDE.md`. Ambiguous iteration-4 routing required a manual `CALL_CLAUDE`
selection and separate approval.

The single live Claude call exited 0 after 10,496 ms, copied the config to
`vitest.config.mts`, and updated `tsconfig.test.json`. It explicitly disclosed
that `vitest.config.ts` remained: its file-only tools and no-delete prompt
cannot complete this rename. Independently approved `verify` passed all 296
tests across 28 files, and `build` passed. A full stdout/stderr verification log
confirmed the original Vite warning still appeared. Passing checks did not
satisfy the task; the run was stopped at iteration 7 without completion approval.

The run retained the Claude selection in every trace, used one Claude call and
zero Codex calls, and recorded six approved actions, two manual alternatives,
and no evaluation recovery. All 25 evidence checks passed, including unchanged
original and orchestrator checkouts before this documentation update, protected
file hashes, an unchanged lockfile, a byte-identical config copy, and a complete
reverse-checked partial patch. The rename and warning acceptance criteria
failed. Logs, trace, patch, fingerprints, and receipt are under
`/tmp/jev-issue80-claude-ze1kk2iq`. A bounded rename capability is needed before
this Claude adapter can complete the issue.

## Bounded Claude file renames

Implementation (2026-10-05): add a private stdio MCP server exposing only
`rename_file` within an approved Claude worker call. The adapter owns its inline
configuration and permits only `mcp__jev_files__rename_file` alongside the
existing restricted file tools. The server accepts bounded JSON-RPC requests
and permits eight rename attempts per worker call, including rejected attempts.
It exposes no shell or generic deletion capability.

Renames require two repository-relative paths and existing parent directories.
They preserve content and permissions, refuse overwrite, and reject traversal,
symlinks, hard-linked sources, directories, protected paths, and files over
1 MiB. An exclusive destination link precedes source removal, preserving data
if the operation is interrupted. Development and installed builds both launch
the private server with direct Node arguments from the selected repository.

The first live attempt with the new tool still could not rename: Claude's
`--safe-mode` disabled the inline MCP server. The adapter now uses restricted
mode, empty setting sources, explicit isolation settings, and strict MCP
configuration. Manual approval, independent validation, process cancellation,
worker selection, and iteration/call budgets remain in force.

Focused rename/server coverage adds 39 deterministic tests. `pnpm check`, all
491 tests across 28 files, and `pnpm build` passed. A freshly packed CLI was
installed offline into an external consumer; nine package and stdio checks
passed, including the compiled server, exact tool advertisement, protected-path
refusal, content-preserving rename, clean EOF, and package exclusions.

The corrected live issue #80 pilot used only the issue URL, the installed CLI
with `--worker claude`, direct TypeSafe `jev-latest` served as `jev-1.13.0`, and
Claude Code 2.1.289 configured for Sonnet / medium. A fresh external clone used
baseline `5a910ba`. The first three approvals read the exact issue,
`CONTRIBUTING.md`, and `CLAUDE.md`. One rejected Jev distribution at iteration 4
required explicit evaluation recovery. Ambiguous iteration-5 routing required
selecting `CALL_CLAUDE` and separately approving the resolved worker candidate.

The single Claude call exited 0 after 9,125 ms. It removed `vitest.config.ts`,
created the byte-identical `vitest.config.mts`, and updated the TypeScript
include reference. Independently approved `verify` and `build` passed. A
separate full stdout/stderr `npm run verify` log confirmed lint, typecheck,
all 296 tests across 28 files, and absence of the original Vite config warning.
Completion confidence remained below 95%, so iteration 8 required selecting
`FINISH`, reviewing its resolved candidate, and separately approving acceptance
of the original task criteria. The loop finished with exit 0, seven approved
actions including completion, two manual alternatives, one evaluation recovery,
one Claude call, and zero Codex calls.

All 25 evidence and acceptance checks passed. The original test checkout and
orchestrator checkout were unchanged before this documentation update; the
target lockfile, unrelated files, HEAD, and index were preserved. The complete
patch passed a reverse-apply check. Package, clone, logs, trace, patch,
fingerprints, and receipt are under
`/home/peterc/.cache/jev-pilots/issue80-claude-rename-20261005-r4ci7ggs`.

## Standalone Claude comparison

Live benchmark (2026-10-05): ran standalone Claude Code 2.1.289 against issue
#80 in a fresh external clone at the same `5a910ba` baseline. The harness
prepared dependencies with `npm ci`. Claude received only the issue URL and
general execution boundaries, with no prepared worker evidence, Jev evaluation,
or private rename tool. Sonnet and medium effort matched the configured JEV
worker selection; the standalone CLI reported `claude-sonnet-5-5`. The earlier
JEV Claude run did not record its resolved model version.

Built-in file, shell, and web tools were available, with empty settings sources,
hooks and automatic memory disabled, no MCP servers, no session persistence,
a 12-turn cap, and a 15-minute deadline. Project CLAUDE discovery remained
enabled. The run used `acceptEdits`, preapproved built-in tools, and no
interactive permission prompts; it did not bypass all permissions.

Claude exited 0 after 24,907 ms, using four turns and three Bash calls. It
retrieved the exact issue through `gh issue view`, searched filename references,
then used `mv` and `sed` to make the same minimal patch. No explicit read of
`CONTRIBUTING.md` was observed. Its final command ran typecheck, test, and verify
through `tail`/`grep` pipelines without preserving each command's exit status.
It disclosed that it saw only the final eight lines of verify output. It did
not run build. The worker's completion was therefore independently checked.

Full `npm run verify` and `npm run build` passed afterward. Verification showed
lint, typecheck, all 296 tests across 28 files, and no original Vite config
warning. The patch was byte-identical to the successful JEV Claude patch and
passed reverse-apply checking. All 21 acceptance/evidence checks passed,
including unchanged original and orchestrator checkouts before this
documentation update, unchanged target HEAD/index/lockfile, and no unrelated
source changes.

| Run | Worker process time | Independent acceptance | Interactive run decisions |
| --- | --- | --- | --- |
| JEV + Claude, Sonnet / medium | 9.1 s | 296 tests, verify, build; warning gone | Seven approvals, one Jev recovery |
| Standalone Claude, Sonnet / medium | 24.9 s | Same checks and identical patch | None during worker execution |
| JEV + Codex, Terra / high | 136.0 s | Same checks passed | Seven approvals, one Jev recovery |
| Standalone Codex, Terra / high | 132.7 s | Same checks passed afterward | None during worker execution |

These are worker process times, not comparable total workflow times. JEV
supplied approved issue/instruction evidence and ran validation afterward;
standalone Claude retrieved the issue and ran its own checks within its timer.
Models, tool access, and sandbox behavior also differ between Claude and Codex.
JEV's confirmed distinction here is enforced preparation, approvals, independent
exit-status validation, and completion review; this one small issue does not
establish a general speed or quality advantage over a standalone worker.

Claude reported 33,628 input tokens including cache creation/read tokens, 604
output tokens, and `total_cost_usd` of 0.0259736. The cost field is the CLI's
reported estimate, not a billing receipt; matching JEV usage totals were not
recorded. Invocation, events, final message, full independent logs, patch,
fingerprints, and receipt are under
`/home/peterc/.cache/jev-pilots/issue80-standalone-claude-20261005-gxsg628k`.

## Codex implementation-only handoff

Implementation and live comparison (2026-10-05): the Codex prompt now assigns
inspection and editing to the worker and asks it to return with validation
pending. It explicitly leaves tests, typecheck, lint, build, verification, and
dependency installation to the separate orchestration phase. Original task
and repository validation requirements remain required, and failed validation
evidence remains in the worker context. This is a prompt instruction; Codex's
shell capabilities are unchanged. Model, effort, sandbox, approval gates,
worker selection, and iteration/call limits are unchanged.

Focused Codex and worker-selection regressions passed 21 tests. `pnpm check`,
all 491 tests across 28 files, and `pnpm build` passed. A fresh package was
installed offline into an external consumer. Timing instrumentation remained
in the external harness, with no changes to CLI approval or trace behavior.

Four fresh clones used issue #80's `5a910ba` baseline and dependencies prepared
with `npm ci`. Run order was JEV-1, standalone-1, standalone-2, JEV-2. All used
Codex CLI 0.160.0, `gpt-5.6-terra`, and high effort. Both standalone controls
received the same implementation-only prompt built by the installed adapter,
with only the issue URL and no prepared evidence. Standalone live web search
retrieved the exact issue. Both JEV runs used the installed CLI with
`--worker codex` and direct TypeSafe `jev-latest`, served as `jev-1.13.0`.

| Run | Preparation tool time | First observed edit | Worker time | Independent verify + build |
| --- | ---: | ---: | ---: | ---: |
| JEV + Codex, run 1 | 0.334 s | 39.9 s | 58.9 s | 10.6 s |
| Standalone Codex, run 1 | Within worker | 47.7 s | 62.8 s | 11.1 s |
| Standalone Codex, run 2 | Within worker | 32.4 s | 50.3 s | 11.0 s |
| JEV + Codex, run 2 | 0.454 s | 55.2 s | 99.8 s | 11.5 s |

First edit means an observed physical change to one of the three task files,
sampled every 50 ms. Its origin is the approved worker handoff for JEV and
subprocess launch for standalone. JEV worker duration comes from the adapter;
standalone duration includes process startup and shutdown. Worker times exclude
dependency setup and independent validation. JEV preparation tool time covers
the issue and instruction reads, excluding evaluation and operator decisions.
Elapsed preparation through worker approval was 24.6 s and 44.0 s, including
operator pauses. Total workflow times include additional operator/harness
pauses and are not used for the speed comparison. The measurements do not
separate model reasoning, provider latency, or tool dispatch.

JEV averaged 79.3 s versus the recorded earlier 136.0 s worker run, an observed
42% reduction. Standalone averaged 56.6 s versus the earlier 132.7 s run, an
observed 57% reduction. Both setups improved with the narrower handoff, while
JEV showed no worker speed advantage over the matched standalone controls.
Two current repetitions per setup and one historical observation per setup
are too few to establish a general advantage or isolate the cause of the
improvement. The earlier raw temporary artifacts are no longer available;
their recorded timings remain in the preceding pilot notes. No lower-effort
experiment was performed in this round.

Both JEV loops finished in seven iterations with seven approvals, manual
`CALL_CODEX` and `FINISH` alternatives, no evaluation recovery, one Codex call,
and zero Claude calls. They prepared the exact issue, `CONTRIBUTING.md`, and
`CLAUDE.md` before delegation, then separately approved fresh verify and build.
Completion required acceptance review because confidence remained below 95%.
Both worker summaries reported no validation in the worker; trace truncation
prevents independently recovering their complete command lists. Complete
standalone command events show inspection, edits, and diff review without
validation. Neither standalone run explicitly read `CONTRIBUTING.md`; only
the first explicitly read `CLAUDE.md`.

All four patches were identical to the successful Claude rename patch and
passed reverse-apply checking. Each run passed independent lint, typecheck,
all 296 tests across 28 files, and build; full verification logs showed the
original warning was absent. All 84 per-case acceptance/evidence checks passed.
The original test checkout and orchestrator source were preserved before this
documentation update; target HEAD, index, lockfile, and unrelated files were
unchanged. Installed package, clones, invocations, timing records, transcripts,
events, full verification logs, patches, fingerprints, per-case receipts, and
the aggregate receipt are under
`/home/peterc/.cache/jev-pilots/issue80-codex-implementation-20261005-g1ugj82n`.

## Explicit Codex command networking

Implementation and live verification (2026-10-05): add `--codex-network` to
enable networking for Codex commands, including local listeners. The adapter
always passes an explicit `sandbox_workspace_write.network_access` boolean;
omission keeps it false. `workspace-write`, `--ask-for-approval never`,
Terra/high, implementation-only prompting, worker selection, and all approval,
validation, iteration, and call limits remain in force. This enables outbound
networking as well as localhost; it does not bypass the filesystem sandbox.

The opt-in appears in approved Codex parameters, decision-only JSON, and trace
state. The loop retains its original setting through clarification, recovery,
and cancellation, and rejects approval after a changed permission setting.
Approval display copies cannot change the canonical request. Task/repository
text cannot grant networking, and execution failures do not enable a fallback
to full-access mode. Repeated flags and a Claude-only selection with the flag
return usage exit code 2.

Focused checks passed 98 tests, followed by a 26-test orchestration regression
after a test typing correction. `pnpm check`, all 511 tests across 28 files,
and `pnpm build` passed. A fresh package was installed offline into an external
consumer; all nine installed-package checks passed, covering help, default and
opt-in JSON, invalid flag combinations, literal adapter settings, retained
sandbox/no-prompt arguments, and exclusion of local files.

Native Codex sandbox probes reproduced a localhost `EPERM` with networking off
and successfully listened with it on. A fresh issue #80 clone at `5a910ba`
used `npm ci` and the previously verified minimal rename patch applied by the
harness. Running the same verifier in Codex's sandbox with networking off
failed with `listen EPERM`; networking on passed lint, typecheck, all 296 tests
across 28 files, and build. The original config warning was absent. This was a
permissions comparison on a known patch, not a new delegated issue repair.

A separate live Codex CLI 0.160.0 diagnostic used the compiled adapter's
arguments with a diagnostic prompt and JSON output. With stdin closed and
Terra/high unchanged, it completed one requested command in 10.5 s. The probe
opened a localhost socket, wrote inside its selected workspace, and received
`EROFS` when attempting a disposable write outside it. No worker approval or
full-sandbox bypass flag was used. This tiny diagnostic is not a worker-speed
comparison with the issue #80 pilots.

All 18 acceptance/evidence checks passed, including preservation of the
original test checkout, target HEAD/index/lockfile, and only the required
config/reference changes in the cloned target. Probe invocations, native
verification logs, actual Codex events, installed package, clone, fingerprints,
and receipts are under
`/home/peterc/.cache/jev-pilots/codex-permissions-20261005-5my184mp`.

## Reference, not a template

[`gargpratyush/jev-router`](https://github.com/gargpratyush/jev-router) is a
useful reference for hard Jev deadlines, fail-open behavior, explicit user
overrides, deterministic policy, bounded decision history, pinning decisions
within an operation, and avoiding low-confidence downgrades. It routes fresh
Claude/Codex turns to model tiers; this project routes high-level workflow
actions. Do not clone its architecture. Model-tier routing may be added later
as a separate layer.
