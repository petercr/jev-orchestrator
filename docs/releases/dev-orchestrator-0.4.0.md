# dev-orchestrator 0.4.0 release preparation

Prepared on 2026-10-19 UTC after PR #54 merged. This is an unpublished candidate;
no tag, GitHub release, or npm publication has been created. npm authentication
must be announced before starting any timed publication authorization.

| Item | Candidate |
| --- | --- |
| Package / executable | `dev-orchestrator@0.4.0` / `dev-agent` |
| Merged source baseline | `59aa718b785e78fd57cd1133cfbd777ffd575852` (PR #54) |
| Preparation branch | `chore/v0.4-release` |
| Final preparation commit / merged release source | Pending |
| Archive | `dev-orchestrator-0.4.0.tgz` |
| Size | 88,758 bytes |
| SHA-256 | `95d2e8d8c155ead4fbe1dbdfb82e3272fa2ac6c6247bec23d4b959462cf00fa7` |
| SHA-1 | `54e80eca55b1b5e2d3545b50f9bd799ae1437a0f` |
| Integrity | `sha512-h6Ko07PeQ5+wOgWUXLSQ4Po/0Cj44mTaib7RzJdpw2O0nwqmuW0M+8XS1gcI67XeUhypxGvxQXrp3tj/ORR93A==` |
| Node / pnpm | 22.23.3 / 11.19.0 |

The source baseline above plus the pending release-preparation changes produced
this archive. Do not attribute it solely to the baseline commit. The local
package audit records 80 source/input hashes for later comparison with the
preparation and final merged commits. Before publication, establish that those
inputs and all packed runtime/documentation bytes match the accepted release
source. Retain this archive instead of silently repacking a different artifact.

## Scope and compatibility

The [release notes](../../CHANGELOG.md) describe grouped action reviews,
read-only explanations of blockers and operator choices, and the focused
same-worker repair-policy correction after a failed current-generation
independent check. The CLI name, flags, provider defaults/aliases, JSON v1,
trace schema v2, approval gates, independent checks, worker/network selection,
eight-iteration and two-call worker limits, and 95% automatic completion
threshold remain compatible.

The [live pilot](../workflows/v0.4-live-results-v1.md) retains seven
accepted/completed workflows and one unsuccessful launch. It did not show
fewer live detours, improved reliability, or speed, and neither staged repair
needed the new high-testing-score exception. The policy improvement is backed
by twelve deterministic regressions across six routes and both workers.
The pilot's missing cell, two rejected distributions and explicit recoveries,
and supplemental receipt audit remain limitations. A terminal UI library and
saved-run resume belong to later planned milestones.

## Verification

- The 72 focused CLI integration, argument, and presentation tests passed.
- Typecheck and schema-only environment validation passed. `pnpm pack` ran the
  production build successfully through the existing `prepack` lifecycle.
- All 1,350 tests passed with `pnpm test --maxWorkers=2`; the reduced
  concurrency retains the full suite while avoiding known local fixture
  contention. No live provider or worker was called by automated tests.
- The exact archive installed offline, with lifecycle scripts disabled, into
  a disposable consumer. All 48 installed CLI checks passed, with 18 mocked
  transport requests and zero live provider or worker calls.
- Installed checks cover version/help, keyless mock decisions, all six model
  routes, attribution, defaults, legacy provider selectors, credential/model
  aliases and precedence, and invalid/conflicting or missing configuration
  before requests. The decision consumer stayed unchanged and wrote no traces.
- A separate keyless mock loop displayed the new model/policy/candidate,
  evidence/limits, and operator-choice groups. The verifier selected only
  `stop` at the first prompt. The trace recorded zero approvals and worker calls;
  repository files stayed unchanged, with one expected diagnostic trace.
- All 70 allowlisted installed files match the archive. Runtime/declaration
  files and packaged documents match the checkout. The Node shebang and
  executable mode are preserved; only `dev-agent` is installed. Tests, source,
  credentials, traces, dependencies, and local artifacts are excluded.
- All 66 compiled runtime/declaration files also match the frozen live candidate
  from `41be992e25c908cc730667a7ae338566ea7e158a`. The existing live evidence
  applies to these runtime bytes without spending additional model/worker calls.
- Packed metadata differs from the checkout only by pnpm's removal of
  `packageManager` and `scripts.prepack`. Runtime dependencies are unchanged.
- At `2026-10-19T03:24:43Z`, a credential-free public-registry check found
  version `0.4.0` absent (HTTP 404), with `latest` still `0.3.1`. The `v0.4.0`
  Git tag was absent. Recheck these mutable facts before publication.

The archive, pack/install logs, verifier, installed check results, mock review
trace, package/source audit, and installed-file comparison are retained under
`/home/peterc/.cache/dev-package-checks/v040-1qb0t563`. They stay outside Git.
The verifier mocks fetch and blocks real HTTP requests in CLI processes, using
only fixture provider credentials. The CLI did not load `.env` or `.env.local`
value files for these checks.

## Remaining release steps

Commit/review this preparation and record the accepted source attribution after
merge. Recheck the exact archive and registry/tag availability, announce npm
authentication before publication, then verify the published metadata, archive
digests, and a fresh registry installation. Publication evidence will be added
to this record afterward; a version bump and local package checks are not a
published release.
