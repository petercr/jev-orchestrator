# Dev Orchestrator plan

## Goal

`dev-orchestrator` is a small Node/TypeScript CLI that tests whether typed
decision models can steer a coding-agent workflow under deterministic local
policy. The supported decision models include TypeSafe AI's Jev, Cloudflare
Clef/Clef-flash, and OpenAI Decisions through OpenRouter. The repository is
[`petercr/jev-orchestrator`](https://github.com/petercr/jev-orchestrator).

Build on the published v0.3.1 CLI, preserving the decision-only default and
explicit approval-gated orchestration mode. Decision-only collects a bounded
repository snapshot, asks the selected decision model for a typed recommendation,
applies local policy, prints the unexecuted decision, and can write a safe JSONL
trace. Orchestration may execute only repository-owned bounded candidates after
manual approval.

The governing architecture is:

```text
selected decision model recommends
      ↓
TypeScript policy authorizes
      ↓
approved tool or coding worker executes
```

Decision models supply probabilistic, high-level judgment only. They must never
authorize destructive work, invent shell commands, or supply arbitrary paths,
queries, or tool arguments.

## Proposed release sequence

Version 0.4 is delivered. Versions 0.5 and 0.6 remain planning targets, not
implemented features or release commitments.

| Version | Primary outcome | First deliverable |
| --- | --- | --- |
| [v0.4](#v04-draft-reliable-task-workflows) | More reliable completion of bounded coding tasks | Reproducible complete-workflow baseline |
| [v0.5](#v05-candidate-terminal-presentation-and-interaction) | Clearer, more polished terminal interaction | Offline terminal UI prototype and library decision |
| [v0.6](#v06-draft-saved-runs-and-safe-resume) | Stop a run and continue it later with its context and remaining limits | Versioned saved-run contract and offline recovery fixtures |

## v0.4 draft: reliable task workflows

Drafted on 2026-10-17 after completion of v0.3 and publication of
`dev-orchestrator@0.3.1`. The operator confirmed v0.4 as the next version;
the original proposal and delivery evidence are retained below. Published as
[`dev-orchestrator@0.4.0`](https://www.npmjs.com/package/dev-orchestrator/v/0.4.0)
on 2026-10-19; the [publication record](docs/releases/dev-orchestrator-0.4.0.md)
pins the verified source and archive. Implementation started with the
[offline complete-workflow baseline](docs/workflows/v0.4-baseline.md).

The proposed outcome is a CLI that gets a bounded coding task through
preparation, implementation, independent validation, and acceptance review
with fewer avoidable routing detours. When progress is blocked, the operator
should see the specific missing evidence or exhausted limit and the permitted
next choices. Normal action approvals and task-acceptance review remain part
of a successful workflow.

### Evidence and starting point

- The [v0.3 decision comparison](docs/benchmarks/v0.3-decisions.md) exercised
  14 synthetic states and retained 168 evaluations. It established explicit
  provider routes under the existing policy, but did not execute coding tasks.
- In the [issue #31 worker comparison](docs/benchmarks/issue-31.md), all six
  Jev loops needed a manual worker alternative; the four completed Jev loops
  also needed a manual completion alternative. One loop retained an accepted
  patch but exhausted its iteration budget before completion approval. That
  study used v0.2, one task, and first attempts only; it is evidence for what
  to investigate, not a measured v0.3.1 failure rate.
- The current evaluator already receives preparation progress, permitted
  workers, prior evidence, pending validation, and remaining iterations.
  Start by reproducing failures against this implementation; additional
  prompt text or a new state-machine abstraction needs a demonstrated gap.
- Existing summaries already separate active time from prompt waits and
  report worker, evaluation, recovery, and validation outcomes. Extend that
  reporting only where it cannot explain an observed interruption or detour.

Success measures are accepted patches, completed approval loops within the
existing limits, manual routing alternatives, redundant recommendations,
evaluation failures/recoveries, and active time. Report ordinary approvals
separately from manual alternatives. A necessary request for missing context
is a valid outcome; reducing the total number of `ASK_USER` results is not an
independent objective. An accepted patch and a completed run are separate
results.

### Implementation order

1. [x] Define and reproduce complete workflows on the current release.
   Freeze a small task suite covering a bug fix with regression tests, a
   bounded feature, and failed validation followed by controlled repair.
   Each fixture needs explicit task acceptance criteria and independent checks.
   Reserve an additional task from routing changes for later verification.
   Extend the existing provider/orchestration coverage with complete sequences
   through the real policy, candidate selection, approval, and loop layers;
   mock only provider and process boundaries. Cover both worker selections,
   all six provider/model routes, and a legitimate missing-context stop.
   Include failed evaluation and explicit recovery, cancellation, stale
   validation, exhausted worker/iteration budgets, and omitted checks.
   The first deliverable is an offline baseline and a list of reproduced
   failures with their owning layer. It must run without credentials or live
   workers and must not rewrite historical benchmark fixtures or results.
   Scripted provider responses establish enforcement behavior, not live model
   routing quality. Preserve sanitized recorded assessments where available,
   and label hypotheses that need fresh live observations.
   Delivered in [protocol v1](docs/workflows/v0.4-baseline.md): three frozen
   tasks across six model routes and both workers, real independent Node checks,
   recovery/interruption and budget cases, a stop/ownership inventory, and the
   reserved `stable-tags` task. The 183 offline tests reproduce enforcement and
   manual alternatives without making live routing-quality claims.

2. [x] Make routing blockers and operator choices understandable.
   Use the reproduced cases to distinguish a provider recommendation, a
   policy override, and a candidate that cannot be offered. Show bounded
   reasons such as unread instructions, missing task context, pending or
   failed validation, insufficient confidence, and exhausted call limits.
   Reuse existing progress and summary data; count normal approvals, manual
   alternatives, and evaluation recovery separately. Keep reporting outside
   authorization state and preserve JSON/trace compatibility, with an explicit
   schema decision if an incompatible change is needed. Complete when an
   operator can understand each fixture's stop and permitted next choice
   without inspecting raw provider output or a full trace.
   Keep wording and readable grouping in this slice; the dedicated visual
   refresh and terminal-library evaluation are tracked in the v0.5 candidate
   below.
   Delivered in the [routing explanation guide](docs/workflows/v0.4-routing-explanations.md):
   grouped model/policy/candidate reviews, bounded current-generation evidence,
   explicit manual-alternative provenance, actual remaining limits, separate
   interaction counters, and recovery/terminal guidance. Display-only snapshots
   do not enter authorization state or change the existing JSON/trace schemas.

3. [x] Fix reproduced routing detours with focused changes.
   Investigate repeated preparation reads, missed first-worker routes,
   redundant testing, diagnosis/repair after failed checks, and completion
   review against current state. For each deterministic fix, retain a
   failing-before, passing-after workflow regression and explain which evidence
   was missing or misrepresented. Update shared snapshot construction or
   question criteria only where the reproduction supports it, then exercise
   every provider route. Prompt changes need bounded-input/contract regressions
   plus live comparison evidence; a mocked recommendation cannot establish
   that the model's routing improved.
   Preserve the existing action vocabulary and enforce all final approval
   checks. If a model still abstains or returns invalid data, retain the
   bounded failure and explain the manual alternative. Provider confidence
   and malformed distributions must never be repaired to force progress.
   Complete local verification under the same enforcement rules. Freeze the
   candidate before evaluating the reserved task in step 4.
   Delivered in the [repair routing candidate](docs/workflows/v0.4-repair-routing.md):
   a clear same-worker repair recommendation survives a high testing assessment
   when a current-generation independent check failed after that worker attempt.
   Twelve labeled workflow variants reproduce the former detour across all six
   provider routes and both workers, without changing the frozen baseline,
   prompts, confidence, or budgets. Preparation and completion investigations
   retain their existing guards; live routing quality remains for step 4.

4. [x] Verify actual workflows with a bounded live comparison.
   Add a separately versioned protocol for the current package; the issue #31
   harness remains pinned to its historical v0.2 source. Freeze tasks,
   repository revisions, package hashes, model routes, worker/model/effort,
   permissions, validation, run order, and observation/call limits before
   collection. Live collection is opt-in and uses operator-authorized
   repositories and services within that recorded budget. Begin with a small
   pilot comparing direct TypeSafe/Jev and explicitly selected OpenRouter
   Decisions while holding
   the worker fixed; cover both adapters in the overall walkthroughs.
   Compare the v0.3.1 baseline with the candidate under the same protocol,
   including the reserved task and a separately labeled repair scenario.
   Every action, recovery, and completion receives its real approval; the
   harness must not generate approvals. Retain failed/interrupted observations
   and disclose missing model access. Record acceptance, loop completion,
   detours, validation, and timing separately; retain usage/cost only when
   actually reported. Further repetitions or provider cohorts need a recorded
   budget before execution. Complete with a reproducible report that states
   where improvement occurred and where manual routing is still required.
   Delivered in the [versioned live pilot report](docs/workflows/v0.4-live-results-v1.md):
   eight retained launches, seven accepted/completed workflows across Jev,
   Decisions, Codex, and Claude, both real staged repairs, and two explicit
   evaluation recoveries. One entry-point launch failed before evaluation;
   its missing comparison cell was not replaced. The report discloses a bounded
   trace-label limitation and a separate receipt audit. Live manual detours
   did not decrease, and the new repair exception was not needed in these
   live assessments. Release claims therefore remain clearer explanations
   and a deterministic repair-policy correction, without a claimed live
   reliability or speed improvement.

5. [x] Prepare and verify the v0.4.0 release.
   Update README, release notes, package metadata, and CLI version assertions
   after the accepted implementation is complete. Run focused tests, typecheck,
   the full test suite, production build, and schema-only validation. Install
   the exact packed archive in a disposable consumer and verify `dev-agent`,
   help/version, mock mode, provider selection/aliases, and the new reporting.
   Record the final source revision, archive checksum, and known limitations.
   Give the operator advance notice before npm publication starts any timed
   browser authorization, then verify the published archive and installation.
   Preparation verified on 2026-10-19 UTC; see the
   [v0.4.0 publication record](docs/releases/dev-orchestrator-0.4.0.md).
   Metadata/version assertions and release notes now target `0.4.0`. The 72
   focused CLI tests, typecheck, all 1,350 tests, production build, and schema
   validation passed. The exact archive passed 48 offline installed CLI checks,
   including 18 mocked transport requests and the new grouped review stopped
   before any approval or worker call. All 70 installed files match the archive;
   its 66 compiled files match the frozen live candidate. SHA-256:
   `95d2e8d8c155ead4fbe1dbdfb82e3272fa2ac6c6247bec23d4b959462cf00fa7`.
   PR #55 merged the preparation as `4dc76ae`; all 80 source hashes and 70
   packed files match that accepted source. The merged-source checks and a
   fresh 48-check offline installation also passed. Published on npm on
   2026-10-19 at 20:45:14 UTC after operator browser authorization, with
   `latest: 0.4.0`. The public archive matches the retained archive byte for
   byte and all three recorded digests. A fresh registry installation passed
   the same 48 CLI checks and 18 mocked requests; all 70 installed package
   files and lockfile integrity match. Initial registry propagation misses
   remain recorded. Publication documentation follows the frozen source and
   does not repack the archive.

### Release gate and scope

- [x] Complete offline workflows cover successful implementation, controlled
  repair, valid requests for context, recovery, interruption, and budget stops.
- [x] Every claimed routing improvement has a reproduced baseline and
  appropriate deterministic or live evidence; approved execution never
  bypasses policy or candidate checks.
- [x] The live report separates required approvals from routing alternatives,
  accepted patches from completed runs, and active time from operator waits.
  It includes the reserved task and retains failures. Reduced detours are
  assessed alongside acceptance and completion; a faster failed run is not an
  improvement. If the pilot does not support a reliability improvement,
  revisit this release claim before packaging.
- [x] Existing independent-validation, worker-selection, network-selection,
  cancellation, and credential-handling guarantees pass their regressions.
- [x] The exact installed package and publication pass the recorded release
  checks, with documentation describing the behavior actually delivered.

Keep the eight-iteration and two-calls-per-adapter limits, 95% automatic
completion threshold, fresh independent validation after every worker attempt,
and explicit acceptance review. Provider selection stays fixed for a run;
direct TypeSafe/Jev remains the default. A benchmark result alone cannot change
that default, thresholds, permissions, or approvals.

Durable resume is proposed for [v0.6](#v06-draft-saved-runs-and-safe-resume).
Unattended approval, automatic provider/worker failover, expanded command
permissions, new provider transports, and a general setup wizard remain
separate candidate milestones. This draft focuses v0.4 on the existing bounded
workflow. Traces remain diagnostic records.

## v0.5 candidate: terminal presentation and interaction

Requested on 2026-10-17: make `dev-agent` look and feel better, potentially
using a Node terminal UI library. Recommended placement is v0.5, alongside
v0.4's clearer blocker messages and output grouping. The operator confirmed
moving on to v0.5 on 2026-10-21. Implementation started with the
[offline presentation prototype](docs/presentation/v0.5-prototype.md); Clack is
selected for the following integration step.

The current CLI uses `console.log` and `node:readline/promises` in
`src/cli.ts`. Presentation can move behind a small CLI-owned adapter while
policy, candidate selection, approval decisions, and execution retain their
existing boundaries. The intended experience includes a concise run header,
readable action/parameter review, consistent status labels, phase progress,
keyboard-friendly alternatives, and a clear validation/result summary.

### Initial library shortlist

Official documentation and public npm metadata checked on 2026-10-17. These
versions are research observations, not dependency selections; recheck stable
APIs, transitive dependencies, and supported Node versions during the prototype.

| Option | Fit for this CLI | Integration consideration |
| --- | --- | --- |
| [Clack](https://bomb.sh/docs/clack/packages/prompts/) (`@clack/prompts` 1.8.1) | First prototype candidate: styled prompts, logs, notes, and progress indicators in one toolkit. | Documents custom streams and AbortSignal support. Published Node requirement is `>=20.12.0`, compatible with this package's Node 22 floor. Verify cancellation semantics and plain rendering in our loop. |
| [Inquirer](https://github.com/SBoudrias/Inquirer.js) (`@inquirer/prompts` 8.7.3) | Alternative for composable interactive prompts; output layout would still be our responsibility. | Documents abortable prompts and explicit handoff from readline. Its Node 22 range starts at 22.13.0, so adopting this version would require resolving the current `>=22` compatibility promise. |
| [Ink](https://github.com/vadimdemedes/ink/blob/v8.0.0/readme.md) (`ink` 8.0.0) | Candidate if we want a persistent dashboard with React components and terminal layouts. | Published Node requirement is `>=22`; React `>=19.3.0` is a peer dependency. It adds a renderer and input lifecycle, so assess that scope against the smaller prompt-based design. |

Version/engine observations come from the public registry records for
[Clack](https://registry.npmjs.org/@clack%2fprompts/1.8.1),
[Inquirer](https://registry.npmjs.org/@inquirer%2fprompts/8.7.3), and
[Ink](https://registry.npmjs.org/ink/8.0.0). The recommendation to prototype
Clack first is a project-fit judgment, not a measured performance comparison.
These initial observations preceded implementation; the prototype and current
dependency decision are recorded below.

### Proposed delivery and acceptance

1. [x] Build a small offline presentation prototype using synthetic run data:
   one action review, a worker/validation progress sequence, a blocked run,
   and a final summary. Compare Clack with the existing plain interface;
   investigate Ink further if a persistent dashboard is a desired outcome.
   Record the chosen library, runtime/dependency impact, and terminal behavior
   before expanding the integration.
   Delivered in the [prototype and library decision](docs/presentation/v0.5-prototype.md):
   `pnpm prototype:ui` compares the existing plain formatters with pinned Clack
   1.8.1 across four synthetic scenes. The library is a development dependency;
   the production CLI and authorization paths remain unchanged. Twenty-seven
   deterministic tests and thirteen WSL PTY walkthroughs cover review content,
   static fallbacks, bounded input, narrow output, EOF, signals, and terminal
   restoration. The native spinner's Ctrl+C exit-0 behavior is reproduced and
   avoided by keeping progress and cancellation under application control.
2. [ ] Integrate the chosen presentation through a narrow CLI adapter.
   Display the resolved candidate's action, parameters, worker/network
   permissions, and reason before explicit approval. A selected alternative
   still receives its own resolved-candidate review; completion still requires
   acceptance review. Empty input, prompt defaults, timeout, EOF, and library
   cancellation must never become approval or recovery. Preserve typed
   stop/quit and signal-driven cleanup through the existing run controller.
3. [ ] Verify interactive terminals, narrow widths, long paths, Windows/WSL,
   and plain non-TTY/CI output. Honor `NO_COLOR`, provide readable static
   output for accessibility, and keep JSON output and trace data free of
   styling and spinner frames. Keep untrusted terminal control sequences from
   obscuring the candidate review. Exercise interrupted prompts and active
   execution, process cleanup, terminal restoration, and final exit statuses.
   Verify the packed CLI with both styled and plain output. The presentation
   layer must preserve budgets, validation evidence, and approval enforcement.

## v0.6 draft: saved runs and safe resume

Drafted on 2026-10-17 at the operator's request to plan v0.6. Saved runs and
safe resume are the proposed focus, building on v0.4's workflow behavior and
v0.5's presentation work. This is a design proposal; implementation has not
started and the published CLI has no resume command.

The intended outcome is to stop an opted-in orchestration run, close the
terminal, and later continue the same task without reconstructing its context
or losing track of consumed limits. A local history view should explain what
happened, what remains, and whether continuation is possible. An existing
task's partial edits stay in its working tree.

### User workflow and first-release boundary

Provisional command shape, to be finalized with CLI compatibility tests:

```text
dev-agent . "Fix the bug and add regression tests" --orchestrate --save-run
dev-agent --list-runs
dev-agent --show-run <run-id>
dev-agent --resume <run-id>
```

Saving is opt-in for orchestration. Listing and showing runs are read-only
local operations with bounded output. `--resume` explicitly reopens a saved
orchestration run; every resolved action still requires approval. Keep these
options distinct from existing repository/task positional arguments, and keep
decision-only behavior unchanged. Run IDs resolve only inside the application's
run store; they are not arbitrary file paths or shell arguments.

The first release supports continuation on the same machine and canonical
repository/worktree after a typed stop, an evaluation-failure stop, or a signal
interruption whose process cleanup completed. Finished runs and runs at the
iteration limit remain inspectable. Resume cannot grant extra iterations or
worker calls. A new task with a new budget is a separate explicit run.

An unclean termination with an unresolved execution is inspectable but cannot
resume execution in this first slice. Never replay an uncertain action, assume
an orphaned worker has exited, or roll back partial edits. Cross-machine
transfer, background workers, worker-native conversation restoration, and
automatic retry after a crash are later scope.

### Saved-run and continuation contract

- Store a bounded, versioned checkpoint separately from JSONL traces. Current
  traces truncate values and arrays and cannot reconstruct complete state;
  neither old nor new traces become executable resume inputs. Freeze the
  checkpoint's schema, size limits, status transitions, and compatibility rules
  before integrating execution. Unsupported versions must fail explicitly.
- Preserve the original task, bounded approved context and its provenance,
  repository identity, instruction/validation metadata, frozen provider/model,
  worker selection and network permission, consumed budgets, and failure
  history. Keep transport objects, credentials, raw environment values,
  AbortSignal, and executable approval objects out of the format. Record only
  non-secret configuration identity; reload credentials from the operator's
  environment and reject provider/account or permission changes during resume.
- Use an operator-owned application state directory outside worker-writable
  repositories, with restricted access, bounded reads, and atomic checkpoint
  replacement. Define integrity and sequence checks against an authoritative
  local attempt ledger. Validate persisted content as untrusted input; a
  checksum by itself is not authorization. Reject malformed, truncated,
  altered, or stale checkpoints instead of repairing counters or flags.
- Record iteration consumption before evaluation and reserve worker allowance
  durably before dispatch. Record outcomes without charging the same attempt
  twice. An uncertain reserved attempt stays charged and is reported as
  uncertain, without inventing a successful execution or an approval. If a
  required durable write fails, start no further evaluation or execution;
  drain any active cleanup and explain the last trustworthy checkpoint.
- Acquire exclusive ownership of the saved run and prevent another app-managed
  run from using the same worktree concurrently. An unresolved active owner or
  stale lock blocks execution; never kill a process based only on a saved PID.
  The design must account for process cleanup before a run becomes resumable.
- Refresh repository state before continuation. A different worktree, changed
  HEAD, unavailable repository, or unbounded/ambiguous identity check blocks
  resume. Show any working-tree drift, retain historical evidence as historical,
  and use the existing clarification/preparation gates when task context needs
  review. Changed instruction files require new bounded reads and approval.
  Do not restore Git state, replace files, or revert operator edits.
- Start a fresh validation generation on resume; prior passing checks remain
  history and cannot authorize completion. Rebuild candidates from current
  state and require new approvals, including acceptance review for `FINISH`.
  Resume of an evaluation failure retains its explicit recovery requirement.
  A saved proposal, old approval, or worker test claim grants no authority.
- Retain the eight-iteration and two-calls-per-adapter ceilings across every
  process segment. Selection and permission flags remain immutable; fresh
  validation also consumes the remaining budget. Insufficient budget must
  produce the existing bounded stop rather than silently extend the run.
  Link segment traces and summaries by run identity while keeping metrics
  outside authorization state. Measure active time with each process's local
  monotonic clock; time between sessions is not active work or prompt wait.

### Implementation order

1. [ ] Define the checkpoint schema, attempt ledger, storage bounds, and
   lifecycle. Document exactly which fields are restored, revalidated, or
   historical, and how integrity, write ordering, locks, and compatibility are
   enforced. Add offline fixtures for clean stops, exhausted limits, incomplete
   writes, altered counters/permissions, stale checkpoints, and unresolved
   executions. No execution path may accept a saved record until this contract
   is validated.
2. [ ] Add opt-in persistence to the existing orchestration lifecycle. Persist
   budget reservations before dispatch and completed transitions afterward;
   preserve existing signal cleanup and trace behavior. Test failures before
   and after each durable boundary so restarting cannot duplicate execution,
   reset budgets, or lose an in-flight attempt from the record.
3. [ ] Add local run listing and inspection with the plain and styled CLI
   presentation. Show task/repository identity, last status, remaining budgets,
   pending validation, failure/interruption, and a specific resume blocker.
   These commands must not call a provider, invoke a worker, or change the
   selected repository. Keep context bounded and credentials redacted.
4. [ ] Add explicit resume for eligible saved runs. Resolve the same repository
   and immutable configuration, obtain exclusive ownership, refresh evidence,
   invalidate validation, and enter the loop at the next unconsumed iteration.
   Retain approved clarification provenance and failure history; require the
   existing action, recovery, and completion decisions. Incompatible or
   incomplete records remain inspectable without being executable.
5. [ ] Verify and prepare v0.6.0. Exercise stop/restart/resume through mocked
   provider/process boundaries for both workers and all supported routes, plus
   an operator-authorized live stop/resume walkthrough for each worker. Cover
   cancellation, EOF, changed worktrees/instructions, missing credentials,
   storage failures, concurrent resumes, and exhausted budgets. Run focused
   tests, typecheck, the full suite, build, schema validation, and installed
   package checks; document migration, local storage, and known limits. Record
   release source and archive evidence, give advance npm authentication notice,
   and verify publication through a separate registry installation.

### Release gate

- [ ] A cleanly stopped saved run resumes in a new CLI process, preserves task
  context and remaining limits, and finishes only after fresh validation and
  explicit acceptance approval. Both worker adapters are covered.
- [ ] Old approvals, changed permissions, wrong repository identity, tampered
  or incompatible state, unresolved attempts, and concurrent owners cannot
  cause execution. Exhausted budgets cannot be reset through resume.
- [ ] Failure-injection tests establish durable write ordering and conservative
  attempt accounting. Trace compatibility, credential exclusion, cleanup, and
  preservation of operator edits pass their regressions.
- [ ] History and both presentation modes clearly distinguish resumable,
  blocked, finished, and budget-exhausted runs. The exact installed package and
  recorded live walkthroughs pass before release.

## v0.3.0 release: multiple decision models

Release candidate prepared and verified on 2026-10-16: v0.3.0. The shared
evaluation boundary supports Jev, Cloudflare Clef/Clef-flash, and OpenAI
Decisions through OpenRouter as explicit alternatives. Package verification
and release notes are complete. The final release commit and archive were
recorded and checked on 2026-10-17. The `v0.3.0` tag and
[GitHub release](https://github.com/petercr/jev-orchestrator/releases/tag/v0.3.0)
were published that day, followed by the separately named
[dev-orchestrator@0.3.0 npm release](docs/releases/dev-orchestrator-0.3.0.md).
Historical milestones below describe the implementation at the time they were
completed.

The release delivers explicit selection among Jev, Cloudflare Clef/Clef-flash,
and OpenAI Decisions through OpenRouter, with one shared policy contract.
Ship the provider-neutral configuration, compatibility aliases, model attribution,
documentation, verification tooling, and comparison evidence together. Keep
direct TypeSafe/Jev as the default for v0.3.0; any later default change requires
a separate decision based on the comparison results.

Direct OpenAI transport, automatic model/provider selection or failover,
ensembles, policy-threshold changes, and expanded worker permissions are outside
v0.3.0. The original GitHub release retained its package name; the separately
authorized npm-package rename is tracked below. The matched coding-worker baseline from
issue #31 is separate from this release's comparison, which uses bounded decision
snapshots and does not require new paid coding-worker pilots.

### Verified API targets

Official documentation checked on 2026-10-11; Cloudflare and OpenRouter Decisions
contracts rechecked on 2026-10-15:

| Decision model | Service and API | Planned configuration | Status |
| --- | --- | --- | --- |
| Jev | Existing direct TypeSafe, OpenRouter Decisions, and Vercel evaluation transports | Existing keys and model namespaces | Implemented baseline; retain direct TypeSafe default |
| Clef / Clef-flash | Cloudflare Workers AI, `POST https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/@cf/cloudflare/{model}` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AUTH_TOKEN`; model `clef` or `clef-flash` | Adapter implemented locally; both models live-verified on the tested account on 2026-10-15 |
| OpenAI Decisions via OpenRouter | Existing `POST https://openrouter.ai/api/alpha/decisions` | `OPENROUTER_API_KEY` (or existing `OPENROUTE_API_KEY` alias); model `openai/gpt-6-luna-decisions` | Contract covered by deterministic regressions; live-verified on the tested account on 2026-10-15 |

Cloudflare documents System One compatibility and a request containing
`model`, `state`, and named `questions`. Its model selectors map to Workers AI
IDs `@cf/cloudflare/clef` and `@cf/cloudflare/clef-flash`. Documentation rechecked
on 2026-10-15: REST responses use the Workers AI `success`/`errors`/`result`
envelope; tokens need Workers AI Read and Edit on the selected account. The
adapter validates this envelope and the model's published answer schema.
Authorized synthetic live checks normalized responses for both models on
2026-10-15; other accounts must establish their own access.
Sources: [Clef launch](https://blog.cloudflare.com/clef-decision-models/),
[Clef API](https://developers.cloudflare.com/workers-ai/models/clef/), and
[Clef-flash API](https://developers.cloudflare.com/workers-ai/models/clef-flash/).

Use OpenRouter as the initial access path for OpenAI Decisions. OpenRouter
documents `openai/gpt-6-luna-decisions` on its existing Decisions endpoint,
with `state` and named `noul`/`choice`/`score` questions. Reuse the current
four Noul questions and action Choice; verify normalization, confidence,
served-model attribution, and refusal/error behavior for this model.
No separate OpenAI credential is required for this route.
Source: [OpenRouter GPT-6 Luna Decisions](https://openrouter.ai/openai/gpt-6-luna-decisions).

Direct OpenAI access is an optional later transport, outside this milestone's
acceptance gate. Its `input`, predicate questions, and named answer arrays
would need a separate schema adapter and `OPENAI_API_KEY`. Keep those wire
formats distinct from OpenRouter's normalized contract.
References: [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions)
and [API reference](https://developers.openai.com/api/reference/typescript/resources/decisions/methods/create).

### Shared contract and configuration

- Keep `AgentAssessment`, the five assessment questions, and `ACTIONS` owned
  by this repository. Each provider maps the same bounded snapshot and question
  intent into its API, then returns strictly validated repository types.
- Introduce provider-neutral evaluation/configuration/error names with small
  typed adapters. Reuse `src/ai/contract.ts` and bounded transport helpers;
  provider envelopes and schemas stay outside policy and orchestration.
- Plan `ROUTER_PROVIDER=typesafe|openrouter|vercel|cloudflare`, retaining
  `JEV_PROVIDER` as a compatibility alias. If both are supplied and disagree,
  fail before a request. Preserve existing credential aliases and
  `ROUTER_MODEL`; validate models within their selected provider's namespace.
  For Cloudflare, map `clef`/`clef-flash` to fixed Workers AI paths.
  Select OpenAI Decisions with provider `openrouter` and
  `ROUTER_MODEL=openai/gpt-6-luna-decisions`; distinguish transport provider
  from model vendor in documentation and benchmarks.
- Resolve provider/model/account selection once per run and preserve it through
  recovery. Require only the selected provider's credentials. No automatic
  provider failover, ensemble, or routing among decision models in this milestone.
  Repository text, worker output, and clarification cannot change selection.
- Record sanitized provider and requested/served model attribution, omitting
  unavailable served versions. Keep keys in transport configuration, outside
  serializable state, candidates, snapshots, and traces. Keep AbortSignal separate.
- Decision-provider selection is independent of `--worker codex|claude` and
  `--codex-network`. Those controls continue to restrict worker execution.
  An OpenAI decision model can recommend either permitted coding worker.
- Preserve the package/CLI names and TypeSafe default for compatibility. Use
  provider-aware CLI labels; retain old trace readability and explicitly migrate
  Jev-specific serialized labels if needed. Update README, `.env.example`,
  AGENTS.md, mocks, types, and verification tooling with implementation.

### Policy and transport requirements

All adapters must preserve finite probabilities in `[0, 1]`, the `0.001`
distribution-sum tolerance, known actions, and valid choice/confidence values.
Do not repair malformed distributions by renormalizing them or derive missing
confidence from the selected probability. Missing confidence remains absent.
Reject missing/duplicate/unexpected question names, incompatible answer types,
and incomplete native action distributions before policy receives an assessment.
An OpenAI refusal of a required question becomes a safe evaluation failure,
never a fabricated probability or executable recommendation.

Preserve the overall 10-second deadline, at most one transient retry, 64 KiB
response bound, cancellation, safe error classifications, and explicit evaluation
recovery with retained budgets. Use fixed hosts/paths with validated account and
model identifiers, no arbitrary base URLs or redirects, and redact all configured
provider secrets from every existing output/evidence surface. Do not retain raw
upstream errors or refusal text. Preserve the allowlisted `probabilitySum`
diagnostic only for `invalid_response` at `distribution/sum`.

Local policy remains authoritative for preparation, worker restrictions,
missing information, ambiguity, repeated failure, and completion. Keep every
manual approval, eight-iteration limit, independent two-call worker budget,
fresh independent validation requirement, and original-task acceptance review.
Retain the 95% automatic completion threshold. API compatibility does not
establish equivalent confidence calibration; do not lower thresholds to make
a new provider delegate or finish more often.

### v0.3.0 implementation order

Preparation: Varlock 1.22.0 is pinned as development tooling, with a committed
`.env.schema`, sensitive canonical keys/aliases, redacted configuration checks,
and explicit `dev:env`/`start:env`/`env:run` wrappers. Schema-only CI and ordinary
mock/test/build commands stay keyless. Local values are preserved and package
runtime behavior is unchanged. Provider-neutral configuration follows in step 1;
new model routes remain the later slices below.

1. [x] Extract the neutral provider boundary and add configuration migration.
   Prove existing Jev transports, default selection, mock mode, traces, and
   recovery preserve their behavior, including conflicting selector rejection.
   Implemented locally on 2026-10-14: neutral configuration/types/errors with
   legacy export aliases, `ROUTER_PROVIDER` plus conflict-checked `JEV_PROVIDER`,
   model namespace validation, and one bound evaluator per CLI run. Varlock
   selectors have no schema defaults so neither alias shadows the other; code
   retains the direct TypeSafe default. Existing trace schemas, `mock/jev`, and
   the serialized `jev_finish` label remain compatible. Validation passed:
   typecheck, 609 deterministic tests, build, schema and local preflight checks,
   and an offline install of the exact packed archive with mock, configuration,
   attribution, and synthetic verifier checks. Those checks used no live calls.
   Authorized live follow-up on 2026-10-14 normalized direct TypeSafe
   (`jev-latest` served `jev-1.13.0`) and OpenRouter
   (`typesafe/jev-1.13` served `typesafe/jev-1.13-20260917`). Vercel failed
   with an authorization classification; account/model access remains unverified.
   A live TypeSafe CLI walkthrough passed: two iterations, one approved
   `READ_FILE`, then an explicit stop, with zero worker calls or source edits.
   New model adapters and their live verification remain pending below.
2. [x] Add Cloudflare Clef and Clef-flash through the shared System One
   questions and a bounded REST adapter. Cover account/model path validation,
   response envelopes, attribution, errors, and both model selections.
   Implemented locally on 2026-10-15: fixed model/account paths, immutable
   account selection, shared Noul/Choice questions and normalization, strict
   REST envelope/duplicate-key checks, bounded retries/cancellation, token
   redaction, and Varlock/CLI setup. The opt-in verifier accepts both Cloudflare
   selectors. Authorized live checks passed on 2026-10-15: requested and served
   names matched `clef` and `clef-flash`; the service returned no pinned revision.
   Only synthetic state was sent and no coding workers were called.
   Validation passed: 736 deterministic tests, typecheck, build, schema-only
   validation, and an offline install of the packed archive. Installed CLI and
   verifier checks covered both model routes with mocked HTTP boundaries,
   selected-credential preflight, attribution, and keyless mock behavior.
   A live Clef CLI walkthrough on 2026-10-15 passed its read-and-stop audit:
   two iterations, one successful approved `READ_FILE`, then a `FINISH` request
   overridden to `ASK_USER` because the synthetic fixture had no validation
   script. The operator stopped; no coding workers or source edits occurred.
3. [x] Add verified OpenAI Decisions support through the existing OpenRouter
   transport using `openai/gpt-6-luna-decisions`. Reuse the four Noul questions
   and action Choice, preserving their criteria and the bounded fetch controls.
   Cover normalized answer/confidence shapes, missing answers, malformed option
   distributions, and upstream refusals/errors. Keep Jev's OpenRouter default
   and aliases working; require no direct OpenAI adapter or credential.
   Implemented locally on 2026-10-15: the existing transport accepts the explicit
   OpenAI model selection and retains the same five questions. Shared native
   normalization now requires exact question names; the bounded REST transports
   share duplicate-key rejection. Required-question refusals, incompatible direct
   OpenAI answer arrays, invalid probabilities/confidence, and malformed option
   distributions fail safely without repaired answers or raw refusal text.
   HTTP failures retain their status classification. Regression coverage runs
   the OpenAI selection through the existing transport suite, including policy
   guards, worker limits, fresh validation, explicit recovery, redaction, retries,
   cancellation, and no post-abort approval/execution. Typecheck, all 890 tests,
   build, and schema validation passed. The opt-in verifier accepts an explicit
   OpenRouter model argument. A synthetic live check on 2026-10-15 normalized
   the requested model, served as `openai/gpt-6-luna-decisions-20261006`.
   The direct TypeSafe default, OpenRouter's Jev default, and credential/model
   aliases are preserved; no direct OpenAI credential is used.
   A live CLI walkthrough with the same served model completed an approved
   `READ_FILE`, then overrode `FINISH` to `ASK_USER` for unavailable independent
   validation. The operator stopped after two iterations, with one approval,
   zero evaluation failures/recoveries, and no coding workers or source edits.
   The packed archive installed offline and passed installed CLI checks for the
   OpenAI route, compatibility aliases, model attribution, retained Jev default,
   selected-credential preflight, and keyless mocks. Mocked verifier checks also
   covered explicit OpenRouter model overrides and invalid opt-in arguments.
4. [x] Run a common deterministic contract and policy suite through mocked
   provider boundaries: confident/ambiguous routes, missing confidence,
   premature completion, preparation, worker restrictions, validation generations,
   recovery, limits, secret redaction, cancellation, and no post-abort execution.
   Run focused tests, `pnpm check`, `pnpm test`, `pnpm build`, and installed
   keyless mock checks. Automated tests must not call a live provider or worker.
   Completed locally on 2026-10-16: `src/ai/providers.test.ts` runs common
   assessment fixtures through all six routes (three Jev transports, both
   Cloudflare models, and OpenAI Decisions through OpenRouter), using each
   transport's wire envelope. The actual evaluator, policy, candidate selection,
   and loop enforce preparation, confidence, both worker selections/budgets,
   fresh validation, the 95% completion threshold, explicit acceptance review,
   recovery, and the eight-iteration limit. Mocked process results cover Codex
   and Claude failures/timeouts/malformed reports, preserved edits, validation
   invalidation, and cancellation without late approval or execution. Fixed
   endpoints, immutable configuration, safe failures, redaction, retry/deadline
   bounds, and response-stream cleanup also pass for every route. Provider-specific
   envelope/error regressions remain intact. Validation passed: 442 provider-suite
   tests, all 1,073 tests, typecheck, and build. The packed v0.2 archive installed
   offline and passed 12 keyless mock checks across canonical/legacy selectors
   plus three invalid-configuration mock checks, with fetch denied. This slice
   changes tests/documentation only and makes no new live provider or worker call.
5. [x] Extend explicit opt-in synthetic live verification to Cloudflare's two
   Clef models and OpenAI Decisions through OpenRouter. Record sanitized outcomes
   and actual account access; public API documentation alone does not complete
   this gate. Document each
   provider's data handling and prerequisites before sending repository evidence.
   Cloudflare's portion passed on 2026-10-15 for both models, with data-handling
   and setup documentation in README. OpenAI Decisions through OpenRouter also
   passed on 2026-10-15, served as `openai/gpt-6-luna-decisions-20261006`, using
   synthetic state and no coding workers. README documents the OpenRouter/OpenAI
   data path, account prerequisites, and retention limitations. These checks
   establish access for the tested accounts only, without claiming comparable
   routing quality or calibrated confidence; the comparison remains step 6.
6. [x] Compare Jev, Clef, Clef-flash, and OpenAI Decisions on the same bounded,
   labeled coding-task snapshots and record a v0.3.0 baseline. Include
   unread issue/instructions, clear implementation, ambiguity, stuck/recovery,
   failed/stale validation, excluded workers, redundant tests, and completion.
   Report routing correctness, unsafe recommendations, policy overrides,
   abstentions/manual alternatives, malformed answers/refusals, and latency
   distributions with sample counts and requested/served model versions.
   Evaluate probability/confidence calibration against labels; compare quality
   alongside latency. Report token usage only when explicitly returned and cost
   only from attributable usage and documented rates; metrics cannot authorize
   actions or alter budgets.
   Completed locally on 2026-10-16: the [decision snapshot report](docs/benchmarks/v0.3-decisions.md)
   and [aggregate JSON](docs/benchmarks/v0.3-decisions-summary.json) retain all
   168 scheduled observations (14 pre-labeled synthetic states × three
   repetitions × four fixed routes). The opt-in [harness](scripts/decisions/README.md)
   rotates order, verifies identical bounded evidence/questions, freezes route
   configuration, and preserves failures without executing tools or workers.
   Raw reference matches out of 42: Jev 22, Clef 36, Clef-flash 36, OpenAI 39.
   Guarded matches: 19, 33, 30, and 39; conservative ASK_USER stops are recorded
   separately from unsafe selections. Jev's two rejected distributions totaled
   about 0.99. No fixture-forbidden selection survived policy among 166
   normalized observations. Median evaluation latency was 114, 282, 563, and
   218 ms respectively, with full counts/distributions in the report. Probability
   Brier and separate confidence-reliability diagnostics include their valid
   sample counts; the small correlated synthetic cohort does not establish
   general calibration or a universal model ranking. Actual returned usage is
   recorded with coverage; unavailable totals/costs are not inferred. The direct
   TypeSafe default and policy thresholds remain unchanged. Independent schedule,
   input/source hash, scoring, aggregate-recomputation, and credential/account
   exclusion audits passed. Verification passed: 11 focused benchmark tests,
   all 1,084 tests, typecheck, build, and a 56-observation mocked full-protocol
   rehearsal. The report records measured source/harness attribution and limits.
7. [x] Prepare the v0.3.0 package and release notes after implementation and
   verification. Bump package metadata and version assertions together, update
   the package description to reflect multiple decision models, and verify the
   exact packed archive against the release gate below. Keep the package name
   `jev-orchestrator` and executable `jev-agent`.
   Prepared and verified locally on 2026-10-16: package metadata and the CLI
   version assertion now report `0.3.0`, with a description covering selectable
   decision models. The packaged [release notes](CHANGELOG.md) cover model
   routes/namespaces, migration and aliases, prerequisites/data paths, measured
   results, and limitations. README uses the current archive name and describes
   release preparation separately from publication. The historical issue #31
   protocol stays pinned to v0.2; its preparation regression now uses an isolated
   v0.2 source fixture instead of assuming the current package is v0.2.
   Verification passed: 32 focused CLI/benchmark tests, typecheck, all 1,084
   tests, production build, and schema-only validation. The exact v0.3.0 archive
   installed offline into a disposable consumer and passed 46 installed checks:
   version/help, offline keyless mocks, all six mocked model routes with JSON
   attribution, legacy selectors and credential/model aliases, defaults and
   precedence, and invalid/conflicting configuration or missing selected
   credentials before requests. The consumer stayed unchanged and produced no
   traces. All 18 transport requests were mocked; no live provider or worker was
   called for release preparation. Existing authorized synthetic checks and the
   168-observation live comparison remain the live evidence for this candidate.

   Archive: `jev-orchestrator-0.3.0.tgz`, SHA-256
   `d1f074eba45647f0b4473d66816e67771d2be7419089e55e9d0d87c1e6a5aad5`.
   Inspection found 68 allowlisted files: 64 compiled runtime/declaration files
   plus package metadata, README, CHANGELOG, and license; no tests, source,
   traces, credentials, dependencies, or local artifacts. Runtime/documentation
   bytes match the checkout, and packed metadata differs only by pnpm's expected
   removal of `packageManager` and the `prepack` lifecycle. Persistent archive,
   install log, verification script/results, and package audit are under
   `/home/peterc/.cache/jev-package-checks/v030-release-0o9aejkm`.
   Source baseline is merged PR #43, `a733daf1ec1d0265cbed0a548dffdc8dfe705fce`,
   plus the release-preparation changes committed as
   `cbde15963e6e3d37c131879ae822a2e1a6af792d` and merged by PR #44.
   Final release source: `6bbb666cb42f10afb843adf11cc49d0104434164`, tree
   `cfee3962d647a0305e6be4650fc75eacb7d2183e`. On 2026-10-17, the GitHub
   connector confirmed the merge, and a local audit verified that the prepared
   and merged source trees are identical, all 40 recorded source hashes match
   the release commit, and the saved archive retains the checksum above. All
   68 archive files match the installed consumer; runtime files match the
   current source-module set and compiled checkout, and packaged documents
   match the release commit. The installed CLI still reports `0.3.0`.
   The [final release record](docs/releases/v0.3.0.md) pins this source and
   artifact without claiming a tag or publication. This follow-up changes
   documentation only; the successful 1,084 tests and 46 installed checks above
   apply to the identical release source. No live provider or worker was called.

### v0.3.0 release gate

- [x] All implementation slices above are complete, with each new model route
  covered by deterministic transport, policy, and orchestration regressions.
- [x] Focused tests, `pnpm check`, `pnpm test`, and `pnpm build` pass on the
  release candidate. Offline CI requires no provider keys or live workers.
- [x] Authorized synthetic live checks pass for Clef, Clef-flash, and OpenAI
  Decisions through OpenRouter; record dates, requested/served models, and
  sanitized outcomes. Missing access or malformed responses leave this gate open.
- [x] A common labeled snapshot comparison records observed routing quality,
  policy overrides, failures, and latency with sample counts and limitations.
  Evidence supports usable routes under the existing policy; no speed win over
  Jev is required, and small samples cannot establish calibrated confidence.
- [x] The packed `jev-orchestrator-0.3.0.tgz` installs in a disposable consumer.
  Its `jev-agent --version` reports `0.3.0`; help and JSON attribution match
  the documented selectors/models. Mock decisions stay offline and keyless
  across selections; invalid/conflicting selectors and missing selected
  credentials fail before live requests. Legacy `JEV_PROVIDER` configuration
  and existing credential/model aliases retain their documented behavior.
- [x] Package inspection excludes tests, traces, credentials, dependencies,
  and local artifacts. Release notes describe new model routes, migration,
  model namespaces, prerequisites/data handling, and known limitations.
- [x] Record the final release commit and verification evidence before creating
  the v0.3.0 tag/release or publishing the package through the maintainer's
  release workflow. A planning update or version bump alone is not a release.

All preparation gates are complete. On 2026-10-17, annotated tag `v0.3.0`
(`589c82cdc9dfd04e56be7f1a7671e21c1802a8fa`) was pushed, resolving to the
verified release commit `6bbb666cb42f10afb843adf11cc49d0104434164`.
The [GitHub release](https://github.com/petercr/jev-orchestrator/releases/tag/v0.3.0)
was published at 16:44:42 UTC with the exact verified archive attached.
GitHub's asset digest and credential-free public download both matched the
recorded SHA-256; the public archive is 82,556 bytes. Publication evidence is
retained under `/home/peterc/.cache/jev-release-checks/v030-mb0tqeg9`.

An initial 2026-10-17 npm preflight found no authenticated account on this
machine; the unscoped `jev-orchestrator` listing
identified `KaiyoDev/jev-orchestrator`, maintainer `kaiyodev06`, and latest
version `0.3.1`. The operator confirmed that this npm package is not theirs
and selected `dev-orchestrator` for the separate npm package, subsequently
published as recorded below. The verified
[GitHub archive](https://github.com/petercr/jev-orchestrator/releases/download/v0.3.0/jev-orchestrator-0.3.0.tgz)
retains its original package name and checksum.

Use this comparison to extend the matched worker benchmarks already tracked in
issue #31: fix the worker/model/effort, permissions, task baseline, and approval
procedure while changing the decision provider. Measure evaluation and overall
active time separately from operator waits. The earlier pilots often needed
manual worker/finish alternatives; reducing those interventions without unsafe
routes is a concrete outcome to measure. Vendor latency claims alone do not
establish a faster or better coding workflow.

## npm package identity: dev-orchestrator

On 2026-10-17, the operator confirmed that the existing `jev-orchestrator` npm
package is not theirs and explicitly selected `dev-orchestrator` (Decisions +
Jev). This follow-up overrides the original release's package-name constraint
for the new npm package. Its initial version remains `0.3.0`; the executable
remains `jev-agent`, and the GitHub repository keeps its current name.

Package metadata, README, release notes, repository guidance, and the human CLI
banners now use Dev Orchestrator. Provider defaults, environment aliases, trace
labels, policy, validation requirements, and worker permissions remain intact.
Historical benchmark fixtures and the published `jev-orchestrator@0.3.0`
GitHub archive retain their original identity and checksum.

PR #46 merged on 2026-10-17 as `c6edb841b7a06952a4c1d99cb6ca42e7146b533d`,
tree `33b725d5bbd8d0952c21d977ae97e0ee3b652a9a`. The preparation and merge
trees are identical, and all 72 recorded source hashes match the final merged
release source. After the operator's npm browser authorization, account
`petercr` published [dev-orchestrator@0.3.0](https://www.npmjs.com/package/dev-orchestrator/v/0.3.0)
at 18:39:29 UTC on 2026-10-17. At publication, public metadata reported
`latest: 0.3.0`.

Published and verified on 2026-10-17: [npm publication record](docs/releases/dev-orchestrator-0.3.0.md).
The exact `dev-orchestrator-0.3.0.tgz` archive installed offline and passed 47
installed checks, including the compatible executable, Dev Orchestrator banner,
all six mocked model routes, aliases/defaults, keyless mocks, and configuration
preflight. Its 68 allowlisted files match the installed consumer; compiled
runtime bytes match the original release except the two human CLI banners.
Verification passed: 39 focused CLI tests, typecheck, all 1,084 tests, production
build, schema validation, and npm's publish dry run. After publication, the
credential-free registry download matched the saved archive byte for byte,
including npm's SHA-1/SHA-512 metadata. A separate registry installation passed
the same 47 checks with lifecycle scripts disabled and only this exact package
version excluded from pnpm's minimum-release-age setting in the disposable
consumer. Archive SHA-256:
`1a50bc543657832df9fa8c0ba73dbc97ee7575f7838eba87aa650d1d2ce97a45`.
Archive, source hashes, install logs, and inspection results are retained under
`/home/peterc/.cache/jev-package-checks/dev030-dxotlxn0`. The candidate was packed
from baseline `5b2782faddd8fff507cda8f73fa2949be142c0e3` with the rename
changes later merged in PR #46. Its final merged source and publish preflight
are recorded above and in the npm package's release record. Public download
and registry installation evidence are retained in `registry-verification/`
under the same local evidence directory.

## CLI command: dev-agent (v0.3.1)

After PR #47 merged on 2026-10-17, the operator requested that the CLI command
match the npm package's Dev branding. Version `0.3.1` changes the package's
executable from `jev-agent` to `dev-agent`, updates help and current usage
examples, and documents migration for shell commands, package scripts, and CI.
The package exposes only `dev-agent`. This request supersedes the earlier
executable-compatibility constraint for the next release.

Published v0.3.0 archives and historical benchmark/release records retain their
original executable names. Provider configuration, policy, approval, and worker
permissions are unchanged. Account `petercr` published
[dev-orchestrator@0.3.1](https://www.npmjs.com/package/dev-orchestrator/v/0.3.1)
on 2026-10-17 at 19:12:40 UTC after npm browser authorization. Public registry
metadata reports `latest: 0.3.1` and the `dev-agent` executable.

Verification on 2026-10-17 passed 39 focused CLI tests, typecheck, all 1,084
tests, and the production build through `pnpm pack`. A separate offline
installation passed 47 CLI checks with 18 mocked transport requests and no
live model or worker calls. It exposes only `dev-agent`; all 68 installed files
match the archive and retain the executable mode. The 83,471-byte archive's
SHA-256 is `0887ace54f08dce131b450ea22025fffe94e47c7f9e58a3373f1503d58edc3d7`.
Archive, source hashes, install log, and reports are retained under
`/home/peterc/.cache/jev-package-checks/dev031-1x1cbspe`. The archive was packed
from baseline `53ad58621d46172e2ad5e64f81011e0c761fe70c` with the changes later
committed as `09abdca884116eb728e4ba5b1a8095a4a8653d6d`. PR #48 merged on
2026-10-17 as `82676b9f2cb31f9c394155cd6fac345186e01dba`, tree
`f9ada91cad7e71aa568ad5fa15f819a6e3f8a448`. The preparation and merge trees
are identical, all 73 recorded source hashes match the merged source, and the
publish preflight records the final source, archive digests, npm account, and
registry before publication. See the [0.3.1 release record](docs/releases/dev-orchestrator-0.3.1.md).

After publication, the standard credential-free registry download matched the
saved archive and all recorded digests. A separate registry installation passed
47 CLI checks; all 68 installed files, executable mode, and lockfile integrity
matched the public archive, and only `dev-agent` was installed. The disposable
consumer's release-age exception covers only `dev-orchestrator@0.3.1`. Public
download and registry installation evidence are retained in
`registry-verification/` under the same local evidence directory.

## Current baseline

As of 2026-10-17:

- Published package `dev-orchestrator@0.3.1`, executable `dev-agent`;
  [release source and verification](docs/releases/dev-orchestrator-0.3.1.md).
  The initial scaffold `48cf6f0` and completed milestones below are historical.
- Node.js 22+, strict TypeScript, pnpm, Vitest, JSONL traces, AI SDK `7.0.106`,
  and pinned Varlock `1.22.0` development tooling.
- `ROUTER_PROVIDER` selects direct TypeSafe, OpenRouter, Vercel, or Cloudflare;
  `JEV_PROVIDER` and the documented credential/model aliases remain compatible.
  Jev defaults to direct TypeSafe with `jev-latest`. Clef, Clef-flash, and
  OpenAI Decisions are explicit alternatives. Account-specific live access
  and the six tested provider/model routes are recorded in the v0.3 history.
- Decision-only remains the default. Explicit orchestration includes bounded
  preparation and diagnostics, manual approval, either coding worker,
  controlled repair, current-generation validation, acceptance review,
  in-process evaluation recovery, signal cancellation, and run summaries.
- The shared evaluator normalizes completion, information, testing, stuck,
  and next-action answers. Live evaluation retains a 10-second deadline and
  at most one transient retry; local policy remains authoritative.
- Mock evaluation is offline and keyless; an explicitly approved coding-agent
  alternative still invokes the real worker. Published v0.3.1 verification
  passed typecheck, 1,084 tests, and production build. Its 47 installed CLI
  checks passed both before publication and through a separate public registry
  installation.

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

Completed initial milestones follow; the active planning proposal is
[v0.4](#v04-draft-reliable-task-workflows).

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

## CLI performance summary

Implementation: add a returned and printed summary to every completed
orchestration boundary, including completion, typed stop, iteration limit,
evaluation failure, and interruption. A local monotonic clock measures
evaluation, approved preparation, worker execution, independent validation,
initial/refreshed inspection, and Git diagnostics. Approval, clarification,
and explicit evaluation-recovery waits are reported separately from active
time. Remaining loop overhead has its own total.

Counters report evaluation attempts/failures/recoveries, actual approval
responses, begun calls to each worker, repeated calls to the same adapter,
validation attempts/failures, failed executions, timeouts, and cancellations.
They remain outside AgentState, policy, candidate permissions, and budgets.
No provider usage or cost is inferred. Elapsed time ends at the terminal trace
snapshot so the printed/returned summary and trace match.

Current-generation required checks retain passed/failed/pending status and
declared conjunctive coverage; older-generation results cannot establish
completion. Omitted requirements and repository refresh blockers remain
visible. Each schema-v2 record gains cumulative metrics, and terminal records
include the bounded, redacted summary without adding extra trace records.

Verification passed 81 focused tests, `pnpm check`, all 526 tests across 29
files, and `pnpm build`. A compiled-CLI offline fixture completed approved
search, read, validation, and finish in four iterations. All 13 smoke receipt
checks passed, including cumulative metrics, the terminal summary, independent
validation, absence of worker calls, and balanced phase/wait totals. No live
provider or coding-worker call was required.

A fresh installed-package live issue #80 run then used the same `5a910ba`
baseline, direct TypeSafe `jev-latest` (served as `jev-1.13.0`), Codex CLI
0.160.0, Terra/high, `--worker codex`, and `--codex-network`. It completed in
eight iterations with seven approvals, manual worker/finish alternatives,
one rejected distribution sum and explicit evaluation recovery, and one
successful Codex call. No worker retry, timeout, or cancelled execution occurred.

| Summary phase | Time |
| --- | ---: |
| Evaluation | 2.404 s |
| Approved preparation | 0.339 s |
| Worker | 58.767 s |
| Independent verify + build | 12.706 s |
| Inspection + other overhead | 0.092 s |
| Active total | 74.308 s |
| Approval + evaluation-recovery waits | 114.385 s |
| Elapsed total | 188.693 s |

Waits include operator/harness pauses and acceptance-review auditing. Setup
was outside the timed loop. This is one feature-verification run, not a new
matched performance comparison. Separate full-log verification confirmed lint,
typecheck, all 296 tests across 28 files, and absence of the original warning;
the approved build also passed. The patch matched the previous successful
pilots, target HEAD/index/lockfile were preserved, and original/source checkouts
were unchanged before this documentation update.

All 36 acceptance/evidence checks passed, including phase totals, prompt-wait
exclusion, counters matching trace events, matching printed/trace summary,
current-generation passed checks, and the approved network setting. Package,
consumer, clone, invocation, timings, logs, patch, and receipt are under
`/home/peterc/.cache/jev-pilots/issue80-cli-summary-20261005-cNUbfpyP`.

Follow-up work is tracked in [issue #30](https://github.com/petercr/jev-orchestrator/issues/30)
for the production bug-and-tests pilot on TrusTrove #949 and
[issue #31](https://github.com/petercr/jev-orchestrator/issues/31) for matched
JEV versus standalone Codex/Claude benchmarks. This milestone does not run
new paid coding pilots or claim a speed improvement.

## Production bug-and-tests pilot: TrusTrove #949

Live pilot completed on 2026-10-08 (America/New_York) for
[issue #30](https://github.com/petercr/jev-orchestrator/issues/30), using
[TrusTrove #949](https://github.com/TrusTrove/TrusTrove-app/issues/949).
The upstream issue was open and unassigned. A fresh external clone at
`6cae96e13e950a9e932130ef1a7aebbcddf9c58e` reproduced the defect for every
string length from 1 through 10. Baseline `pnpm typecheck`, `pnpm build`,
`pnpm lint`, and `pnpm test` all passed; the baseline contained 800 tests
across 98 files. Dependency installation used the unchanged frozen lockfile.
Setup and baseline checks were outside the timed loop.

The installed package was built from orchestrator `933c4ec`. The CLI received
only the exact issue URL as its task, with `--orchestrate --worker codex
--codex-network`. Direct TypeSafe `jev-latest` was served as `jev-1.13.0`;
Codex CLI 0.161.0 used Terra/high, the workspace file sandbox, no inner
approval prompts, and implementation-only prompting. The environment used
Node.js 24.21.0 and pnpm 10.30.3. No permissions or budgets were expanded.

The loop read the issue and `CONTRIBUTING.md`, delegated once, separately
approved root test/typecheck/lint/build, and completed after acceptance review.
It used eight iterations, eight approvals, manual `CALL_CODEX` and `FINISH`
alternatives, zero evaluation failures/recoveries, and zero worker retries,
timeouts, or cancellations. Worker and completion confidence remained below
their policy thresholds; manual alternatives did not increase confidence.

| CLI summary phase | Time |
| --- | ---: |
| Evaluation | 2.181 s |
| Approved preparation | 0.290 s |
| Codex worker | 66.182 s |
| Independent test/typecheck/lint/build | 114.032 s |
| Inspection + other overhead | 0.085 s |
| Active total | 182.770 s |
| Approval waits | 330.396 s |
| Elapsed total | 513.166 s |

Approval waits include operator/harness pauses and additional acceptance
audits. They are excluded from active time. This is one production-task run,
without a matched standalone control or a speed claim.

Only `apps/web/lib/format.ts` and the new `apps/web/lib/format.test.ts` changed.
The formatter preserves inputs of length 10 or shorter and accepts
undefined/null inputs. Five new Vitest cases cover a 56-character Stellar
address, empty/undefined input, and lengths 1, 10, and 11. All five pass with
the patch; the two short-input cases fail against the original function in a
separate regression fixture. An independent 15-case probe also passed,
including every short length. A separate full test log confirmed all 805
tests across 99 files pass, including existing component suites. The CLI's
four required checks passed in validation generation 1.

All 35 acceptance/evidence receipt checks passed. The patch passed reverse
checking; target HEAD, index, lockfiles, package scripts, and unrelated files
were preserved. The original issue #80 checkout and orchestrator checkout
were unchanged before this documentation update. No upstream contribution
was published. Only TypeScript workspace checks were exercised; Go/database,
browser E2E, dependency audit, and repository-wide formatting were outside
this frontend pilot.

Two limits were observed. Preparation, implementation, four validations, and
acceptance review used all eight iterations, leaving no iteration for extra
inspection, evaluation recovery, or repair. The terminal `stateAfter` exceeded
the existing 8 KiB trace-value bound and became a truncated preview. The other
15 state snapshots, final approval, metrics, and validation summary remained
structured; missing terminal fields were not reconstructed. Worker command
output and trace tool output are also bounded, so complete command capture
is not claimed.

The package, consumer, clone, configuration, invocation, baseline and acceptance
probes, regression fixture, full test log, timings, trace, fingerprints, patch,
and receipt are under
`/home/peterc/.cache/jev-pilots/trustrove-949-20261008-0bmye6or`.
Matched standalone comparisons were subsequently completed for
[issue #31](https://github.com/petercr/jev-orchestrator/issues/31), as recorded below.

## Matched worker comparison — issue #31

Completed on 2026-10-13 (America/New_York): twelve first-attempt observations
on TrusTrove #949, with three repetitions each of JEV + Codex, direct Codex,
JEV + Claude, and direct Claude. Fresh external clones used the same `6cae96e`
baseline, frozen dependency setup, task URL, installed v0.2 package, bounded
issue/instruction evidence, worker models, effort, permissions, and separate
project validation. Run order alternated within each worker pair. All six
paired contexts and original/instrumented worker argument sets match.

| Worker | JEV worker mean | Direct worker mean | Fully accepted patches |
| --- | ---: | ---: | --- |
| Codex, Terra / high | 68.7 s | 70.3 s | 2/3 for each setup |
| Claude, Sonnet 5.5 / medium | 16.4 s | 15.8 s | JEV 3/3; direct 2/3 |

Nine patches passed full acceptance and eight workflows completed successfully.
One Codex observation per setup produced an incorrect 11-character test
expectation, caught independently. One direct Claude build hit the unchanged
120-second timeout. One JEV + Claude evaluation distribution totaled `0.99`;
explicit continuation consumed the last iteration on build, leaving no
completion approval. That loop returned `iteration_limit` and exit code 1
despite all four current-generation checks passing. Failed and incomplete
observations were retained without replacement or increased limits.

Every JEV run needed a manual worker alternative; completed JEV loops also
needed manual completion review. No worker retries were performed in this
first-attempt protocol. Stopping a failed JEV observation leaves its state and
metrics intact; remaining root checks are separately recorded acceptance audits.
The benchmark does not exercise controlled repair or establish a general speed
or quality advantage. Validation variation and the small single-task sample
limit the timing conclusions.

The [full report](docs/benchmarks/issue-31.md) records per-run and aggregate
timings, successful-only statistics, actual reported usage, exceptions,
configuration, practical limits, and reproduction. The
[checked-in harness](scripts/benchmarks/README.md) keeps live execution opt-in
and individual JEV approvals intact. All 81 preservation/configuration audit
checks passed; original checkouts, runtime files, target heads/indexes,
lockfiles, scripts, and unrelated files were preserved. Persistent receipts,
patches, complete bounded logs, the exact archive, and aggregate JSON are under
`/home/peterc/.cache/jev-pilots/issue31-matched-20261013-v1k7494x`.

## Reference, not a template

[`gargpratyush/jev-router`](https://github.com/gargpratyush/jev-router) is a
useful reference for hard Jev deadlines, fail-open behavior, explicit user
overrides, deterministic policy, bounded decision history, pinning decisions
within an operation, and avoiding low-confidence downgrades. It routes fresh
Claude/Codex turns to model tiers; this project routes high-level workflow
actions. Do not clone its architecture. Model-tier routing may be added later
as a separate layer.
