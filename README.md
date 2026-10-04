# Jev Orchestrator

A deliberately small Node/TypeScript experiment for testing whether
`typesafe-ai/jev` can make useful next-step decisions around a coding agent.

The default mode remains **decision-only**: it inspects a repository, sends a
compact state object to Jev through the selected evaluation provider, applies deterministic
policy thresholds, prints the result, and records a JSONL trace. The explicit
`--orchestrate` mode adds a bounded, manually approved loop for safe repository
searches, bounded file reads, fixed read-only Git diagnostics, detected
validation scripts, bounded public GitHub issue reads, and delegation to Codex CLI or Claude Code. It cannot run
arbitrary commands, and every resolved executable candidate requires explicit
approval.

## Requirements

- Node.js 22+
- pnpm
- ripgrep (`rg`) for approved repository search actions
- A key and Jev model access for the selected live evaluation provider
- An installed and authenticated Codex CLI for approved `CALL_CODEX` actions
- An installed and authenticated Claude Code CLI for approved `CALL_CLAUDE`
  actions

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

## Evaluation providers

`JEV_PROVIDER` explicitly selects one provider. Unset selection uses direct TypeSafe
with `jev-latest` and `TYPESAFE_API_KEY` (or `TYPESAFE_AI_API_KEY`);
there is no automatic cross-provider failover. Only the selected credential is
required. `ROUTER_MODEL` overrides its model; leave it blank to use the default.
`OPENROUTE_API_KEY` and `TYPESAFE_AI_API_KEY` are accepted credential aliases;
nonblank canonical names take precedence. `OPENROUTE_MODEL` supplies an
OpenRouter-only model fallback when `ROUTER_MODEL` is blank. Keep a global
override in the namespace of the selected provider.

| `JEV_PROVIDER` | Credential | Default model | Transport |
| --- | --- | --- | --- |
| `typesafe` | `TYPESAFE_API_KEY` | `jev-latest` | `POST https://api.typesafe.ai/v1/systemone` |
| `vercel` | `AI_GATEWAY_API_KEY` | `typesafe-ai/jev` | Existing Vercel AI SDK evaluation API |
| `openrouter` | `OPENROUTER_API_KEY` | `typesafe/jev-1.13` | `POST https://openrouter.ai/api/alpha/decisions` |

Create a [Vercel Gateway key](https://vercel.com/ai-gateway), an
[OpenRouter key](https://openrouter.ai/settings/keys), or a key in your
[TypeSafe account](https://typesafe.ai). Set the selector and its key in `.env`,
then use the env-file command above. For example, `JEV_PROVIDER=openrouter`
needs `OPENROUTER_API_KEY` and does not need a Gateway key.
For the previous Gateway behavior, explicitly set `JEV_PROVIDER=vercel`.
When switching providers, clear a previous provider's `ROUTER_MODEL` override
or replace it with a model in the new provider's namespace.

Model namespaces differ: keep `typesafe-ai/jev` on Vercel; OpenRouter documents
`typesafe/jev-1.13` and the moving alias `~typesafe/jev-latest`; direct TypeSafe
uses `jev-latest` or pinned `jev-1.13.0`. These are typed decision APIs, with
four Noul yes probabilities and a fixed Choice on native transports. They are
not chat completion endpoints. See the [OpenRouter Jev guide](https://openrouter.ai/blog/insights/what-is-jev/),
[TypeSafe API](https://docs.typesafe.ai/api), and [TypeSafe models](https://docs.typesafe.ai/models)
(verified 2026-10-03).

The account must have access to the selected model and sufficient credits or
billing capacity. Authentication and a positive balance alone do not establish
model/plan eligibility. A `401` means credential rejection; a `403` reports an
access restriction without claiming the key is invalid; billing, rate limits,
model availability, malformed answers, and timeouts have separate safe errors.
Account eligibility must be verified with that account; public model listings
do not guarantee it. Unknown selectors and missing selected keys fail before
any evaluation request. `--mock` ignores provider configuration and stays
offline and keyless.

Each provider shares one 10-second deadline across request, response reading,
and retry backoff, with at most one transient retry (two HTTP attempts). SDK
retries are disabled; responses are capped at 64 KiB, including error bodies.
Credentials go only to the selected fixed endpoint, with redirects disabled.
All configured provider keys are redacted from evaluation snapshots, errors,
CLI output, traces, and worker context. No raw upstream error body is logged.
Missing Choice confidence remains absent and cannot authorize a worker.

CLI results and both existing trace schemas add `provider`, `requestedModel`,
and optional `servedModel`, while retaining the existing `model` field and
schema versions. Native responses report their served version. The Gateway SDK
echoes the requested model ID, so `servedModel` is omitted there instead of
claiming a verified upstream version.

For separate opt-in live verification from this repository checkout, build
first and export only authorized
credentials, then run one synthetic evaluation per selected provider:

```bash
pnpm build
pnpm verify:jev --live openrouter
pnpm verify:jev --live typesafe
```

Each check sends a small synthetic state, performs at most two attempts within
10 seconds, executes no repository tool, and emits only sanitized provider,
requested/served model, and normalized outcome or error code. It does not load
`.env` automatically; to use that file run
`node --env-file=.env scripts/verify-jev.mjs --live openrouter` (or `typesafe`).
The live opt-in is required and is never part of automated tests. Implementation
and verification are tracked in `PLAN.md`. Authorized checks passed on
2026-10-03: OpenRouter served `typesafe/jev-1.13-20260917` and direct TypeSafe
served `jev-1.13.0`, with both responses normalized. These checks establish
access for the tested accounts; other accounts must verify their own access.

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
Enter `stop` (or `quit`) at any approval prompt to end the run without marking
the task complete. No repository tool executes for that iteration, the result
status is `stopped`, and the terminal decision remains in the JSONL trace.

For a task consisting of a GitHub issue URL, `READ_ISSUE` (or the `issue`
alternative) presents a read of that exact issue for approval. It uses only
the fixed public GitHub API, without credentials or redirects, with a
10-second deadline and 64 KiB response limit. Title/body context is bounded
and redacted; issue text remains untrusted. Private or unavailable issues need
context through `ASK_USER`. For a confident route, policy first proposes
`READ_ISSUE`, then reads each known root `AGENTS.md`, `CONTRIBUTING.md`, and
`CLAUDE.md` before testing, delegation, or completion. Each read still needs
approval; early test, worker, and completion alternatives remain unavailable
until preparation is complete. An unsafe required instruction file asks for
user intervention. No issue fetch occurs in decision-only mode, or before
approving `READ_ISSUE`.

After an issue read fails, policy proposes `ASK_USER` instead of repeating the
fetch. An approved, nonempty user reply supplies fallback task context and
reaches the worker as a clarification, with no fabricated fetched issue.
Known repository instructions must still be read. Once preparation is complete,
a clear first worker recommendation can proceed without a testing score forcing
baseline validation first. Every worker attempt still invalidates prior checks
and requires independent validation before completion. Ambiguity,
missing-information, stuck, and unresolved-inspection guards remain in force.

If evaluation fails, the loop records its safe code, validation stage, and
category before asking for recovery. Enter `continue` to reevaluate the
preserved state in the same run, or `stop` to return `evaluation_failed`
(exit 1). Continuation retains edits, evidence, failed approaches, and call
budgets. Each failed evaluation consumes an iteration within the existing
eight-iteration ceiling; no continuation is offered at the limit. Continuing
never approves a tool or executes a rejected recommendation. Recovery is
in-process; saved traces are diagnostic records, not executable resume files.

When local response validation rejects a probability sum, the CLI shows the
computed total, expected total of one, and unchanged `0.001` tolerance.
Traces retain the total as `failure.probabilitySum`. Only finite totals between
zero and the number of known actions are retained. A Gateway SDK rejection may
occur before the total is available. Rejected answers remain invalid;
continuation requests a fresh evaluation and does not approve a repository
action. Decision-only `--json` evaluation errors add allowlisted diagnostics
under `error.failure`; raw response data is excluded from those diagnostics.

Ctrl+C (`SIGINT`) or `SIGTERM` also stops an approval-gated run while Jev,
approval, information input, or an approved tool or worker is pending. The
first signal wins; repeated signals during cleanup do not start another action.
The loop waits for active execution to stop, keeps partial worker edits and
bounded output, refreshes repository status, and invalidates previous validation
after every begun worker attempt. Review those edits and run separately approved
validation on a later run before claiming completion. Cancellation never passes
validation or starts another tool, and returns `stopped` rather than `finished`
or `iteration_limit`.

On POSIX, active process groups receive TERM followed by KILL after a one-second
grace period, including descendants that ignore TERM after their parent exits.
On Windows, Node's supported child termination is used; this does not guarantee
cleanup of an independently running descendant process tree. Initial read-only
repository inspection drains its existing bounded reads and Git diagnostics
before returning a stopped trace; it does not enter evaluation or approval.

After validation passes, a clear Jev `FINISH` recommendation can be completed
manually even when the separate task-completion probability remains below the
95% automatic threshold. If Jev confidently requests `RUN_TESTS` after all
required checks already passed, policy selects `ASK_USER` for completion review
and makes the same manual path available. Review the original task acceptance
criteria, enter `FINISH`, review the resolved candidate, then enter `approve`.
The trace records whether policy offered review for a Jev finish request or
completed validation, along with both approval decisions. Missing, failed, or
stale checks, omitted issue requirements, unresolved repository inspection,
ambiguous routing, and high missing-information/stuck assessments prevent
this manual completion path. Passing baseline tests alone does not establish
that the requested coding change exists.

Completion requires all relevant independent checks since the latest worker
attempt. Inspection recognizes `verify` alongside `test`, `check`, `typecheck`,
`lint`, and `build`, including namespaced variants. Exact base names form the
default required workflow when present; otherwise detected variants are
required. Recognized validation commands named in the issue or user clarifications add required
checks, including unavailable checks that need user intervention. The issue
read and clarification requirements each retain at most eight script references; omitted requirements block
completion and require more context instead of silently counting as satisfied.
Each approved `RUN_TESTS` selects a script covering pending checks. A comprehensive script
counts toward other checks only when its declared command is a conjunction of
plain calls through the detected package manager, such as
`npm run lint && npm run typecheck && npm test`; flags, ORs, pipelines, and
opaque commands establish no extra coverage. Calls must use `run`, except for
the `npm test` script shortcut; other bare commands may invoke package-manager
builtins. Each script still needs approval. Once every required check passed,
the orchestrator offers no duplicate validation candidate or `RUN_TESTS`
alternative. A new worker attempt invalidates the previous checks and enables
fresh validation. Jev receives an explicit current-generation
`allRequiredPassed` summary; earlier worker sandbox reports cannot replace
independent results.

The mock flag applies only to Jev evaluation. If you choose `CALL_CODEX` or
`CALL_CLAUDE` as an alternative and approve its resolved candidate, the
installed coding-agent CLI makes a real call, may edit the selected repository,
and may consume tokens. Reject the candidate to execute nothing.
Approving `READ_ISSUE` also performs its real bounded GitHub read in mock mode.

Each approved worker request includes a bounded, labeled packet of prior user
clarifications, repository findings, the latest independent validation result,
and the previous worker outcome. The exact packet is shown before approval.
The original task remains separate, and repository or worker text in the packet
is treated as untrusted evidence. Known credential patterns and the configured
provider keys are redacted from the packet.

Jev receives the bounded issue, repository findings, previous worker claims,
and an orchestrator-derived progress summary of required/pending checks and
their independent results. The prior evidence packet remains capped at 6,000
serialized characters; added evaluation progress is capped at 12,000.
Worker-reported `listen EPERM` or `listen EACCES` is attributed as a reported
loopback binding restriction, without marking validation passed or broadening
worker permissions. Fresh approved orchestrator validation establishes results.

If validation fails, the loop presents `ASK_USER`. You can enter `approve` and
provide a plain-language clarification, or enter `CALL_CODEX` or `CALL_CLAUDE`
at that first prompt. An agent choice displays its resolved repair request for
a second approval. After a worker attempt, validation must be approved again
before completion, even if Git shows the same modified paths. The same failed
worker request or validation script cannot be repeated without relevant new
evidence or a new validation generation.

Then run the live Jev evaluation with the key from `.env`:

```bash
pnpm exec node --env-file=.env --import tsx src/cli.ts -- \
  . "Inspect this repo and choose the safest useful first action"
```

Each live evaluation uses the provider budget and safe error classifications
described above.

## CLI contract

Without `--orchestrate`, every successful run prints an **unexecuted** decision.
With it, the CLI enters the manually approved loop described below. Only an
approved `CALL_CODEX` or `CALL_CLAUDE` candidate invokes a coding agent.

```bash
jev-agent <repo-path> <task> [--mock] [--no-trace] [--json] [--orchestrate]
```

- `--mock` uses the offline deterministic evaluation.
- `--no-trace` suppresses a decision-only JSONL trace file.
- `--json` writes exactly one normalized, machine-readable decision object to
  stdout. It includes the repository snapshot, task, assessment, deterministic
  policy decision, provider, requested/served model attribution, model name,
  latency, and optional trace path. It omits raw
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

Exit code `0` means a decision, approved completion, typed stop, help text, or
version was printed. Exit code `1` means an operational failure or the
eight-iteration limit prevented completion; `iteration_limit` preserves edits
and evidence and prints an explicit incomplete-task message. Exit
code `2` means invalid command-line usage. Interrupted approval-gated runs use
`130` for Ctrl+C / `SIGINT` and `143` for `SIGTERM`; typed `stop` / `quit` stays
`0`. In `--json` mode, errors are one JSON
object on stderr with the same exit code.
Stopping after an evaluation failure retains operational exit `1`; a later
successful continuation uses the normal loop exit behavior.

## Traces

Unless `--no-trace` is set, each successful decision writes one JSONL record
under `./traces/`. Decision records use trace schema version `1` and a
timestamp-plus-UUID run ID, so concurrent runs do not share a file. A record contains a
sanitized state snapshot, normalized assessment, policy decision, provider,
requested/served model attribution, model,
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

A failed evaluation adds a schema-v2 record with null evaluation, policy,
approval, and tool fields, plus allowlisted `failure` diagnostics and recovery
availability. A separate record captures the explicit `continue`/`stop`
decision; both share the consumed iteration number. Cancellation during that
prompt adds the usual terminal interruption record with phase `recovery`.
No exception message, rejected response body, headers, or cause is failure
evidence. Consumers should use iteration numbers rather than counting lines.

A signal interruption adds a schema-v2 terminal record with a fixed phase and
reason. Evaluation, policy, candidate, approval, and tool fields are null when
those boundaries did not complete or execution did not begin. Begun executions
retain the actual approved input and normalized result, including an optional
`cancelled` flag distinct from `timedOut`. Worker metadata identifies the
approved request and its pre-attempt validation generation. If interruption
arrives during an ordinary trace write, that record is followed by one terminal
interruption record. Arbitrary signal reasons and provider error bodies are
never interruption evidence.

Worker iterations additionally record a bounded request identity, evidence
revision, validation generation, context references, and repair reason. Trace
recording is part of the default auditable run. If the trace directory
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
content at 64 KiB. Validation can invoke only a recognized `verify`, `test`, `check`,
`typecheck`, `lint`, or `build` package script through the package manager
detected from a lockfile. Process output and runtime are bounded.

`RUN_COMMAND` is limited to two immutable, read-only Git diagnostics selected
from repository state: bounded status for clean or untracked-only states, and
metadata-only `git diff --stat HEAD` for tracked changes. Both disable paging,
optional locks, repository-configured filesystem monitors, renames, and
submodule inspection; diff statistics also disable external diff drivers and
text conversion so no source lines enter command output. Generated traces are
excluded from both diagnostics. The executor revalidates the exact command and
argument list immediately before spawning the literal `git` executable, uses no
shell, and enforces a 10-second deadline.

Both coding agents use small typed adapters and literal executables with direct
arguments, never a shell. Codex is pinned to `gpt-5.6-terra` with `high`
reasoning in a repository-rooted `workspace-write` sandbox; it ignores user
configuration and execution rules, cannot request further approvals, and does
not persist its session. Claude is pinned to Sonnet with `medium` effort and a
restricted file-only tool set (`Read`, `Write`, `Edit`, `Glob`, and `Grep`), so
the orchestrator—not Claude—runs validation separately. Each call has a
15-minute deadline. Stdout and stderr are separately capped at 16 KiB and
recorded as separate trace fields; only final stdout becomes the loop
observation. Each orchestration run permits at most two calls to each agent.
After every attempt the loop refreshes repository metadata with exact untracked
paths; generated trace files are excluded from the modified-source list, and
every worker attempt invalidates prior validation and requires fresh approved
checks before completion. If repository refresh fails, the
loop requires an approved `ASK_USER` response and a successful refresh before
further execution; rejecting or stopping does not trigger a recovery attempt.

After exporting `TYPESAFE_API_KEY` (or `TYPESAFE_AI_API_KEY`), the shorter
command uses the default TypeSafe provider. Against
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
boundaries, so it does not require a provider key, a coding agent, or a
live Jev evaluation. Pull-request CI runs the same typecheck, test, and build
commands for maintainers.

## Live coding-agent verification

The active process cancellation milestone completed implementation, offline
verification (171 tests, typecheck, build, and mock smoke), and live signal
verification on 2026-10-01. Real Codex CLI 0.159.3 (`gpt-5.6-terra`, high) and
Claude Code 2.1.287 (Sonnet, medium) used mock Jev routing with no new live
Gateway evaluation. After separately approved validation passed three Node
tests, each approved worker saved an edit and was interrupted while executing:
Codex received SIGINT then SIGTERM during cleanup (CLI exit 130), and Claude
received SIGTERM (143). Both stopped after two iterations and one worker call,
retained only `src/add.js`, and invalidated prior validation. Approval/trace
and local process checks found no subsequent action, late edits, surviving
observed workers, or emergency harness cleanup. Neither run claimed task
completion; remote model termination and all-platform cleanup were not
established. Exact results are in `PLAN.md`; the Windows descendant cleanup
limit documented above remains.

The worker-context and controlled-repair milestone completed on 2026-10-01.
Real Codex CLI 0.159.3 (`gpt-5.6-terra`, high) and Claude Code 2.1.287 (Sonnet,
medium) repaired separate disposable fixtures using mock Jev routing; no new
live Gateway evaluation was made. Calls took 16,128 ms and 5,707 ms respectively.
Each run finished in seven iterations with one worker call: approved search,
read, failing validation, user clarification, user-selected and approved repair,
separate passing validation, and completion approval.

Both workers received the exact approved context packet with the real failure,
clarification, and search/read provenance. Each edited only an already-dirty
`src/add.js`; fixed test, package, lockfile, README, and `.gitignore` hashes
remained unchanged. Validation was invalidated after the worker and advanced
from generation 0 failure to generation 1 with all three tests passing. The
live audit found and fixed a Git status whitespace bug; corrected runs recorded
`src/add.js` exactly, with a real-Git regression covering that provenance.
The final offline gate passed typecheck, all 136 tests, build, mock decision
smoke, and whitespace checks. Versioned verification details are in `PLAN.md`.

On 2026-09-20, the routed Claude and Codex paths were both exercised against
separate disposable Git fixtures containing the same missing `src/add.js`
implementation and one failing Node test. Claude Code 2.1.278 used Sonnet with
medium effort and its restricted file-only tool set; it created only the
requested file and returned successfully in 7,172 ms. Codex CLI 0.155.1 used
`gpt-5.6-terra` with high reasoning; its trace confirmed both settings, it
created only the requested file, and returned successfully in 33,980 ms.

Each loop refreshed repository state, identified `src/add.js` exactly, reset
validation, ran a separately approved `pnpm test`, and required a final
completion approval. Both runs finished in three iterations and passed one
test. Mock mode was used only for Jev routing; both approved coding-agent calls
were live.

On 2026-09-20, Codex CLI 0.155.1 was invoked through the approval loop against
a disposable Git fixture with a missing `src/add.js` implementation and one
failing Node test. Mock mode was used only for Jev routing; the approved
`CALL_CODEX` action was live. Codex created only the requested source file and
returned successfully in 19,991 ms. The loop refreshed repository state, then
independently searched, read, ran the detected `pnpm test` script, and finished
after a separate approval. The complete run took five iterations and its
validation passed one test.

The first trace revealed two normalization issues that were fixed before this
milestone was marked complete: nested untracked files are now recorded as exact
paths instead of directory placeholders, generated trace files are omitted from
`filesModified`, and Codex progress diagnostics remain in bounded stderr rather
than being merged into the final stdout summary.

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
pnpm add --save-dev /absolute/path/to/jev-orchestrator-0.2.0.tgz
pnpm exec jev-agent --version
pnpm exec jev-agent . "Inspect this repository and choose the safest useful first action" \
  --mock --no-trace --json
```

The expected mock result is one JSON object with `status: "unexecuted"`; it
must not edit the target project or require an API key. On 2026-09-21, the
`0.2.0` archive was installed into a disposable project, reported version
`0.2.0`, returned that mock result, and created no trace. Do not pack or publish
`.env`, traces, build cache, or `node_modules`.

Initial provider milestone verification on 2026-10-03 passed typecheck, all 269 tests,
build, and keyless mock smoke. An exact `0.2.0` archive was installed offline
into a disposable consumer and verified all three selectors: mock remained
keyless, missing selected credentials failed before evaluation, and no trace
was written. Separate authorized live checks subsequently passed for both
new providers, as recorded above and in `PLAN.md`.

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
trace files and may run an explicitly approved fixed diagnostic, validation
script, Codex call, or Claude call.
The policy refuses to finish a task until a detected validation script has
passed, routes high missing-information or stuck signals to `ASK_USER`, and
does the same for ambiguous next actions. If validation fails or none is
available, the policy asks the user rather than assuming completion or blindly
retrying it. An identical failed candidate is not retried without new user
information.

Automatic completion still requires the configured 95% task-completion
threshold. Once validation has passed, a user may explicitly override that
confidence threshold when Jev clearly recommends `FINISH`, or explicitly
confirm task acceptance when a confident `RUN_TESTS` request repeats fully
passed current-generation validation. Policy selects `ASK_USER` for this
review; the resolved `FINISH` candidate requires a second approval. Validation
passing on its own never selects automatic completion below the 95% threshold.

Stopping is separate from completion. `stop` and `quit` are user-only approval
controls, never Jev actions. They execute nothing, return status `stopped`, and
record a terminal trace without changing validation evidence or claiming the
task is complete.

`RUN_COMMAND` never evaluates model-generated shell text or accepts arbitrary
arguments; it resolves only the two documented Git diagnostics. The Codex
adapter explicitly forbids deployment, publishing, pushing, commits,
destructive Git, secret reads, and writes outside the selected repository; its
workspace sandbox and fixed direct arguments provide the local execution
boundary.
Live evaluation sends the bounded task, repository metadata, and gathered
observations to the selected service. Vercel retains the existing
`zeroDataRetention: false` setting and routes to TypeSafe through its Gateway.
OpenRouter's Decisions API routes through OpenRouter to TypeSafe; this client
does not request a retention override, so account and provider privacy settings
apply. Direct TypeSafe bypasses both intermediaries and uses its account terms.
[OpenRouter's retention documentation](https://github.com/OpenRouterTeam/docs/blob/main/guides/features/zdr.mdx)
describes its account controls and upstream retention policies.
[TypeSafe's legal documentation](https://docs.typesafe.ai/legal) states that it
does not train on user data and offers enterprise zero data retention. This
client does not guarantee zero retention for any provider. Review the selected
service's terms and send only repository data you authorize for that service.

## v0.2 orchestration release

Version 0.2 preserves the read-only decision-only default and packages the
explicit approval-gated orchestration loop. Its executable set includes bounded
search and reads, two fixed Git diagnostics, detected validation scripts, and
bounded Claude Code or Codex delegation. Every executable candidate still
requires approval, every iteration is traced, and completion still requires
passing validation when available.
