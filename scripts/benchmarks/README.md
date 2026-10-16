# Matched worker benchmark (issue #31)

This opt-in protocol compares the packaged JEV CLI with direct calls to the same
installed worker adapters on TrusTrove #949. It launches live, authenticated
workers and a live TypeSafe evaluator. It is never part of automated tests.
Run it only for repositories and services you are authorized to use.

This worker protocol is pinned to `jev-orchestrator@0.2.0`; initialize and pack
from a v0.2 source checkout. Its version guard deliberately rejects v0.3.
The [recorded comparison](../../docs/benchmarks/issue-31.md) identifies the
measured runtime revision. The separate [v0.3 decision comparison](../decisions/README.md)
uses labeled snapshots and does not launch coding workers.

The task input is the exact public issue URL. Both setups receive the same
bounded, fetched issue and contributor-instruction evidence. Direct preparation
uses the installed bounded readers and context builder, outside the worker;
its time is recorded. This controls for evidence and tool access rather than
comparing a prepared worker with an unrestricted worker discovering its task.
The JEV loop still resolves policy and requires individual approval for every
candidate, recovery, and completion. `run-case.mjs` forwards operator input;
it does not generate approvals. Review acceptance before approving `FINISH`.

Use an external output directory containing a `manifest.json` with the frozen
task, repository baseline, source checkout, CLI versions, executable paths,
and twelve-case run order. Retain the actual manifest with the receipts.
Use three repetitions of each setup and alternate which setup goes first
within each worker pair. Run only one measured worker or root validation at a
time. The checked-in scripts are copied into the output directory so a receipt
can identify exactly which harness ran.

The fixed protocol uses one implementation attempt per observation. Retain a
failed validation outcome and stop the observation rather than replacing or
editing that sample. This isolates the first implementation attempt and does
not exercise controlled repair; JEV's two-call adapter limit remains unchanged.
After a stopped JEV loop, use `verify-case.mjs ... --validate-remaining` to audit
root checks the loop did not attempt. These checks have separate receipts and
timings; they do not change the loop state, counts, approvals, or completion.

```bash
# Build and pack the source revision being measured into the output directory.
node scripts/benchmarks/init.mjs /external/output
pnpm check
pnpm test
pnpm build
pnpm pack --out /external/output/jev-orchestrator-0.2.0.tgz

# The dependency seed must contain the pinned baseline's prepared dependencies.
# Preparation makes new Git clones, copies independent dependency trees,
# and installs from the frozen lockfile. No original checkout is edited.
node scripts/benchmarks/prepare.mjs /external/output /prepared/dependency-seed
node scripts/benchmarks/baseline.mjs /external/output

# Execute cases in manifest.runOrder. JEV reads sourceCheckout/.env privately.
# Review each displayed JEV candidate, then enter a single response.
node /external/output/harness/run-case.mjs /external/output codex-jev-1

# At JEV's completion-review prompt, independently inspect its patch and run:
node /external/output/harness/verify-case.mjs /external/output codex-jev-1
# Then choose FINISH if offered, review it, and approve only after acceptance.
# Run the verifier again afterward to record the terminal summary.

# Direct workers implement only. Run the four root checks outside the worker.
node /external/output/harness/run-case.mjs /external/output codex-standalone-1
node /external/output/harness/verify-case.mjs /external/output codex-standalone-1 --validate

# Repeat for the remaining Codex and Claude cases without replacing failures.
node /external/output/harness/report.mjs /external/output
node /external/output/harness/audit.mjs /external/output
```

The instrumentation proxy changes output format to structured events in both
setups and converts the final response back to plain adapter output. It pins
Claude to the explicit `claude-sonnet-5-5` identifier with medium effort; Codex
retains `gpt-5.6-terra` with high effort. All original restricted tools, strict
MCP configuration, workspace sandbox, and explicit networking settings are
preserved and recorded. Worker and validation timeouts remain 15 minutes and
120 seconds respectively. Logs have an 8 MiB bound per stream. Provider keys
are redacted and removed from worker/validation environments.
The harness requires Node.js 22+ and the existing pnpm project tooling. It has
no Python dependency. Independent TypeScript probes use the source checkout's
installed `tsx` loader, including on Node 22 without native TypeScript loading.
The original study used Node.js 24.21.0.

Each observation retains original/instrumented arguments, full worker events,
actual reported usage and cost when supplied, root validation exit statuses and
logs, a reversible patch, a fifteen-case independent acceptance probe, and the
new tests run against both the patch and the original function. Additional
acceptance audits sit outside the measured core phases; in JEV they occur
within operator waits. Direct active time sums the measured preparation/worker
pipeline and separate root checks, excluding gaps between externally scheduled
phases. Neither value represents unattended end-to-end latency.

Retain unsuccessful workflows as scheduled observations. A valid independently
verified patch and a successfully completed approval loop are separate outcomes.
Do not extend budgets or infer missing validation, usage, cost, or served model
versions. Report sample counts, means, medians, ranges, and limitations; three
repetitions on one frontend task cannot establish a general speed advantage.
The aggregate includes both all-attempt timings and separate successful-workflow
statistics with their own sample counts. A fast failed attempt is not a speed win.

Offline instrumentation regressions use fake executable boundaries:

```bash
pnpm exec vitest run src/benchmark-tools.test.ts src/benchmark-receipts.test.ts
```

Rebuild a preserved study without any provider or worker calls:

```bash
node scripts/benchmarks/report.mjs /preserved/evidence --output /external/rebuilt
node scripts/benchmarks/audit.mjs /preserved/evidence --output /external/rebuilt --recorded-source
```

`--output` writes reporting artifacts separately and leaves the original evidence
unchanged. For the issue #31 evidence directory, see the [recorded report](../../docs/benchmarks/issue-31.md#reproduction-and-evidence).
The normal audit checks the current source checkout and other protected checkouts.
Use `--recorded-source` only when auditing a historical study after the source
checkout has advanced: it verifies the recorded source Git revision and marks
that mode in the audit receipt. Other protected checkouts are still checked in
place. It never executes commands stored in receipts.

Inputs and command logs have an 8 MiB bound. Commands are passed as argument
arrays, with fixed deadlines and process-group cleanup. Setup and case execution
refuse to replace existing cases; verification reuses recorded attempts and
never reruns failed observations. New verification logs are created exclusively.
