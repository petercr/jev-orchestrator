# Dev Orchestrator

A deliberately small Node/TypeScript experiment for testing whether typed
decision models can make useful next-step decisions around a coding agent.
Jev is the default; Cloudflare Clef/Clef-flash and OpenAI Decisions through
OpenRouter are explicit alternatives.

The npm package is `dev-orchestrator`; the CLI command is `dev-agent` from
v0.3.1 onward.
The GitHub repository keeps its existing name. The original v0.3.0 GitHub
archive is recorded separately under its historical `jev-orchestrator` name;
that unscoped npm package belongs to another project.
[dev-orchestrator@0.5.0](https://www.npmjs.com/package/dev-orchestrator/v/0.5.0)
was published on 2026-10-22 with styled terminal interaction, plain fallbacks,
and clearer evaluation-recovery guidance. See the [release notes](CHANGELOG.md)
and [publication record](docs/releases/dev-orchestrator-0.5.0.md).

The default mode remains **decision-only**: it inspects a repository, sends a
compact state object to the selected decision model, applies deterministic
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
- Credentials and model access for the selected live evaluation provider
- An installed and authenticated Codex CLI for approved `CALL_CODEX` actions
- An installed and authenticated Claude Code CLI for approved `CALL_CLAUDE`
  actions

## Setup

```bash
pnpm install
cp .env.example .env
```

Add the selected provider's key to `.env` or `.env.local`, then validate and
load it with the project's pinned [Varlock](https://varlock.dev) development tool
(Node.js 22.3+):

```bash
pnpm env:check
pnpm dev:env -- \
  . "Inspect this repo and choose the safest useful first action"
```

`.env.schema` owns the shared schema, provider default, and sensitivity markings
for all canonical credentials and compatibility aliases. `.env.example` remains
a plain template for existing dotenv workflows. Local values stay in ignored
`.env`/`.env.local` files; process environment overrides take precedence. Never
commit credentials.

`env:check` prints redacted diagnostics and checks configuration shape. Credentials
are optional in the schema so keyless mock runs and CI work; the CLI still
requires only the selected provider's key before live evaluation. This check
does not call a provider or establish account/model access. CI uses
`pnpm env:check:schema` to validate the committed schema without loading local
value files. Project-level Varlock telemetry is disabled.

`dev:env` runs the source CLI and `start:env` runs the built CLI. Both use
`varlock run --inject vars`, so subprocesses receive individual variables without
Varlock's full configuration blob. For another explicitly chosen command, use
`pnpm env:run <command> [arguments...]`. The normal `dev`, `start`, `check`, `test`,
and `build` commands keep their existing behavior and do not load local env files.
Use the normal `dev -- ... --mock` command for an offline check independent of
local schema validation; the `:env` commands validate local configuration even
when the CLI is in mock mode.

For optional device-local encryption, run
`pnpm exec varlock encrypt --file .env` (or `.env.local`) yourself. Encrypted
values require a Varlock-backed command; Node's `--env-file` does not decrypt
them. Setup does not rewrite your existing local values. See
[Varlock's local encryption guide](https://varlock.dev/guides/local-encryption/).

Varlock is checkout tooling, rather than a runtime dependency of the published
`dev-agent`. Installed consumers can keep exporting credentials or use Node's
`--env-file` with plaintext dotenv files; they can also supply environment values
through their own Varlock setup.

## Evaluation providers

The [v0.3.0 release](PLAN.md#v030-release-multiple-decision-models) adds decision
models alongside Jev, using the same assessment contract and deterministic policy.
Cloudflare Clef/Clef-flash have an adapter with deterministic transport tests
and successful live synthetic checks on 2026-10-15. OpenAI Decisions through
OpenRouter uses the same bounded transport and assessment contract, with
deterministic regression coverage and a successful live synthetic check on
2026-10-15. The table lists implemented transports.

The [v0.3 decision snapshot baseline](docs/benchmarks/v0.3-decisions.md) compares
Jev, Clef, Clef-flash, and OpenAI Decisions on 14 labeled workflow states with
three repetitions per model. It retains all 168 scheduled evaluations, including
two malformed Jev distributions, and reports routing, policy overrides,
intervention candidates, calibration diagnostics, usage, and latency. This is a
small synthetic decision study; the direct TypeSafe default remains unchanged.
The [comparison protocol](scripts/decisions/README.md) documents the bounded,
explicit opt-in live command and offline tests.

The [matched worker benchmark](docs/benchmarks/issue-31.md) records twelve
first-attempt observations on a production bug-and-tests task, with three
repetitions per setup and matched worker contexts/permissions. It retains test
failures, a build timeout, and an iteration-limit outcome alongside successful
runs. This small sample does not establish a general speed or quality advantage.
The [opt-in developer harness](scripts/benchmarks/README.md) documents
reproduction with Node.js 22+ and pnpm, without Python. Reporting can rebuild
preserved evidence without live calls; worker execution stays opt-in.

`ROUTER_PROVIDER` explicitly selects one decision provider. `JEV_PROVIDER` remains
a compatibility alias. If both are supplied, they must agree; conflicting,
empty, or unknown selectors fail before a request. Leave both unset to use direct TypeSafe
with `jev-latest` and `TYPESAFE_API_KEY` (or `TYPESAFE_AI_API_KEY`);
there is no automatic cross-provider failover. Only the selected credential is
required. `ROUTER_MODEL` overrides its model; leave it blank to use the default.
`OPENROUTE_API_KEY` and `TYPESAFE_AI_API_KEY` are accepted credential aliases;
nonblank canonical names take precedence. `OPENROUTE_MODEL` supplies an
OpenRouter-only model fallback when `ROUTER_MODEL` is blank. Keep a global
override in the namespace of the selected provider.

The CLI resolves provider, model, credential, and any account ID once for each
live run. The same selection survives evaluation recovery, clarification, and worker failures;
repository text and worker output cannot switch it. This selection is separate
from `--worker` and `--codex-network`. Credentials stay in transport configuration,
outside serializable task state and approval candidates.

| `ROUTER_PROVIDER` (or `JEV_PROVIDER`) | Credential | Default model | Transport |
| --- | --- | --- | --- |
| `typesafe` | `TYPESAFE_API_KEY` | `jev-latest` | `POST https://api.typesafe.ai/v1/systemone` |
| `vercel` | `AI_GATEWAY_API_KEY` | `typesafe-ai/jev` | Existing Vercel AI SDK evaluation API |
| `openrouter` | `OPENROUTER_API_KEY` | `typesafe/jev-1.13` | `POST https://openrouter.ai/api/alpha/decisions` |
| `cloudflare` | `CLOUDFLARE_AUTH_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID` | `clef` | Workers AI REST API, fixed account/model path |

Create a [Vercel Gateway key](https://vercel.com/ai-gateway), an
[OpenRouter key](https://openrouter.ai/settings/keys), or a key in your
[TypeSafe account](https://typesafe.ai). Set the selector and its key in `.env`,
then use the Varlock-backed command above. For example, `ROUTER_PROVIDER=openrouter`
needs `OPENROUTER_API_KEY` and does not need a Gateway key.
For the previous Gateway behavior, explicitly set `ROUTER_PROVIDER=vercel`.
When migrating, remove the old selector or set both to the same provider.
When switching providers, clear a previous provider's `ROUTER_MODEL` override
or replace it with a model in the new provider's namespace.

For [OpenAI Decisions](https://openrouter.ai/openai/gpt-6-luna-decisions), set
`ROUTER_PROVIDER=openrouter` and `ROUTER_MODEL=openai/gpt-6-luna-decisions`.
Use `OPENROUTER_API_KEY` or its `OPENROUTE_API_KEY` alias; this route requires
no direct OpenAI key. The OpenRouter default remains `typesafe/jev-1.13`, and
`OPENROUTE_MODEL` remains the model fallback when `ROUTER_MODEL` is blank.
OpenRouter's [Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)
accepts our shared `state` and named Noul/Choice questions and returns named
answer objects. Direct OpenAI's predicate questions and answer arrays are a
different wire format and are rejected here. Native REST adapters reject
missing, unexpected, or duplicate question names, incomplete action
distributions, refusals, and invalid probabilities/confidence. They keep the
existing `0.001` sum tolerance, without renormalizing or deriving missing
confidence from the chosen probability.

Model identifiers are limited to 256 characters: direct TypeSafe accepts
`jev-*`; Vercel and OpenRouter accept `vendor/model` identifiers, with an optional
leading `~` for OpenRouter aliases. URLs, whitespace, and path traversal are
rejected locally. Syntax validation does not establish model availability or
contract compatibility. Account-specific live verification results are recorded below.

For Cloudflare, set `ROUTER_PROVIDER=cloudflare`, a 32-character hexadecimal
`CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_AUTH_TOKEN` through Varlock or your process
environment. Use a token scoped to that account with Workers AI Read and Edit
permissions, as described in [Cloudflare's REST setup](https://developers.cloudflare.com/workers-ai/get-started/rest-api/).
Set `ROUTER_MODEL=clef` or `clef-flash`; unset/blank uses `clef`.
These selectors map only to `@cf/cloudflare/clef` and `@cf/cloudflare/clef-flash`
under `https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/`.
The [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) and
[Clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)
APIs use the shared four Noul questions and action Choice. The adapter unwraps
the Workers AI `success`/`errors`/`result` envelope and rejects missing,
unexpected, or duplicate question names, invalid answers, and incomplete action
distributions. Confidence is validated when present; absent confidence stays
absent. Served-model attribution comes from `result.model`, without inferring a
version from the requested model or endpoint.

Selecting Cloudflare sends the bounded task snapshot, including collected
repository/issue text and worker evidence, to your account's Workers AI service.
[Cloudflare's data policy](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
classifies inputs and outputs as customer content and says it does not use that
content for model training or service improvement without explicit consent.
Content may be stored when using Cloudflare storage services alongside Workers AI.

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
The existing `mock/jev` model and serialized `jev_finish` completion-review
label are retained for trace compatibility; the latter describes an evaluator
finish recommendation regardless of provider. No trace schema version changes.

Programmatic integrations can use `resolveEvaluationConfiguration`,
`EvaluationProvider`, `EvaluationError`, and `createEvaluator`. Create one
evaluator per run, then pass each state and a separate execution signal to it.
`evaluateAgentState` remains a one-shot convenience function. Existing Jev-named
configuration, error, and transport exports remain compatibility aliases;
legacy error imports still share the same constructor for `instanceof` checks.

For separate opt-in live verification from this repository checkout, build
first and export only authorized
credentials, then run one synthetic evaluation per selected provider:

```bash
pnpm build
pnpm verify:jev --live openrouter
pnpm verify:provider --live openrouter openai/gpt-6-luna-decisions
pnpm verify:jev --live typesafe
pnpm verify:provider --live cloudflare clef
pnpm verify:provider --live cloudflare clef-flash
```

To load this checkout's local values with Varlock, use
`pnpm env:run node scripts/verify-jev.mjs --live openrouter` (or `typesafe`).
For the Cloudflare models, run
`pnpm env:run node scripts/verify-jev.mjs --live cloudflare clef`, then repeat
with `clef-flash`. `verify:jev` and `verify:provider` invoke the same opt-in tool.
For OpenAI Decisions, run
`pnpm env:run node scripts/verify-jev.mjs --live openrouter openai/gpt-6-luna-decisions`.
The optional model argument accepts Cloudflare's two selectors or OpenRouter's
`typesafe/jev-1.13` and `openai/gpt-6-luna-decisions`, and overrides `ROUTER_MODEL`
for that check. The explicit provider argument selects
the synthetic check after validating ambient selectors for conflicts.

Each check sends a small synthetic state, performs at most two attempts within
10 seconds, executes no repository tool, and emits only sanitized provider,
requested/served model, and normalized outcome or error code. It does not load
`.env` automatically on its own; for a plaintext dotenv file you can also run
`node --env-file=.env scripts/verify-jev.mjs --live openrouter` (or `typesafe`).
The live opt-in is required and is never part of automated tests. Implementation
and verification are tracked in `PLAN.md`. Authorized checks on 2026-10-03,
repeated on 2026-10-14, normalized OpenRouter responses served by
`typesafe/jev-1.13-20260917` and direct TypeSafe responses served by `jev-1.13.0`.
The 2026-10-14 Vercel check failed with an authorization classification; its
account/model access remains unverified. A live TypeSafe CLI walkthrough also
completed one approved file read and then stopped, with no worker calls or
source edits. These checks apply to the tested accounts; other accounts must
verify their own access.

On 2026-10-15, separate authorized Cloudflare checks normalized responses for
both `clef` and `clef-flash`. Each returned its matching model name; no pinned
upstream revision was reported. The checks sent synthetic state only and called
no coding workers.

A live Clef CLI walkthrough on 2026-10-15 also completed two iterations in a
synthetic repository: an approved `READ_FILE` succeeded, then a `FINISH`
recommendation became `ASK_USER` because no validation script was available.
The operator stopped at that prompt. No coding worker ran or source file changed.

On 2026-10-15, OpenAI Decisions through OpenRouter also passed a synthetic live
check: `openai/gpt-6-luna-decisions` was served as
`openai/gpt-6-luna-decisions-20261006`. The response normalized under the same
question contract and policy thresholds. The check called no coding workers
and establishes access only for the tested account.

A live CLI walkthrough with that OpenAI model also completed two iterations:
an approved `READ_FILE` succeeded, then a `FINISH` recommendation became
`ASK_USER` because the synthetic fixture had no validation script. The operator
stopped; no coding worker ran or source file changed.

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

Known TypeSafe/Jev limitation: the v0.5 live pilot rejected action totals near
`0.99`, including a repeated rejection in one run. Strict validation remains
in force; a new evaluation can fail again. In orchestration mode, review each
failure and explicitly choose `continue` only while iterations remain. More
than one recovery is supported within the same eight-iteration budget; it
retains the provider/model, worker selection, network permissions, edits, and
current-generation check evidence. Decision-only mode returns an error
instead of offering in-process recovery. A stopped or exhausted run has not
accepted the task, even when its patch and checks pass. See
[issue #61](https://github.com/petercr/jev-orchestrator/issues/61) and the
[investigation](https://github.com/petercr/jev-orchestrator/blob/main/docs/presentation/v0.5-routing-investigation.md).

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

Choose a coding worker for a run with `--worker codex` or `--worker claude`:

```bash
dev-agent ../my-app "Fix the linked issue" --orchestrate --worker codex
```

Omitting the flag leaves both workers available to Jev. An explicit selection
restricts approved worker actions and manual alternatives; an excluded worker
request becomes `ASK_USER`, with no automatic redirection or confidence boost.
The selection persists through evaluation recovery and worker failures. An
exhausted selected worker budget does not enable the other worker. Linked-issue
preparation, separate action approval, fresh independent validation, and the
eight-iteration/two-calls-per-worker limits still apply. The flag also applies
to decision-only runs and mock-mode manual alternatives. It does not select
the Jev evaluator provider or the coding worker's model.

Both `--worker codex` and `--worker=codex` forms are accepted. Unsupported,
missing, or repeated values return usage exit code 2. Literal flag-like task
text belongs after `--`. Human output shows the selection; decision-only JSON
adds `workerSelection` when explicitly provided, and traces retain it in state.

Codex command networking is disabled by default. Use `--codex-network` for
tasks that need local sockets or outbound connections while retaining the
repository-rooted `workspace-write` filesystem sandbox:

```bash
dev-agent ../my-app "Fix the linked issue" --orchestrate --worker codex --codex-network
```

This passes `--config sandbox_workspace_write.network_access=true` to Codex;
without the flag the adapter explicitly passes `false`. Codex still runs with
`--ask-for-approval never`, so the worker does not request additional input.
Jev still requires approval for each action and fresh independent validation
after each worker call. Codex remains responsible for implementation only.
The opt-in permits command networking beyond localhost. It is shown as
`networkAccess: true` in the approved Codex request and retained as
`codexNetworkAccess` in JSON output and trace state. Repository text,
clarifications, failures, and evaluation recovery cannot change it. The flag
cannot be combined with `--worker claude` or repeated.

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

Then run the live Jev evaluation with your local values loaded by Varlock:

```bash
pnpm dev:env -- \
  . "Inspect this repo and choose the safest useful first action"
```

Each live evaluation uses the provider budget and safe error classifications
described above.

## CLI contract

Without `--orchestrate`, every successful run prints an **unexecuted** decision.
With it, the CLI enters the manually approved loop described below. Only an
approved `CALL_CODEX` or `CALL_CLAUDE` candidate invokes a coding agent.

```bash
dev-agent <repo-path> <task> [--mock] [--no-trace] [--json] [--orchestrate] [--worker codex|claude] [--codex-network]
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
- `--worker codex|claude` restricts coding-agent choice for this run; omission
  leaves both workers available. It requires the same approvals and validation.
- `--codex-network` enables Codex command networking, including local sockets,
  within its existing file sandbox. It does not remove Jev's action approvals.
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

## Orchestration run summary

Every returned `--orchestrate` run prints a performance summary after its loop
status, including approved completion, typed stop, iteration limit, evaluation
failure, and signal interruption. It reports elapsed time, active time excluding
prompt waits, evaluation attempts and failures, explicit evaluation recoveries,
approval responses, worker calls and retries, and validation outcomes.

Times use one local monotonic clock around each boundary, rather than adding
provider latency or worker-reported durations. Preparation covers approved
issue reads, searches, and file reads. Worker time includes execution cleanup;
independent validation is measured separately. Inspection includes the CLI's
initial snapshot and subsequent repository refreshes. Approval, clarification,
and recovery prompts have separate wait totals, including interrupted waits.
Candidate selection, policy, earlier trace writes, and other loop overhead
appear under `other`. Elapsed time covers initial inspection plus the loop up
to the final trace snapshot; it excludes CLI startup, final trace writing, and
summary printing. Millisecond values are rounded down.

For example:

```text
Run summary
Elapsed: 7.32s; active: 1.32s (excludes prompt waits)
Evaluation: 0.06s; preparation: 0.05s
Worker: 1.00s; independent validation: 0.15s
Approval wait: 6.00s; information wait: 0.00s; recovery wait: 0.00s
```

Approval counts describe operator responses; final deterministic checks still
control execution. Worker calls count begun attempts in this run, and retries
count additional calls to the same adapter. Evaluation counts describe loop
evaluations, including failed/interrupted attempts; they do not count individual
provider requests or internal transport retries. Token usage and cost are not
inferred from elapsed time.

Independent checks are reported as `passed`, `failed`, or `pending` for the
current validation generation. Passing declared conjunctive workflows covers
their constituent scripts, while a new worker attempt invalidates earlier
results. Omitted requirements and an unresolved repository refresh remain
explicit completion blockers. The summary reports validation; task acceptance
still requires the existing completion review and approval.

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

New orchestration records include cumulative `metrics` with numeric `timings`
and `counts`. The terminal record also contains the returned `summary`, adding
current-generation independent validation results. These are additive fields
within schema version `2`; older traces may omit them. The summary uses the
same bounded sanitization and credential redaction as other trace fields.
Measurements stay outside `AgentState` and do not change policy inputs,
permissions, approvals, or budgets.

A failed evaluation adds a schema-v2 record with null evaluation, policy,
approval, and tool fields, plus allowlisted `failure` diagnostics and recovery
availability. A separate record captures the explicit `continue`/`stop`
decision; both share the consumed iteration number. A signal during that
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

An unanswered prompt that closes, times out, or is cancelled adds optional
`promptStop: { phase, reason }` evidence within schema version `2`. Reasons are
`input_closed`, `input_timeout`, or `input_cancelled`; the CLI stops with exit
code `1`. This does not invent an approval, clarification, recovery response,
or signal. Existing signal records retain `interruption.reason: "signal"`.
Terminal styling preferences are absent from state, candidates, and traces.

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
reasoning in a repository-rooted `workspace-write` sandbox. Command networking
is explicitly disabled unless `--codex-network` is supplied. It ignores user
configuration and execution rules, cannot request further approvals, and does
not persist its session. Its prompt assigns implementation only: inspect and
edit, then return without running tests, typechecks, lint, builds, verification,
or dependency installation. Original validation requirements remain required;
the orchestrator schedules fresh checks with separate approval. Claude is
pinned to Sonnet with `medium` effort and a
restricted file tool set (`Read`, `Write`, `Edit`, `Glob`, and `Grep`) plus
Jev's private `rename_file` MCP tool. The adapter supplies that local server
through inline configuration and permits its single rename tool within the
approved worker call. The CLI uses restricted mode, loads no user, project, or
local settings, and disables non-managed hooks and automatic memory. Its
explicit settings exclude project CLAUDE files and enable no plugins. Claude's
safe mode disables MCP servers, so the adapter uses these settings with
restricted mode and strict MCP configuration. MCP access is limited to Jev's
inline server. Renames take two repository-relative paths, preserve content and
permissions, and refuse existing destinations, traversal, symlinks, hard-linked
sources, directories, secret and tooling paths, and files over 1 MiB. Parent
directories must already exist. Each worker call permits eight rename attempts;
invalid attempts consume that budget. The tool runs no commands and exposes no
delete or overwrite operation. The orchestrator runs validation separately.
Each call has a 15-minute deadline. Stdout and stderr are separately capped at
16 KiB and recorded as separate trace fields; only final stdout becomes the loop
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

The test suite is offline: it uses temporary repositories and mocks HTTP, SDK,
and process boundaries, so it requires no provider key or coding-agent invocation.
Pull-request CI runs the same typecheck, test, and build commands for maintainers.

The common matrix in [providers.test.ts](src/ai/providers.test.ts) runs the same
assessment fixtures through six provider/model routes: direct TypeSafe Jev,
OpenRouter Jev, Vercel Jev, Cloudflare Clef and Clef-flash, and OpenAI Decisions
through OpenRouter. It exercises the actual evaluator, policy, candidate, and
orchestration code. Coverage includes confidence and refusal handling, linked-task
preparation, both worker selections and budgets, failed/stale independent
validation, completion review, recovery, iteration limits, credential redaction,
deadlines, retries, and cancellation during evaluation, approval, and execution.
Provider-specific envelope and error-code tests remain alongside this matrix.
Run it alone with `pnpm exec vitest run src/ai/providers.test.ts`.

The [v0.4 workflow baseline](docs/workflows/v0.4-baseline.md) adds complete
bug-fix, feature, and controlled-repair sequences across the same six routes
and both workers. It runs real local Node checks on scripted patches in
temporary Git repositories, with synthetic HTTP and worker boundaries.
It also reproduces missing context, manual alternatives, recovery, interruption,
stale/omitted validation, and budget stops. Run it alone with
`pnpm exec vitest run src/orchestration/workflows.test.ts`.

Orchestration reviews now group the model recommendation, policy decision,
resolved candidate, current evidence/limits, and operator choices. They explain
unread instructions, missing context, failed/stale checks, unavailable validation
coverage, exhausted worker calls, and explicit acceptance review. Manual action
alternatives and evaluation recovery remain separate from action approval in
the review counters and final summary. See the
[routing explanation guide](docs/workflows/v0.4-routing-explanations.md) for
examples and the reporting/JSON compatibility boundary.

The [v0.4 repair routing candidate](docs/workflows/v0.4-repair-routing.md) adds
12 labeled workflow variants to the original 183-case baseline. A clear
recommendation to repair a failed independent check can return to the same
available worker even with a high testing assessment. It still requires
separate approval, retains call limits, and invalidates validation after the
repair. Stale checks and worker test claims do not qualify as repair evidence.

A [live issue #80 replay](docs/workflows/v0.4-issue-80-pilot.md) completed with
TypeSafe/Jev and one real Codex call: seven iterations, passing verification
(296 tests) and build, and two explicit manual alternatives. The first patch
passed, so this run did not exercise the new repair exception. The report
records the isolated setup, frozen candidate, approvals, and comparison limits.

The [bounded v0.4 live comparison](docs/workflows/v0.4-live-results-v1.md)
retains eight launches: seven accepted/completed workflows across Jev,
Decisions, Codex, and Claude, plus one launch failure before evaluation. Both
staged repairs succeeded; two malformed evaluations required explicit recovery.
Manual routing remained necessary. This pilot does not establish a live
reliability or speed improvement, and it did not need the new repair exception.
The report includes the missing comparison cell, timing/wait separation, and
the supplemental audit for truncated validation labels. See the
[opt-in instrument guide](scripts/workflows/README.md) for reproduction.

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
`dist/`, plus package metadata, README, [release notes](CHANGELOG.md), and license. Test sources and compiled test files are
not published. The `prepack` lifecycle runs the production build before a
tarball is created.

Version 0.3.1 renames the executable from `jev-agent` to `dev-agent`. Update
shell commands, package scripts, and CI invocations when upgrading; the new
package exposes only `dev-agent`. Flags and configuration remain compatible.

Install the published package and run `dev-agent`:

```bash
pnpm add --save-dev dev-orchestrator@0.4.0
pnpm exec dev-agent --version
pnpm exec dev-agent . "Inspect this repository and choose the safest useful first action" \
  --mock --no-trace --json
```

To verify a local checkout's package, first create a tarball from this repository:

```bash
pnpm pack --out /absolute/path/to/dev-orchestrator-%v.tgz
```

Then, from the other project, install that exact archive and run the installed
binary against that project:

```bash
pnpm add --save-dev /absolute/path/to/dev-orchestrator-0.5.0.tgz
pnpm exec dev-agent --version
pnpm exec dev-agent . "Inspect this repository and choose the safest useful first action" \
  --mock --no-trace --json
```

The expected mock result is one JSON object with `status: "unexecuted"`; it
must not edit the target project or require an API key. The installed version
must report the exact archive's version (`0.5.0` for this checkout). Do not pack or publish
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

The separate `Terminal verification` workflow uses a read-only, maintainer
permission gate and Node 22 on Ubuntu and Windows. It checks the compiled CLI,
installs an exact checkout archive in a private consumer, and repeats the
offline PTY/ConPTY matrix. Its optional native test dependencies stay outside
normal installation and the published package; captures are retained for seven
days. See the [harness instructions](scripts/terminal/README.md).

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
OpenRouter's Decisions API routes through OpenRouter to TypeSafe for Jev or to
OpenAI for `openai/gpt-6-luna-decisions`. Selecting that model sends the same
bounded task and repository evidence to OpenRouter and OpenAI. This client
does not request a retention override, so account and provider privacy settings
apply. Direct TypeSafe bypasses both intermediaries and uses its account terms.
[OpenRouter's retention documentation](https://openrouter.ai/docs/guides/features/zdr)
describes its account controls and upstream retention policies.
[OpenAI's data controls](https://developers.openai.com/api/docs/guides/your-data)
describe API data handling and eligibility for retention controls; routing
through OpenRouter does not establish that this account has those controls.
[TypeSafe's legal documentation](https://docs.typesafe.ai/legal) states that it
does not train on user data and offers enterprise zero data retention. This
client does not guarantee zero retention for any provider. Review the selected
service's terms and send only repository data you authorize for that service.

## v0.4 task workflow release

The [v0.4 proposal](PLAN.md#v04-draft-reliable-task-workflows) focuses on getting
bounded coding tasks through implementation, validation, and acceptance review
with fewer avoidable routing detours. It starts with complete workflow
reproductions, clearer explanations of blockers, focused routing fixes, and a
bounded live comparison. The first deliverable is the
[offline workflow baseline](docs/workflows/v0.4-baseline.md), with frozen tasks,
183 enforcement tests, a stop/ownership inventory, and a reserved verification
task. [Operator-facing blocker explanations](docs/workflows/v0.4-routing-explanations.md)
and the [focused repair routing fix](docs/workflows/v0.4-repair-routing.md)
are implemented, and the [bounded live pilot](docs/workflows/v0.4-live-results-v1.md)
is complete with its limitations recorded. Version 0.4.0 was published on npm
on 2026-10-19. The [publication record](docs/releases/dev-orchestrator-0.4.0.md)
tracks the merged release source, exact archive, and installed-package checks.
Existing approval and validation requirements remain in force. The pilot does
not establish improved live reliability, fewer detours, or speed.

## v0.5 terminal presentation

The [v0.5 presentation milestone](PLAN.md#v05-candidate-terminal-presentation-and-interaction)
now integrates styled orchestration prompts, phase progress, candidate review,
and grouped results in this checkout. The
[integration record](docs/presentation/v0.5-integration.md) follows the
[offline prototype and Clack decision](docs/presentation/v0.5-prototype.md).
Try the actual approval loop without a model credential:

```bash
pnpm dev -- . "Inspect this repo and choose the safest useful first action" --mock --orchestrate
pnpm dev -- . "Inspect this repo and choose the safest useful first action" --mock --orchestrate --plain
```

Interactive terminals use styled output. `--plain`, pipes, CI, `NO_COLOR`, or
`TERM=dumb` select static output. Both modes require typed choices and show a
resolved alternative before its separate approval. Blank input approves
nothing. EOF, a 15-minute prompt timeout, or prompt cancellation stops with
exit code `1`; typed `stop`/`quit` exits `0`, SIGINT exits `130`, and SIGTERM
exits `143`. Signal cancellation still drains active execution and preserves
partial edits and evidence. Decision-only JSON retains schema version `1`.
In a plain Windows console, submit Ctrl+D or Ctrl+Z followed by Enter to close
the prompt; styled mode handles Ctrl+D immediately.

The synthetic comparison remains available through `pnpm prototype:ui` and
`pnpm prototype:ui --renderer plain`. Version `0.5.0` is published; its
[publication record](docs/releases/dev-orchestrator-0.5.0.md) retains the
verified public archive and fresh registry-install checks. The optional
[terminal verification harness](scripts/terminal/README.md) exercises compiled
and installed CLIs on POSIX PTYs and native Windows ConPTY without live calls.
The [verification record](docs/presentation/v0.5-verification.md) documents
the completed matrix, the Windows EOF correction, and the scope limits.

The [v0.6 release plan](PLAN.md#v06-draft-saved-runs-and-safe-resume) adds
opt-in saved runs, local history, and continuation after a clean stop on the
same machine and Git worktree. In this source checkout, `--save-run` connects
the bounded store to the orchestration loop, and `--list-runs` / `--show-run`
inspect local history. `--resume` reviews and continues an eligible clean stop
on the same machine and canonical Git worktree. Try it with:

```bash
pnpm dev -- . "Inspect this repo and choose the safest useful first action" --mock --orchestrate --save-run
pnpm dev -- --list-runs --plain
pnpm dev -- --show-run <run-id> --plain
pnpm dev -- --resume <run-id> --plain
```

Saving requires a Git worktree with a committed HEAD. The CLI prints the run
ID and final status. Store and worktree ownership conflicts stop before
inspection, evaluation, or execution. Worktree locking also applies to
unsaved orchestration; those runs still do not persist task state. Saved
records remain separate from diagnostic traces, and an unresolved execution
or storage failure cannot be treated as a clean continuation point. The
published `0.5.0` CLI does not include this in-progress v0.6 feature. The
versioned format, local integrity checks, and current Windows limits are
documented in [saved-run storage contract v1](docs/saved-runs-v1.md).

History inspection works without provider credentials or network access, even
if the repository has been removed. It reads the existing store without
creating directories, changing permissions, taking locks, or writing traces.
The listing shows at most 20 records: unreadable records first, then valid
records by most recent update. `--show-run <run-id>` can inspect any known UUID,
including an older record omitted from the list. Neither command accepts task
arguments, execution flags, or `--json`; `--plain` is the only display option.
Pipes, CI, `NO_COLOR`, and `TERM=dumb` also select plain output.

Each record shows its saved task/repository, status, consumed and remaining
iterations, worker allowances and restrictions, provider/model/network
selection, pending validation, last recorded failure, and continuation blockers.
Detail adds the saved HEAD, stop reason, current directory availability, and
the last 12 ledger events. Budgets come from durable reservations; an attempt
without an outcome stays charged. An ownership file is reported as present
without guessing whether its process is alive or deleting the lock. A corrupt
or unsupported record displays only its ID and error, with no unverified task
or budget values. Missing/unreadable records or ignored unrecognized entries
return exit code 1; an empty store or successfully inspected blocked/finished
record returns 0.

History is a reporting snapshot. Directory availability does not check current
HEAD, working-file contents, or configuration, and earlier validation passes
will not authorize completion after restart. Records may contain task text and source excerpts; the
store is local and unencrypted. There is no deletion or retention command yet.
See the storage contract for platform paths and manual housekeeping guidance.

Resume loads the stored task, original iteration ceiling, consumed worker
calls, and fixed mock/live, provider/model, worker, and network selections.
It accepts only the run ID and optional `--plain`; task and execution overrides
are rejected. Live runs reload credentials from the current environment, using
the saved provider/model when selectors are unset. Explicit conflicting
selectors or a changed Cloudflare account block continuation. Other providers
have no non-secret account identifier in this client; the review explains that
credential account continuity cannot be verified. A model alias also does not
pin the remote deployment served later.

The review shows remaining limits, prior stop, repository drift, fresh checks,
and required instruction reads. Type `continue` to enter the next unused
iteration or `stop` to leave the record unchanged. Continuing after a recorded
evaluation failure also makes its explicit recovery decision once in that
review. The review approves no action. File candidates are rebuilt, earlier
reads are discarded, root instructions require approved reads, and validation
starts a fresh generation. Original required checks remain required even if a
script has been removed. Every tool/worker, check, and completion still needs
its own approval. Traces identify the saved run and segment; elapsed phase
times exclude the time between processes and report continuation waits
separately from active work.

A clean stop now saves bounded content fingerprints in `repository.json`,
bound to its ledger event. It covers tracked and untracked files, including
Git-ignored source, outside fixed generated/secret exclusions. Comparison is
limited to 512 paths, 1 MiB per file, and 32 MiB total; oversized, linked, unstable,
or otherwise unverifiable input blocks continuation. Removed root instructions,
changed HEAD/worktree identity, incomplete records, and unresolved ownership or
execution also block it. Partial edits are kept, including operator changes;
the CLI never restores files or resets Git. Older development records without
content fingerprints remain inspectable; start a new saved run to use resume.
Full platform/provider restart verification and the live pilot remain required
before the v0.6 release.

## v0.3 decision-model release

Version 0.3 adds explicit Cloudflare Clef/Clef-flash and OpenAI Decisions
through OpenRouter, shared assessment enforcement, provider-neutral selection
with compatibility aliases, model attribution, and opt-in comparison tooling.
See the [release notes](CHANGELOG.md) for migration, configuration, prerequisites,
data handling, and limitations. The npm package is now `dev-orchestrator`,
with a Node.js 22+ requirement. Published version `0.3.0` uses `jev-agent`;
published `0.3.1` renames the command to `dev-agent`. The
[0.3.1 publication record](docs/releases/dev-orchestrator-0.3.1.md)
includes source attribution, checksums, and registry installation verification.
The original GitHub release
archive and its checksum remain recorded under `jev-orchestrator@0.3.0`.

The direct TypeSafe/Jev default, manual approvals, worker restrictions,
validation requirements, and policy thresholds are preserved. The GitHub and
npm releases have separate artifacts, with their source and verification
evidence recorded in PLAN.

## v0.2 orchestration release

Version 0.2 preserves the read-only decision-only default and packages the
explicit approval-gated orchestration loop. Its executable set includes bounded
search and reads, two fixed Git diagnostics, detected validation scripts, and
bounded Claude Code or Codex delegation. Every executable candidate still
requires approval, every iteration is traced, and completion still requires
passing validation when available.
