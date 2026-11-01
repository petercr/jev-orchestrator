# dev-orchestrator 0.6.0 release record

Published on npm on 2026-11-01 at `00:35:20.482 UTC` as
[dev-orchestrator@0.6.0](https://www.npmjs.com/package/dev-orchestrator/v/0.6.0).
The public registry's `latest` tag points to `0.6.0`. The executable remains
`dev-agent`, with Node.js 22+ and the existing provider defaults and aliases.

The published archive is the exact candidate exercised by the
[2026-10-31 live retest](../workflows/v0.6-live-retest-results-20261031.md);
it was not rebuilt for publication. PR #74 merged the candidate source and its
retest records at `cc0b009b963a93f5fcc651bbab274323dac7ad2b`. The only changes
between the candidate source and that merge are the two retest documents, so no
packaged input changed.

| Item | Published archive |
| --- | --- |
| Package / executable | `dev-orchestrator@0.6.0` / `dev-agent` |
| Candidate source | `62f5c3d1ead54a264e28d49cb9d2aa6b830ed1f3` |
| Verified publication commit / tag | `cc0b009b963a93f5fcc651bbab274323dac7ad2b` / `v0.6.0` |
| Archive | `dev-orchestrator-0.6.0.tgz` |
| Size | 129,946 bytes; 518,042 bytes unpacked; 92 files |
| SHA-256 | `b71ee9c86c90a190d51a1e21b90ffff239f98f6dbc4492534316eab7941a9cee` |
| SHA-1 | `0341f5153407841d3a1393caa40a833bda3388dc` |
| Integrity | `sha512-ex/WSCywhddGywEqYZO92nruXS9Kzf8vS/KnX5eHGVs189BU3cb3an2pCyuKx20lIzMLpS5grOF6i/XAjS8AYA==` |
| Preparation Node / pnpm | 26.13.0 / 11.19.0 |

The [GitHub release](https://github.com/petercr/jev-orchestrator/releases/tag/v0.6.0)
was published at `00:38:32 UTC`. Its attached archive's reported digest,
independently downloaded bytes, and the public npm tarball all match the
SHA-256 above.

## Scope

The [release notes](../../CHANGELOG.md) cover opt-in saved runs, credential-free
history, explicit same-worktree resume, worker token reporting, the explicit
completion review after validated worker attempts, and the Codex worker's
`gpt-6.1-terra` model. Policy, manual approval and acceptance, immutable
provider/worker/network selection, eight iterations, two calls per worker,
fresh independent validation, and the 95% automatic completion threshold are
unchanged. Saved records use local, unencrypted schema v1 with no migration,
cleanup, crash replay, or cross-machine transfer.

The packaged `CHANGELOG.md` places the `gpt-6.1-terra` bullet between the
completion-review bullet and that bullet's final two lines. The repository
copy was corrected after publication. The published archive is unchanged and
must not be rebuilt or replaced.

## Candidate verification

Verified on 2026-10-31 before the live retest:

- Typecheck, production build, and all 1,624 tests across 49 files passed on
  Linux Node 26.13.0 with `--maxWorkers=1 --no-file-parallelism`.
- The archive installed offline into a private consumer with lifecycle scripts
  disabled; all 92 files matched. The compiled and installed Linux CLIs each
  passed 49 terminal scenarios and two schema-v1 JSON/trace checks with
  synthetic service boundaries.
- PR CI passed check/test/build and the terminal matrix on Ubuntu and Windows
  with Node 22, 24, and 26. Native Windows checks of this exact archive were not
  run locally; the preceding candidate's native Windows results are recorded in
  the [completion-review fix record](../workflows/v0.6-completion-review-fix.md)
  and are not attributed to this archive.
- npm's publication dry run, with empty user and global configuration,
  accepted the archive with matching size, file count, SHA-1, and integrity.
  A credential-free registry check at that time found `0.6.0` absent (HTTP 404),
  `latest` at `0.5.0`, and no remote `v0.6.0` tag.

## Live acceptance

The frozen [rerun amendment](../workflows/v0.6-live-retest-20261031b.md) passed
all three required scenarios with real TypeSafe/Jev (`jev-1.14.0` served),
Codex CLI 0.166.0 on `gpt-6.1-terra`, and Claude Code 2.1.316. These were Codex
styled stop/resume, Claude plain stop/resume, and active Codex interruption
followed by resume. Each task met its external oracle and received separate,
explicit acceptance on iteration 6. The
[earlier cohorts](../workflows/v0.6-live-retest-results-20261028.md) and the
same-day Codex usage-limit attempt remain recorded and were not replaced.

## Publication and registry verification

The operator approved publication after merging PR #74, with advance notice of
the npm browser sign-in. npm required a fresh web sign-in and a separate timed
publish authorization. npm accepted the exact archive with `public` access and
tag `latest`, then processed it for about a minute before exposing public
metadata. Nothing was rebuilt or republished while waiting.

Verified after publication:

- Credential-free registry metadata reports version/latest `0.6.0`, the
  `dev-agent` executable, Node `>=22`, and matching SHA-1, integrity, file
  count, and unpacked size. The downloaded registry tarball matches the
  candidate SHA-256 exactly.
- A fresh public-registry consumer installed `dev-orchestrator@0.6.0` with
  lifecycle scripts disabled. Only that disposable consumer excluded the exact
  version from pnpm's `minimumReleaseAgeExclude` age guard. All 92 installed
  files match. The Node shebang and executable mode are preserved, and
  `dev-agent --version` reports `0.6.0`.
- The registry-installed CLI passed all 49 terminal scenarios and two
  schema-v1 JSON/trace checks with synthetic service boundaries. No live model
  or worker ran in these verification checks.
- Annotated tag `v0.6.0` points to the verified publication commit. The
  GitHub release is marked latest.

Registry metadata, downloaded tarball, consumer install, installed-file
comparison, terminal report, release notes, and GitHub download proof are
retained outside Git under `/home/peterc/.cache/dev-v06-release-20261031`. The
candidate archive, live protocol, and observations remain under
`/home/peterc/.cache/dev-v06-retest-20261031c`.

Later README/changelog updates are documentation changes after release, not
replacements for the immutable published archive. Historical archives remain
unchanged.
