# dev-orchestrator 0.3.1 npm publication

Published [dev-orchestrator@0.3.1](https://www.npmjs.com/package/dev-orchestrator/v/0.3.1)
on 2026-10-17 at 19:12:40 UTC through npm account `petercr`, after PR #48 merged
and the operator completed npm browser authorization. Public registry metadata
reports `latest: 0.3.1`; the public archive matches the preverified archive byte
for byte.

| Item | Release |
| --- | --- |
| Package | `dev-orchestrator@0.3.1` |
| Executable | `dev-agent` |
| Preparation commit | `09abdca884116eb728e4ba5b1a8095a4a8653d6d` |
| Final merged release source | `82676b9f2cb31f9c394155cd6fac345186e01dba` |
| Release tree | `f9ada91cad7e71aa568ad5fa15f819a6e3f8a448` |
| Archive | `dev-orchestrator-0.3.1.tgz` |
| Size | 83,471 bytes |
| SHA-256 | `0887ace54f08dce131b450ea22025fffe94e47c7f9e58a3373f1503d58edc3d7` |
| SHA-1 | `d74059c54a9b9b55b0789bc3a975fced715268a0` |
| Integrity | `sha512-jbES4oonjswVSyjoMmsqKm4jgTMpo3PaJuJ6SaBMVNl90nSBR8lYCepnPh7/nt7F+ClubAnd9bkiq4XOl+I68g==` |

This patch renames the executable from `jev-agent` to `dev-agent`. Update shell
commands, package scripts, and CI invocations when upgrading; the package exposes
only `dev-agent`. CLI flags, provider configuration and aliases, policy, manual
approval, independent validation, and worker permissions remain compatible.

Verification before publication:

- 39 focused CLI tests, typecheck, all 1,084 tests, and the production build
  through `pnpm pack` passed. PR #48's check/test/build and Socket checks passed.
- The exact archive installed offline in a disposable consumer and passed 47
  installed CLI checks with 18 mocked transport requests. All six model routes,
  aliases, defaults, help, version, and keyless mock/preflight checks passed.
  No live model or worker was called, and the consumer stayed unchanged.
- Only the `dev-agent` executable was installed. All 68 installed files match
  the archive, the Node shebang and executable mode are preserved, and source,
  tests, traces, credentials, dependencies, and local artifacts are excluded.
- The preparation and merge trees are identical, and all 73 recorded source
  hashes match the final merged source. The publish preflight records source
  attribution, all three archive digests, npm account `petercr`, and the public
  registry. Version `0.3.1` was absent from the registry during this preflight.

Verification after publication:

- Public metadata confirms the package, version, `latest` tag, maintainer,
  repository URL, and `dev-agent` executable. The standard credential-free
  download matches the saved archive byte for byte and all three recorded
  digests.
- A separate registry installation with lifecycle scripts disabled passed the
  same 47 installed CLI checks and 18 mocked transport requests. No live model
  or worker was called, and the consumer stayed unchanged. Its release-age
  exception covers only `dev-orchestrator@0.3.1` in the disposable consumer.
- All 68 installed files match the public archive, executable mode is preserved,
  only `dev-agent` is installed, and the lockfile records the registry integrity.
  An initial cached registry 404 expired before the successful installation;
  both installation logs are retained.

The archive, verifier, install log, package audit, source hashes, and publish
preflight are retained under
`/home/peterc/.cache/jev-package-checks/dev031-1x1cbspe`. The archive was packed
before the preparation commit; no repack was needed after merge.

Public download metadata, registry installation logs, the second 47-check report,
and installed-file verification are retained in `registry-verification/` under
the same evidence directory. This publication documentation follows the source
commit above and does not change or repack the published archive.

The [0.3.0 npm release](dev-orchestrator-0.3.0.md) and original
[GitHub v0.3.0 archive](v0.3.0.md) retain their original executable names and
checksums. This release has a separate version and archive.
