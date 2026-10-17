# dev-orchestrator 0.3.0 npm candidate

Prepared and verified on 2026-10-17. npm publication remains pending: this
machine needs an authenticated npm account, and the final merged release source
must be recorded before publishing the verified archive.

The operator selected `dev-orchestrator` (Decisions + Jev) after confirming that
the existing `jev-orchestrator` npm package belongs to another project. The
registry returned `E404` for the new name on 2026-10-17; this observation does
not reserve the name or establish publishing permission.

| Item | Candidate |
| --- | --- |
| Package | `dev-orchestrator@0.3.0` |
| Compatible executable | `jev-agent` |
| Source repository | `petercr/jev-orchestrator` |
| Baseline before rename | `5b2782faddd8fff507cda8f73fa2949be142c0e3` |
| Candidate source | Baseline plus the package-identity changes; uncommitted at packing |
| Archive | `dev-orchestrator-0.3.0.tgz` |
| Size | 83,021 bytes |
| SHA-256 | `1a50bc543657832df9fa8c0ba73dbc97ee7575f7838eba87aa650d1d2ce97a45` |

Package metadata now includes the new name and source repository. README,
release notes, repository guidance, and human CLI banners use Dev Orchestrator.
The compatible executable, provider configuration/aliases, trace labels, policy,
independent validation, and worker permission boundaries are preserved.

Verification passed:

- 39 focused CLI tests, typecheck, all 1,084 tests, production build, and
  schema-only validation.
- Offline installation of the exact archive into a disposable consumer, with
  47 installed CLI checks covering version/help, the Dev Orchestrator banner,
  all six model routes, canonical/legacy selectors, credential/model aliases,
  keyless mocks, and failures before requests. All 18 transport requests were
  mocked; no live model or worker was called. The consumer stayed unchanged
  and produced no traces.
- Archive inspection: exactly 68 files, including 64 runtime/declaration files
  and package metadata, README, CHANGELOG, and license. Installed files match
  the archive; tests, source, traces, credentials, dependencies, and local
  artifacts are excluded. The Node shebang and executable permission remain.
- Runtime comparison against the original GitHub archive: every compiled file
  matches byte for byte after the two CLI banners change from Jev to Dev.
- `npm publish <archive> --dry-run --ignore-scripts` accepted the renamed
  package and reported the expected name, version, and 68-file payload. This
  made no registry publication and still requires npm authentication.

The archive, verifier, offline installation log, 47-check report, package audit,
and source-file hashes are retained locally under
`/home/peterc/.cache/jev-package-checks/dev030-dxotlxn0`. Source hashes preserve
the candidate attribution until its final commit is recorded after merge.

The [published GitHub v0.3.0 archive](v0.3.0.md) retains its original
`jev-orchestrator@0.3.0` identity, filename, and SHA-256. Its public release and
tag were not replaced. Historical worker benchmarks also retain their measured
package names. This separately named npm candidate has its own archive and
checksum; neither artifact establishes that the other was published to npm.
