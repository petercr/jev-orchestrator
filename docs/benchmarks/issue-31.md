# Matched worker benchmark: issue #31

Recorded on 2026-10-13 (America/New_York) for [issue #31](https://github.com/petercr/jev-orchestrator/issues/31). The task was [TrusTrove #949](https://github.com/TrusTrove/TrusTrove-app/issues/949): fix short-address formatting and add production boundary tests.

The twelve scheduled observations are complete. Nine patches passed the full acceptance gate; eight workflows completed successfully. The two Codex setups each produced two accepted patches and one incorrect new test. All six Claude implementations passed the functional probes and new unit tests; one standalone build timed out, and one JEV loop exhausted its iteration budget after a rejected evaluation. These results do not establish a general speed or quality advantage for JEV.

The worker means across all three attempts were 68.7 seconds with JEV versus 70.3 seconds directly for Codex, and 16.4 versus 15.8 seconds for Claude. Validation dominated active time and varied between observations. Successful-only statistics below retain their smaller sample counts; failed observations were never replaced.

## Frozen setup

| Setting | Value |
| --- | --- |
| Runtime package | `jev-orchestrator@0.2.0`, built from `dbfa2e51ff37d525aac04beb00d27031e5c09d31` |
| Packed archive SHA-256 | `9cb222ff9b96de2f7ed178e02acd9f66f36eb58160a728a961b81ed76a53362e` |
| Target baseline | `6cae96e13e950a9e932130ef1a7aebbcddf9c58e` |
| Task input | Exact public issue URL, identical in every run |
| Evaluator | Direct TypeSafe, requested/served `jev-1.13.0` |
| Codex | CLI `0.162.1`, `gpt-5.6-terra`, high effort |
| Claude | CLI `2.1.296`, explicit requested/served `claude-sonnet-5-5`, medium effort |
| Environment | Node.js `24.21.0`, target pnpm `10.30.3`, source pnpm `11.19.0` |
| Limits | Eight JEV iterations, two calls per adapter; one implementation attempt per observation; 15-minute worker timeout; 120-second validation timeout |

Every observation used a new external clone and independently copied dependencies installed from the frozen lockfile. A separate pristine baseline passed typecheck, build, lint, and 800 tests while reproducing the defect at every string length from 1 through 10. Dependency setup and baseline checks were outside measured worker time.

The direct controls used the same installed adapters and received byte-for-byte identical bounded worker contexts: fetched issue evidence and contributor instructions. Their preparation was timed separately. Original and instrumented worker argument arrays match within all six pairs after replacing the selected repository path with a placeholder. Output instrumentation was identical within each pair. This controls for preparation and tool access; it does not measure an unrestricted standalone agent discovering the task itself.

Codex retained `workspace-write`, `--ask-for-approval never`, explicit command networking, ephemeral execution, and ignored user configuration/rules. Claude retained restricted mode, only file tools plus the private bounded rename tool, empty setting sources, explicit settings, strict MCP configuration, and no session persistence. Project test/typecheck/lint/build commands ran outside worker calls. Codex and Claude have different models and tool sets; comparisons are made within each worker pair.

## Observed exceptions

- `codex-standalone-2` implemented the formatter correctly but expected an 11-character input to remain unchanged. Its new test and root test command failed. The functional probe passed; the patch was not accepted.
- `codex-jev-3` implemented the formatter correctly but expected the wrong trailing four characters for an 11-character input. Independent tests failed. The loop offered a bounded repair; the operator stopped at iteration five to preserve the fixed first-attempt protocol. Remaining typecheck/lint/build checks ran as separate post-stop audits. Their timings are explicit and do not modify CLI metrics, state, approvals, or completion.
- `claude-standalone-2` passed tests, typecheck, lint, and functional/regression probes, but build hit the unchanged 120-second timeout while collecting build traces. The process group was confirmed gone. Build remains unverified for this observation; it was not rerun or given a larger budget.
- `claude-jev-2` rejected an evaluation distribution totaling `0.99` under the unchanged `0.001` tolerance. Explicit continuation consumed the last iteration on build. All four current-generation checks passed, but completion approval had no remaining iteration. The loop returned `iteration_limit` and exit code 1, retaining the patch and evidence.

All six JEV runs required a manual worker alternative. The four completed JEV loops also required a manual `FINISH` alternative followed by approval after acceptance review. No worker retries occurred. One evaluation failure and one explicit recovery were recorded. Upstream HTTP retries and worker-internal provider retries are unavailable and are not inferred. Confidence thresholds, worker selection, networking, call limits, independent validation, and completion rules were preserved.

## Per-run and aggregate timings

| Run | Outcome | Worker s | Eval s | Prep s | Validation s | Active s | Prompt wait s | Accepted patch |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| codex-jev-1 | finished | 48.380 | 4.617 | 0.305 | 154.520 | 207.963 | 135.596 | True |
| codex-standalone-1 | ready_for_review | 91.133 | 0.000 | 0.405 | 163.409 | 254.951 | 0.000 | True |
| claude-standalone-1 | ready_for_review | 15.796 | 0.000 | 0.415 | 203.880 | 220.094 | 0.000 | True |
| claude-jev-1 | finished | 15.953 | 2.506 | 0.348 | 196.057 | 215.005 | 216.988 | True |
| codex-standalone-2 | validation_failed | 37.003 | 0.000 | 0.468 | 194.839 | 232.314 | 0.000 | False |
| codex-jev-2 | finished | 68.504 | 2.938 | 0.323 | 206.247 | 278.317 | 314.964 | True |
| claude-jev-2 | iteration_limit | 19.510 | 2.579 | 0.322 | 217.951 | 240.584 | 262.755 | True |
| claude-standalone-2 | validation_timed_out | 16.538 | 0.000 | 0.489 | 213.060 | 230.091 | 0.000 | False |
| codex-jev-3 | validation_failed | 89.151 | 2.019 | 0.306 | 220.617 | 312.451 | 317.441 | False |
| codex-standalone-3 | ready_for_review | 82.737 | 0.000 | 0.612 | 171.053 | 254.405 | 0.000 | True |
| claude-standalone-3 | ready_for_review | 15.079 | 0.000 | 0.421 | 161.293 | 176.797 | 0.000 | True |
| claude-jev-3 | finished | 13.793 | 2.573 | 0.333 | 159.283 | 176.097 | 665.054 | True |

| Setup | n | Accepted patches | Successful workflows | Worker mean / median / range s | Active mean / median / range s |
| --- | ---: | ---: | ---: | --- | --- |
| codex + jev | 3 | 2 | 2 | 68.678 / 68.504 / 48.380–89.151 | 266.244 / 278.317 / 207.963–312.451 |
| codex + standalone | 3 | 2 | 2 | 70.291 / 82.737 / 37.003–91.133 | 247.223 / 254.405 / 232.314–254.951 |
| claude + jev | 3 | 3 | 2 | 16.419 / 15.953 / 13.793–19.510 | 210.562 / 215.005 / 176.097–240.584 |
| claude + standalone | 3 | 2 | 2 | 15.804 / 15.796 / 15.079–16.538 | 208.994 / 220.094 / 176.797–230.091 |

Successful workflows only (failed observations remain in the table above):

| Setup | Successful n | Worker mean / median / range s | Active mean / median / range s |
| --- | ---: | --- | --- |
| codex + jev | 2 | 58.442 / 58.442 / 48.380–68.504 | 243.140 / 243.140 / 207.963–278.317 |
| codex + standalone | 2 | 86.935 / 86.935 / 82.737–91.133 | 254.678 / 254.678 / 254.405–254.951 |
| claude + jev | 2 | 14.873 / 14.873 / 13.793–15.953 | 195.551 / 195.551 / 176.097–215.005 |
| claude + standalone | 2 | 15.438 / 15.438 / 15.079–15.796 | 198.446 / 198.446 / 176.797–220.094 |

Each case retains the invocation, original and instrumented worker arguments, full structured worker events, complete root-validation logs, reported usage/cost when present, patch, regression results, 15-case acceptance probe, and receipt. aggregate.json retains means, medians, ranges, sample standard deviations, counters, attribution, and exact evidence comparisons.

Direct controls use the same installed adapters and bounded issue/instruction preparation. They receive no evaluator or approval loop. The operator reviews each JEV candidate separately and verifies acceptance before approving completion; waits include those audits. Structured-output instrumentation is identical within each pair. Claude uses an explicit claude-sonnet-5-5 model identifier; Codex keeps gpt-5.6-terra/high, workspace-write and explicit command networking. Project tests, typecheck, lint, and build run independently after worker execution.

JEV comparison active time uses the built-in monotonic summary plus any separately timed post-stop root checks. Supplemental durations are explicit and never change CLI state, metrics, approvals, or completion. Direct active time sums its measured preparation/worker pipeline and the separately measured root checks; gaps between externally scheduled phases and additional acceptance audits are excluded. Prompt waits are reported separately. This does not represent fully unattended end-to-end latency.

Three samples on one small frontend task cannot establish a general speed advantage, confidence calibration, or broad correctness. Cache warmth, provider latency, and machine load are uncontrolled across repetitions. Only the TypeScript workspace checks are exercised; Go/database, browser E2E, and dependency audits remain outside scope. Codex upstream model versions and evaluator token usage/cost are omitted when unavailable. Claude cost fields are CLI-reported estimates, not billing receipts. Upstream HTTP retries and worker-internal provider retries are unavailable. The fixed protocol compares one implementation attempt per observation and does not exercise controlled repair.

## Actual reported worker usage

Counts below are the CLI-reported fields. Cached input is not added to input totals; accounting differs between clients. Claude costs are CLI-reported estimates, not billing receipts. Codex cost and evaluator usage/cost were unavailable.

| Codex observation | input_tokens | cached_input_tokens | output_tokens |
| --- | ---: | ---: | ---: |
| codex-jev-1 | 119268 | 103936 | 1684 |
| codex-standalone-1 | 151995 | 126208 | 3174 |
| codex-standalone-2 | 196340 | 179712 | 3041 |
| codex-jev-2 | 158250 | 141312 | 2475 |
| codex-jev-3 | 173547 | 154624 | 3126 |
| codex-standalone-3 | 150445 | 132352 | 2740 |

| Claude observation | input_tokens | cache_creation_input_tokens | cache_read_input_tokens | output_tokens | Reported USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| claude-standalone-1 | 8 | 8951 | 22368 | 1410 | 0.0521568 |
| claude-jev-1 | 8 | 2813 | 28955 | 1617 | 0.0303335 |
| claude-jev-2 | 10 | 3215 | 38211 | 2016 | 0.0368611 |
| claude-standalone-2 | 8 | 2709 | 28897 | 1553 | 0.0292717 |
| claude-standalone-3 | 8 | 2426 | 28897 | 1405 | 0.0266597 |
| claude-jev-3 | 8 | 2419 | 28891 | 1340 | 0.0259811 |

## Reproduction and evidence

The [checked-in harness](../../scripts/benchmarks/README.md) documents initialization, packaging, dependency setup, baseline verification, the alternating run order, individual JEV approvals, direct controls, post-stop audits, and report generation. It requires explicit live use and is excluded from automated tests.

Persistent local evidence is under:
`/home/peterc/.cache/jev-pilots/issue31-matched-20261013-v1k7494x`.
It includes the exact archive and installed consumer lockfile, manifest and harness checksums, original checkout fingerprints, every invocation and worker argument array, complete bounded worker events and validation logs, patches, fifteen-case probes, new tests run against the original function, per-run receipts, aggregate JSON/statistics, and the audit receipt. Credentials and downloaded artifacts are excluded from the repository change.

All 81 preservation/configuration audit checks passed. Target heads, staged indexes, lockfiles, package scripts, and unrelated tracked files were preserved. Each patch changes only `apps/web/lib/format.ts` and `apps/web/lib/format.test.ts`, and reverse patch checking passes. The original issue #80 checkout, prior TrusTrove pilot checkout, and orchestrator runtime files were preserved. No upstream contribution was published.

The common functional probe passed all fifteen cases for every implementation. Each new test suite detects the original short-input defect; the two incorrect Codex suites also fail against their own patch. Workspace test totals range from 803 to 807, with failures distinguished from passing counts. Only TypeScript workspace checks were exercised; backend Go/database, browser E2E, dependency audit, and whole-repository formatting remain outside this study.

This is a first-attempt study with three observations per setup on one small frontend task. Controlled repair is not exercised. Cache warmth, provider latency, machine load, distinct repository paths/system context, and operator scheduling remain practical limits. JEV also carries evaluator-selection labels in its environment; the worker proxy removes evaluation credentials and uses explicit worker arguments on both sides. Active comparison time includes all required root checks, including separately measured post-stop audits. Approval waits contain operator/harness pauses and additional acceptance audits; they are excluded from active time. No unattended end-to-end speed claim or calibrated-confidence claim is supported.

## Local tooling verification

The four focused Vitest instrumentation tests passed, covering preserved worker
permissions, plain summary conversion, secret redaction, actual usage/model/cost
reporting, incomplete/failed structured turns, and nonzero child exit status.
The four Python receipt tests passed, covering failed/pending test counts,
Node warnings alongside probe JSON, failed validation/timeouts, and sample
statistics without fabricated absent values. Default project tests remain
Node-only; Python is required only for the opt-in benchmark tooling.

`pnpm check`, all 530 Vitest tests across 30 files, `pnpm build`, and
`git diff --check` passed. The packed consumer's keyless mock smoke check passed.
A final scan of 984 retained text artifacts found no configured evaluation
credential values. The 81-check preservation/configuration audit passed again
after the documentation updates. Verification calls used no live provider or
worker beyond the twelve recorded benchmark observations.
