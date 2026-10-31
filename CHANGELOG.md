# Release notes

## dev-orchestrator 0.6.0 candidate — saved runs and safe resume

Unpublished candidate. The live stop/resume pilot and operator acceptance remain
required before release. The package remains `dev-orchestrator`, its executable
remains `dev-agent`, and Node.js 22+ is required.

- Add opt-in `--orchestrate --save-run`, bounded local checkpoints and attempt
  history, and exclusive ownership for saved and unsaved orchestration.
- Add credential-free `--list-runs` and `--show-run <run-id>`. Records report
  remaining budgets, selections, validation, failures, and continuation blockers.
- Add explicit `--resume <run-id> [--plain]` on the same canonical Git worktree
  and unchanged HEAD. Review content drift and fixed selections, reread required
  instructions, and independently validate again before task acceptance.
- Preserve the original iteration ceiling, consumed worker calls, selected
  provider/model/worker/network permissions, and separate action approvals.
  Incomplete writes, unresolved execution or ownership, incompatible records,
  and unverifiable repository identity block continuation.
- Retain the actual historical worker process outcome after resume while
  invalidating earlier validation. Prefer known task files during approved
  reads after instructions and search evidence, ahead of generic metadata.
- Report worker input/output/total tokens from bounded structured Codex and
  Claude usage events. Show per-worker totals and reporting coverage, retain
  available failed/interrupted-attempt usage, and label missing usage explicitly.
  Saved outcome events retain numeric usage outside task state so history and
  resumed tasks report cumulative totals without resetting budgets.
- Offer an explicit completion alternative alongside a clear file-read route
  after a worker attempt and fresh passing independent checks. Keep the read
  as the default and require separate selection and approval of task acceptance.
  Baseline-only checks, missing preparation, ambiguous routing, and stale or
  incomplete checks cannot enable this alternative; budgets remain unchanged.

The original live candidate preserved its patch and passed fresh validation,
but exhausted its iteration budget before completion acceptance. Its failure
is retained in the [live results](docs/workflows/v0.6-live-results.md); the
context fixes were retested on 2026-10-28. Codex completed, but Claude reached
the iteration limit after an evaluation recovery despite passing validation;
the active-interruption scenario was not launched. The
[retest report](docs/workflows/v0.6-live-retest-results-20261028.md) retains the
failure. The live release gate remains blocked, and the later token-reporting
change has offline verification only.

Saved data uses local, unencrypted schema-v1 records outside the worktree.
There is no automatic migration, deletion, retention cleanup, crash replay, or
cross-machine transfer. Older development stops without content fingerprints
remain inspectable and cannot resume. Diagnostic traces are not resume files.
See the [storage and housekeeping contract](docs/saved-runs-v1.md),
[offline verification](docs/saved-runs-verification.md), and
[live pilot protocol](docs/workflows/v0.6-live-protocol.md).

## dev-orchestrator 0.5.0 — terminal presentation

Published on npm on 2026-10-22 as
[dev-orchestrator@0.5.0](https://www.npmjs.com/package/dev-orchestrator/v/0.5.0).
The package remains `dev-orchestrator`, the executable remains `dev-agent`,
and Node.js 22+ is required.

- Integrate Clack through a CLI-owned terminal adapter for orchestration
  reviews, typed prompts, phase progress, and results. Preserve the existing
  approval parser, resolved-alternative confirmation, completion acceptance,
  worker permissions, budgets, and independent validation.
- Add `--plain` and static fallbacks for non-TTY streams, CI, `NO_COLOR`, and
  `TERM=dumb`. Keep JSON schema v1 and orchestration schema v2, with optional
  bounded `promptStop` evidence for unanswered prompts.
- Handle plain Windows console EOF keys followed by Enter without enabling
  raw input or terminal styling. Add isolated offline PTY/ConPTY verification
  for compiled and packed CLIs; no live model or coding-agent calls.
- Explain rejected action totals and the possibility of another failure at
  recovery. Document TypeSafe/Jev's observed invalid totals and repeated,
  explicitly approved recovery within the existing iteration budget. Keep
  the 0.001 tolerance, probabilities, selections, permissions, and budgets
  unchanged; this mitigates interruption rather than fixing provider output.

### Compatibility and evidence

Decision-only remains the default. Provider selection and aliases, immutable
worker/network permissions, the eight-iteration and two-call worker limits,
independent validation, manual acceptance, and the 95% automatic completion
threshold remain unchanged. No saved-run resume or unattended execution is
introduced. Clack 1.8.1 is now a runtime dependency; optional native terminal
verification dependencies are excluded from the package.

The implementation passed 1,406 deterministic tests and 132 local compiled/
installed terminal walkthroughs on WSL and native Windows. Node 22 CI repeats
both terminal matrices on Ubuntu and Windows. These establish presentation and
enforcement with synthetic service boundaries, not live routing quality,
native worker launcher availability, screen-reader certification, or speed.
See the [verification record](https://github.com/petercr/jev-orchestrator/blob/main/docs/presentation/v0.5-verification.md).

The final recovery-mitigation candidate passed all 1,409 deterministic tests.
A separate three-launch live cohort completed all three tasks, retaining one
rejected evaluation and its explicit recovery. Repeated recovery is verified
deterministically; the original mixed pilot remains recorded. The operator
accepted occasional evaluation failures and possible budget exhaustion as a
documented limitation. The public npm/GitHub archive matches the tested
candidate, and a fresh registry installation passed all 49 CLI checks and
matched all 72 package files. See the
[publication record](docs/releases/dev-orchestrator-0.5.0.md).

## dev-orchestrator 0.4.0 — task reviews and controlled repair

Published on npm on 2026-10-19 as
[dev-orchestrator@0.4.0](https://www.npmjs.com/package/dev-orchestrator/v/0.4.0).
The npm package remains `dev-orchestrator`, the executable remains `dev-agent`,
and Node.js 22+ is required.

### Changed

- Group orchestration reviews into model recommendation, policy decision,
  resolved candidate, current evidence/limits, and operator choices. Show why
  context, independent checks, confidence, or remaining calls block progress.
  Distinguish manual alternatives and explicit evaluation recovery from normal
  action approvals. These explanations are display-only.
- Permit a clear recommendation to return to the same allowed worker for
  repair despite a high testing assessment, when a current-generation
  independent check failed after that worker's attempt. Preserve confidence,
  preparation, missing-information/stuck guards, call limits, separate approval,
  and fresh independent validation after repair. Worker claims and stale checks
  cannot establish eligibility.

### Evidence and limits

- Add 195 complete offline workflow cases across all six model routes and both
  workers, including twelve labeled regressions for the repair-policy fix.
  Provider and worker boundaries are synthetic; independent local checks are
  real. Cover missing context, stale/omitted validation, recovery, interruption,
  and exhausted budgets without live credentials.
- Retain eight bounded live launches: seven accepted patches and approved loop
  completions across Jev, Decisions, Codex, and Claude, plus one entry-point
  launch that exited before evaluation. Both staged repairs passed; two rejected
  distributions required explicit recovery. Manual routing remained necessary,
  and neither live repair needed the new high-testing-score exception. This
  pilot does not establish improved live reliability, fewer detours, or speed.
- Record the missing comparison cell, launcher amendment, separate acceptance
  and completion evidence, active time versus prompt waits, and a supplemental
  audit for truncated validation labels. See the
  [live report](https://github.com/petercr/jev-orchestrator/blob/main/docs/workflows/v0.4-live-results-v1.md).

### Compatibility

Decision-only remains the default. CLI flags, provider defaults and aliases,
decision JSON v1, orchestration trace schema v2, manual approvals, the
eight-iteration and two-calls-per-worker limits, immutable worker/network
selection, independent validation, and the 95% automatic completion threshold
remain compatible. This release does not add unattended execution, saved-run
resume, a terminal UI library, or new provider permissions. Existing v0.3
provider setup and data-handling guidance below continues to apply.

## dev-orchestrator 0.3.1 — CLI command rename

Published on npm on 2026-10-17 as
[dev-orchestrator@0.3.1](https://www.npmjs.com/package/dev-orchestrator/v/0.3.1).

- Rename the executable from `jev-agent` to `dev-agent`, including CLI help
  and current usage examples. Update shell commands, package scripts, and CI
  invocations when upgrading; the package exposes only `dev-agent`.
- Retain the existing CLI flags, provider configuration and aliases, policy,
  worker permissions, and Node.js 22+ requirement.

## dev-orchestrator 0.3.0 — npm package identity

First published on npm on 2026-10-17 as
[dev-orchestrator@0.3.0](https://www.npmjs.com/package/dev-orchestrator/v/0.3.0).
The operator selected
`dev-orchestrator` on 2026-10-17 because the decision models include Decisions
and Jev. The existing `jev-orchestrator` npm listing belongs to another project.

- Rename the npm package to `dev-orchestrator`, retaining version `0.3.0` for
  this package's first publication.
- Preserve the `jev-agent` command, decision-model configuration and aliases,
  policy, worker permissions, and Node.js 22+ requirement.
- Use Dev Orchestrator in the human-readable CLI banners and README.
- Include the source repository URL in package metadata.
- Install from npm with `pnpm add --save-dev dev-orchestrator@0.3.0`. The
  public archive matches the preverified tarball, and a separate registry
  installation passed all 47 installed CLI checks. The original GitHub release
  archive retains its historical name and checksum.

The model routes, prerequisites, data handling, and limitations below also
apply to the renamed package.

## jev-orchestrator 0.3.0 — multiple decision models

Release candidate prepared on 2026-10-16 and published as a GitHub archive on
2026-10-17. It was not published to npm. The archive's package name is
`jev-orchestrator`, the executable remains `jev-agent`,
and Node.js 22+ is required.

### Added

- Cloudflare Clef and Clef-flash through a bounded Workers AI REST adapter.
- OpenAI Decisions through the existing OpenRouter Decisions transport.
- Provider-neutral configuration, evaluation, and errors, retaining Jev-named
  exports and environment aliases for compatibility.
- Shared transport, policy, and orchestration regressions across all six
  provider/model routes, plus explicit opt-in synthetic verification.
- Pinned Varlock development tooling with sensitive credential schemas and
  redacted checks. Installed consumers do not need Varlock at runtime.
- A labeled decision comparison with 168 live evaluations across 14 workflow
  states, reporting routing, policy overrides, failures, latency, returned usage,
  and separate probability/confidence diagnostics.

### Configuration and migration

Set `ROUTER_PROVIDER` explicitly to choose a transport. With neither selector
set, direct TypeSafe/Jev remains the default. Only the selected provider's
credentials are required; there is no automatic failover.

| Decision model | `ROUTER_PROVIDER` | `ROUTER_MODEL` | Required environment |
| --- | --- | --- | --- |
| Jev / TypeSafe (default) | `typesafe` | `jev-latest` (default), or `jev-1.13.0` | `TYPESAFE_API_KEY` or `TYPESAFE_AI_API_KEY` |
| Jev / OpenRouter | `openrouter` | `typesafe/jev-1.13` (default) | `OPENROUTER_API_KEY` or `OPENROUTE_API_KEY` |
| Jev / Vercel | `vercel` | `typesafe-ai/jev` (default) | `AI_GATEWAY_API_KEY` |
| Clef / Clef-flash | `cloudflare` | `clef` (default) or `clef-flash` | `CLOUDFLARE_AUTH_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` |
| OpenAI Decisions | `openrouter` | `openai/gpt-6-luna-decisions` | `OPENROUTER_API_KEY` or `OPENROUTE_API_KEY` |

Existing `JEV_PROVIDER` configurations still work. If both selectors are set,
they must agree; conflicting, empty, or unknown selectors fail before a request.
For the earlier Gateway behavior, explicitly select `vercel`. Clear an old
`ROUTER_MODEL` override when changing providers or replace it with a model in
the new provider's namespace. `OPENROUTE_MODEL` remains an OpenRouter-only
fallback when `ROUTER_MODEL` is blank. Nonblank canonical keys take precedence
over credential aliases. Direct OpenAI transport and credentials are outside
this release.

Results and traces include `provider`, `requestedModel`, and an optional
`servedModel`, while preserving existing schema versions and the `model` field.
The Gateway's unverified served version stays absent. Existing `mock/jev` and
`jev_finish` labels remain compatible.

### Prerequisites and data handling

The selected account needs model access and billing capacity. Cloudflare
requires a 32-character hexadecimal account ID and an account-scoped Workers AI
token with Read and Edit permissions. OpenAI Decisions uses an OpenRouter key;
it does not require a direct OpenAI key. Vercel access was not established for
the tested account; authorization failure is retained as an access limitation.

Live evaluation sends bounded task, repository, issue, and worker evidence to
the selected service. OpenAI Decisions through OpenRouter adds OpenAI as an
upstream model vendor; it does not establish direct OpenAI account controls.
Review the [provider setup and data path](README.md#evaluation-providers) and
[privacy guidance](README.md#current-safety-boundary) before authorizing live
repository evidence. This client does not guarantee zero retention. Local
`.env` values stay ignored, and the installed CLI does not load them implicitly.

### Verification and limitations

Authorized synthetic checks on 2026-10-15 normalized both Cloudflare models
and OpenAI Decisions through OpenRouter on the tested accounts. The 2026-10-16
comparison retained all 168 scheduled evaluations, including two rejected Jev
distributions. OpenAI Decisions matched the reference route most often and Jev
had the lowest observed latency in that cohort. No fixture-forbidden selection
survived deterministic policy among the 166 normalized evaluations.

The [comparison report](https://github.com/petercr/jev-orchestrator/blob/main/docs/benchmarks/v0.3-decisions.md)
records sample counts, requested/served versions, protocol, and limitations.
Fourteen repeated synthetic states do not establish general model quality or
production calibration; the study ran no coding workers or tools. Model
availability, confidence semantics, served versions, and latency can vary.
Malformed answers remain failures, without renormalization or replacement.

Decision-only remains the default. Orchestration still requires manual approval,
current-generation independent validation, and original-task acceptance, with
the same eight-iteration limit, two-call worker budgets, worker selection,
Codex network opt-in, and 95% completion threshold. Decision-model selection
cannot expand worker permissions. Comparison metrics cannot authorize actions.
