# dev-orchestrator 0.5.0 release preparation

The v0.5 implementation is merged through PR #59 at
`fcc8c2b095d16370bdaf2135dea2fefc7aa12425`. The current candidate adds clearer
recovery guidance and disclosure for #61 at
`4b49a1030d6a52421849efe76e220ceadda744f7`. The operator accepted that
mitigation on 2026-10-22. npm publication remains pending its merge and the
normal publication checks. The executable is
`dev-agent`, with Node.js 22+ and the existing provider defaults and aliases.

| Item | Current mitigation candidate |
| --- | --- |
| Package / executable | `dev-orchestrator@0.5.0` / `dev-agent` |
| Candidate source | `4b49a1030d6a52421849efe76e220ceadda744f7` |
| Branch | `fix/61-explicit-routing-recovery` |
| Archive | `dev-orchestrator-0.5.0.tgz` |
| Size | 93,965 bytes; 360,426 bytes unpacked |
| SHA-256 | `93ec79dd5f11284e44e2a72f807d85d8cd524be8a9a54e8b6df809d8adc925c5` |
| SHA-1 | `3a7368dffcb670e7771aed4b84260f0192333e2f` |
| Integrity | `sha512-MN5ZHShtZ6FU63E1kM2bZ4F4h/DjYn2gQZAiLBgjD9VRaI2P1nfVGlS2/1LqMw6wP7Q3PV+F2/dqXY72sMJp4A==` |
| Preparation Node / pnpm | 24.22.1 / 11.19.0 |

The original candidate below remains retained for its original live pilot;
its checksum must not be attributed to the current candidate.

| Item | Original prepared archive (retained history) |
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

## Original preparation verification

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

The original archive, verifiers, logs, mock review trace, package audit, installed-file
comparison, and terminal captures are retained outside Git under
`/home/peterc/.cache/dev-package-checks/v050-20261022`. The installed CLI
verifier mocks fetch and blocks real HTTP requests in CLI processes, using
only fixture credentials. Those automated checks call no live model or coding
agent and do not load `.env` or `.env.local` value files. The separately
authorized live pilot below uses actual services and existing credentials
loaded by Varlock without reading or printing local value files.

## Original live pilot before publication

The operator requested a fresh live v0.5 pilot after reviewing the preparation.
The [frozen protocol](../presentation/v0.5-live-protocol.md) and
[results](../presentation/v0.5-live-results.md) retain five launches on
2026-10-22 against the original archive above, using real TypeSafe/Jev, Codex, and
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
mixed result visible in release review. That original archive remains unchanged.
The new candidate below has a separate archive and verification record;
npm publication remains pending.

## Recovery mitigation candidate verification

The [mitigation report](../presentation/v0.5-routing-mitigation-results.md)
records the proposed operational tradeoff, its frozen protocol, new live
results, regressions, exact candidate, and limits. It preserves strict
malformed-response rejection and supports explicit recovery within the
existing eight-iteration budget. This behavior already existed; production
changes add explanation and documentation, rather than fixing provider
precision or increasing budgets.

Verified on 2026-10-22 UTC against the current candidate:

- All 44 focused presentation/recovery tests, typecheck, all 1,409 tests,
  production build, and schema-only validation passed. The new regressions
  exercise two rejected totals after passing independent validation for
  both worker selections, with explicit recoveries, immutable permissions
  and selection, retained evidence, and separate acceptance approval.
- Fresh offline installation passed all 49 CLI checks and 18 mocked
  transport requests across all six routes. All 72 package files match
  installed WSL and Windows consumers. Only the compiled presentation helper,
  README, and changelog differ from the original archive; the other 67
  compiled files remain identical. Executable name and metadata are unchanged.
- Each packed consumer passed 33 terminal scenarios and two decision JSON/
  trace checks, on WSL Node 24.22.1 and Windows Node 26.7.0. These terminal
  checks use synthetic service boundaries. npm publication dry run accepted
  the exact archive with matching size, file count, SHA-1, and integrity.
- The new three-launch live cohort used real TypeSafe/Jev and one Codex /
  two Claude calls, with fixed selections and network permissions. All
  three tasks met their original examples, passed both fresh independent
  checks, and received separate completion approvals. One of 16 evaluations
  was rejected at distribution/sum (0.99), then explicitly recovered before
  a separately approved action. All three processes restored terminal flags.
  Repeated rejection was not exercised live here; its recovery is verified
  by the deterministic tests. The original mixed pilot is not replaced.

Evidence, archive, installed hashes, protocol, traces, receipts, full patches,
audits, verifiers, and terminal captures are retained outside Git under
`/home/peterc/.cache/dev-issue61-mitigation-20261022`; native Windows captures
are also under `C:\Users\pcruc\AppData\Local\Temp\dev-issue61-mitigation-20261022`.
No npm publication has been started.

## Publication boundary

The operator accepted the verified mitigation for
[routing reliability issue #61](https://github.com/petercr/jev-orchestrator/issues/61)
on 2026-10-22 and asked to continue. That resolves the publication blocker
through mitigation; it does not fix provider output. Merge PR #63 and verify
its merged inputs against the retained candidate before npm publication.
The [initial precision investigation](../presentation/v0.5-routing-investigation.md)
and separate six-evaluation probe did not establish a provider fix. The
verified recovery mitigation above has explicit operator acceptance
of occasional evaluation failures and possible budget exhaustion as a v0.5
limitation. The 0.001 tolerance, probabilities, model defaults, permissions,
and production recovery behavior remain unchanged. The mitigation report
records the acceptance and distinguishes it from GitHub's premature issue
closure on the earlier investigation PR.

Merge the release preparation before publishing. Recheck the merged source,
retained archive, and registry availability; give the operator advance notice
before launching any timed npm browser authorization. Record the public
archive and fresh registry-install verification after publication. Historical
archives and already published versions remain unchanged.
