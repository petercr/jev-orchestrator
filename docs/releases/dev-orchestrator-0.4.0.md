# dev-orchestrator 0.4.0 npm publication

Published [dev-orchestrator@0.4.0](https://www.npmjs.com/package/dev-orchestrator/v/0.4.0)
on 2026-10-19 at 20:45:14 UTC through npm account `petercr`, after PR #55 merged
and the operator completed npm browser authorization. Public registry metadata
reports `latest: 0.4.0`; the public archive matches the preverified archive byte
for byte.

| Item | Release |
| --- | --- |
| Package / executable | `dev-orchestrator@0.4.0` / `dev-agent` |
| Merged source baseline | `59aa718b785e78fd57cd1133cfbd777ffd575852` (PR #54) |
| Preparation branch | `chore/v0.4-release` |
| Preparation commit | `b0607082c53d663948856bcce103c736549e91f0` |
| Final merged release source | `4dc76ae66e0bf1c2b57bf36ae50dab27a9908014` (PR #55) |
| Release tree | `68ad10ed36026d01e103f0a2dbfe7ee694226e73` |
| Archive | `dev-orchestrator-0.4.0.tgz` |
| Size | 88,758 bytes |
| SHA-256 | `95d2e8d8c155ead4fbe1dbdfb82e3272fa2ac6c6247bec23d4b959462cf00fa7` |
| SHA-1 | `54e80eca55b1b5e2d3545b50f9bd799ae1437a0f` |
| Integrity | `sha512-h6Ko07PeQ5+wOgWUXLSQ4Po/0Cj44mTaib7RzJdpw2O0nwqmuW0M+8XS1gcI67XeUhypxGvxQXrp3tj/ORR93A==` |
| Preparation Node / pnpm | 22.23.3 / 11.19.0 |
| Merged-source verification Node / pnpm | 24.22.0 / 11.19.0 |
| Fresh offline / registry consumer Node / pnpm | 24.22.0 / 10.30.3 |

The source baseline plus the preparation commit produced this archive. PR #55
merged that preparation with an identical Git tree. All 80 recorded source/input
hashes match the final merged source, and all 70 packed files match its rebuilt
runtime, documents, and normalized metadata. The retained archive is unchanged.

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

## Preparation verification

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
  Git tag was absent. The merged-source preflight below repeated these checks
  before publication.

The archive, pack/install logs, verifier, installed check results, mock review
trace, package/source audit, and installed-file comparison are retained under
`/home/peterc/.cache/dev-package-checks/v040-1qb0t563`. They stay outside Git.
The verifier mocks fetch and blocks real HTTP requests in CLI processes, using
only fixture provider credentials. The CLI did not load `.env` or `.env.local`
value files for these checks.

## Merged-source verification

Rechecked after PR #55 merged on 2026-10-19 UTC, using Node.js 24.22.0 and
pnpm 11.19.0. All 72 focused CLI tests, typecheck, all 1,350 tests across 38
files with `--maxWorkers=2`, the production build, and schema-only validation
passed. PR #55's check/test/build and Socket checks also passed.

A fresh offline installation of the retained archive passed all 48 CLI checks
with 18 mocked transport requests and no live provider or worker calls. Its
70 package files match the archive; pnpm's additional generated executable
wrapper is accounted for separately. Only `dev-agent` is exposed, and its
shebang and executable mode are preserved. The grouped mock review stopped
with zero approvals or worker calls.

The credential-free registry preflight at `2026-10-19T20:26:24Z` found `0.4.0`
absent, `latest` at `0.3.1`, and no remote `v0.4.0` tag. The merged-source
attribution and checks are in `merged-preflight.json`, the full suite log is
`merged-tests.log`, and fresh installed verification is in
`merged-verification/` under the evidence directory above.

## Publication verification

The final preflight rechecked all 80 source hashes against the merged commit,
the retained archive checksum, and registry availability. npm confirmed the
publishing account as `petercr`. The operator received advance notice of timed
authorization, completed browser login and the separate publication approval,
and `npm publish` succeeded with public access and the `latest` tag.

- Public metadata confirms package/version, `latest: 0.4.0`, publishing account,
  repository URL, and the sole executable `dev-agent`.
- The standard credential-free registry download is 88,758 bytes and matches
  the retained archive byte for byte, with the same SHA-256, SHA-1, and SHA-512
  integrity recorded above.
- A fresh registry consumer installed `dev-orchestrator@0.4.0` with lifecycle
  scripts disabled, a new package store, and no user npm configuration. All 12
  packages were downloaded. The consumer's pnpm 10.30.3 differs from the source
  checkout's pinned pnpm 11.19.0; both used Node.js 24.22.0.
- The registry installation passed all 48 CLI checks with 18 mocked transport
  requests and no live provider or worker calls. Help/version, mock mode,
  provider selection/defaults/aliases, configuration failures, and grouped
  action review all passed. The consumer stayed unchanged; the separate mock
  review recorded its expected diagnostic trace and zero approvals or workers.
- All 70 installed package files match the public archive, the shebang and
  executable mode are preserved, and the lockfile records the expected registry
  integrity. pnpm's generated executable wrapper is accounted for separately;
  only `dev-agent` is exposed.
- The release-age exception covers only `dev-orchestrator@0.4.0` in the
  disposable consumer. Initial public metadata reads did not yet include the
  new version while npm processed the publication; these observations are
  retained alongside the successful verification.

The final preflight and publication transcript are `publication-preflight.json`
and `publish.log` under the evidence directory. Public metadata, downloaded
archive, registry observations, fresh install log, verifier, 48-check report,
and installed-file comparison are in `registry-verification/`. These artifacts
remain outside Git.

This publication documentation follows the frozen release source. The published
archive retains its preparation-era README and release notes; it was not
repacked to update publication wording. No new Git tag or GitHub release was
created. Historical v0.3.0 archives and npm versions remain unchanged.
