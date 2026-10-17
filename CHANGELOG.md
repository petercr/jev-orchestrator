# Release notes

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
