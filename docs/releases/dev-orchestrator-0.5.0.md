# dev-orchestrator 0.5.0 release preparation

The v0.5 implementation is merged through PR #59 at
`fcc8c2b095d16370bdaf2135dea2fefc7aa12425`. This checkout prepares
`dev-orchestrator@0.5.0`; npm publication remains pending. The executable is
`dev-agent`, with Node.js 22+ and the existing provider defaults and aliases.

| Item | Prepared release |
| --- | --- |
| Package / executable | `dev-orchestrator@0.5.0` / `dev-agent` |
| Merged implementation baseline | `fcc8c2b095d16370bdaf2135dea2fefc7aa12425` (PR #59) |
| Preparation branch | `chore/v0.5-release` |
| Archive | `dev-orchestrator-0.5.0.tgz` |
| Size | 93,459 bytes; 358,811 bytes unpacked |
| SHA-256 | `ca979099e6df2dfe61c7997731329b583393a3f486cb2e69428d0f6845fa601b` |
| SHA-1 | `cfbff6a045fe5428a326c22c32a9992bc0727c48` |
| Integrity | `sha512-DfmXMzYt9mpm2LPbJHSjgOfI6uHO/TvDiS4a+EJxYYc8B9GwqlEc3NDJ8AlIH4Xbhc6r5UtSx/kQ1w5CKk1Hvw==` |
| Preparation Node / pnpm | 24.22.1 / 11.19.0 |

## Scope

The [release notes](../../CHANGELOG.md) cover styled orchestration reviews,
phase progress and results, typed prompts, `--plain` and static fallbacks,
bounded unanswered-prompt stops, and plain Windows EOF handling. The
[terminal verification record](../presentation/v0.5-verification.md) retains
the implementation's WSL/Windows matrix and its limits.

Policy, manual approval and acceptance, immutable worker/network selection,
eight iterations, two calls per worker, fresh independent validation, and the
95% automatic completion threshold remain unchanged. Decision JSON stays at
schema v1 and orchestration traces at v2, with additive bounded `promptStop`
evidence. Saved-run resume and unattended execution remain unavailable.

Clack 1.8.1 is a runtime dependency. Native PTY and headless terminal tools are
optional development verification dependencies and are excluded from the
archive. This release makes no live routing-quality, speed, native worker
launcher, or screen-reader certification claim.

## Preparation verification

Verified on 2026-10-22 UTC:

- All 86 focused CLI, terminal, and cancellation tests passed, followed by
  typecheck, schema-only environment validation, all 1,406 tests across 41
  files with `--maxWorkers=2`, and the production build. Packing also ran the
  existing `prepack` build successfully.
- The exact archive installed offline into a private consumer with lifecycle
  scripts disabled. All 49 installed CLI checks passed, with 18 mocked
  transport requests across all six provider/model routes. Version/help,
  keyless mock mode, `--plain`, defaults, aliases and precedence, and invalid
  configuration passed. A separate mock review stopped at its first prompt
  with zero approvals and worker calls; only its expected trace was written.
- The retained archive also installed into a fresh native Windows consumer.
  Its `.cmd` executable printed version `0.5.0` and help. Each installed
  consumer passed all 33 terminal scenarios and two decision-only JSON/trace
  schema-v1 checks: WSL on Node.js 24.22.1 and native Windows on Node.js
  26.7.0, both using pnpm 11.19.0. Captures retain prompt, approval,
  validation, interruption, partial-edit, process, and terminal cleanup
  assertions. The [harness record](../presentation/v0.5-verification.md)
  describes the synthetic boundaries and scoped ConPTY driver cleanup.
- All 72 allowlisted installed files match the archive on both platforms;
  generated package-manager launchers are accounted for separately. Its 68
  compiled JavaScript/declaration files match PR #59's verified development
  archive (unpublished `0.4.0` metadata) byte for byte, SHA-256
  `accd4c96a90c2fd80bc605558cd7f1d68b7303aa02f74480f74ad330b9a586bc`.
  Packaged documents and runtime bytes match the checkout; metadata differs
  only by pnpm's removal of `packageManager` and `scripts.prepack`. The Node
  shebang and executable mode are preserved, and only `dev-agent` is exposed.
  Source, tests, traces, credentials, terminal drivers, native dependencies,
  and downloaded artifacts are excluded.
- All 82 source/input hashes are retained for comparison after merge. This
  preparation changes metadata, version assertions, and documentation; the
  runtime remains the accepted implementation.
- npm's publication dry run accepted the retained archive with matching
  size, file count, SHA-1, and integrity. It used empty user/global npm
  configuration and no provider credentials. No publication was started.
- At `2026-10-22T16:28:44Z`, a credential-free public-registry check found
  `0.5.0` absent (HTTP 404), `latest` at `0.4.0`, and no remote `v0.5.0` tag.

The archive, verifiers, logs, mock review trace, package audit, installed-file
comparison, and terminal captures are retained outside Git under
`/home/peterc/.cache/dev-package-checks/v050-20261022`. The installed CLI
verifier mocks fetch and blocks real HTTP requests in CLI processes, using
only fixture credentials. Those automated checks call no live model or coding
agent and do not load `.env` or `.env.local` value files. The separately
authorized live pilot below uses actual services and existing credentials
loaded by Varlock without reading or printing local value files.

## Live pilot before publication

The operator requested a fresh live v0.5 pilot after reviewing the preparation.
The [frozen protocol](../presentation/v0.5-live-protocol.md) and
[results](../presentation/v0.5-live-results.md) retain five launches on
2026-10-22 against this exact archive, using real TypeSafe/Jev, Codex, and
Claude processes on WSL. No runtime, archive, or recorded source/input bytes
changed for the pilot.

Three of the four implementation runs reached separately approved completion;
all four patches met their original examples and fresh independent test/lint
checks. The remaining run exited `evaluation_failed` after its second
malformed distribution. Four of 26 evaluations were rejected for totals near
0.99, and three explicit recoveries consumed the existing iteration budget.
Those failures remain observations; they were not replaced or renormalized.
The staged repair completed at iteration eight with fresh generation-2 checks.
Its omitted first-generation lint is recorded as a protocol deviation; both
checks passed after repair before completion. The fifth launch verified
Ctrl+C at an approval prompt: exit 130, zero approvals, zero worker calls, and
no edits. All five runs restored terminal flags.

This supports live integration and presentation within the pilot's scope,
with a material router reliability limitation. It does not establish an
all-successful live matrix, improved routing quality, live native Windows
workers, other live providers, or real active-worker cancellation. Keep the
mixed result visible in release review. The retained archive remains unchanged
and npm publication remains pending.

## Publication boundary

Publication is blocked by [routing reliability issue #61](https://github.com/petercr/jev-orchestrator/issues/61).
Resolve the issue and verify the fix or accepted mitigation and any changed
candidate archive before starting npm publication.
The [initial precision investigation](../presentation/v0.5-routing-investigation.md)
and separate six-evaluation probe do not yet establish a fix or accepted
mitigation. The 0.001 tolerance, default model, and runtime remain unchanged.

Merge the release preparation before publishing. Recheck the merged source,
retained archive, and registry availability; give the operator advance notice
before launching any timed npm browser authorization. Record the public
archive and fresh registry-install verification after publication. Historical
archives and already published versions remain unchanged.
