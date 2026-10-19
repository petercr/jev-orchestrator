# Opt-in workflow study helpers

This instrument belongs to the [v0.4 protocol](../../docs/workflows/v0.4-live-protocol-v1.md),
including its [recorded launcher amendment](../../docs/workflows/v0.4-live-protocol-amendment.md).
It is separate from the historical issue #31 benchmark and does not answer CLI
prompts, alter assessments, or grant approvals. No package script or automated
test launches live work.

Use Node 22 and operator-authorized disposable repositories/services. Freeze
archives and install them in separate disposable consumers with lifecycle
scripts disabled. Verify the public baseline's registry integrity. Build the
candidate from a recorded clean revision before creating the study's source
changes. Do not install a mutable package alias again during collection.

Create an evidence directory outside the repository containing `repos/`,
`observations/`, and `inputs.json`. Inputs must include:

- `fixtureDate`: a fixed valid Git timestamp so paired task commits match.
- `instrumentSha256`: SHA-256 of the exact `study.mjs` bytes.
- `packages.baseline` and `packages.candidate`, each with `archive`, `sha256`,
  `entrypoint`, `entrypointSha256`, `installedRoot`, and `installedFiles`.
  `installedFiles` maps every installed package-relative file to its SHA-256.
  Verify installed bytes against the archive first. Supply an absolute **real
  path** for `entrypoint`: resolve pnpm symlinks with `fs.realpathSync` before
  freezing; the CLI's direct-invocation guard compares entry-point URLs.
- Record source revision, registry integrity/available provenance, Node and
  worker versions, worker model/effort/permissions, authorization, and approval
  mode as additional metadata. Do not record credentials.

Then prepare once, before any live call:

```bash
node scripts/workflows/study.mjs prepare /absolute/evidence-directory
pnpm env:run node scripts/workflows/study.mjs run /absolute/evidence-directory r01 --live
node scripts/workflows/study.mjs inspect /absolute/evidence-directory r01
node scripts/workflows/study.mjs report /absolute/evidence-directory
```

Launch r01 through r08 in the frozen order, reviewing every real CLI prompt
interactively. A process observation is written before spawn and cannot be
replaced, even after failure. The launcher checks protocol/helper/package
hashes, pristine task files, run order, and launch budgets. Keep the instrument
and protocol unchanged during collection. Any necessary amendment must preserve
the original artifacts, explain its timing and impact, and retain all previous
observations; it cannot silently fill missing cells.

For staged repair, call `inspect` after the first worker and before approving
its first independent test. Inspect again before approving completion and after
termination. Inspect checks allowed files and the original behavioral examples
in a bounded local Node process. This is external reporting evidence, never a
substitute for the CLI's fresh approved independent checks. Report reads traces
and inspections only; absent summaries stay null. Inspect evidence becomes
stale if task-file hashes or the validation generation change.

The wall cap interrupts the CLI so its existing cancellation controller drains
worker cleanup. The helper forwards signals and records the actual terminal
status. Preserve process records, traces, inspection history, task patches,
archives, package inputs, protocol/checksum, and generated `results.json`
locally. Do not commit downloaded packages, traces, credentials, or task output.
The versioned report contains bounded aggregate evidence and limitations.

During this pilot, bounded `stateAfter` snapshots truncated validation script
labels in the repair runs. The frozen instrument consequently reports
`independentlyPassed: false` for those inspections. Preserve that conservative
result. The supplemental [receipts.mjs](receipts.mjs) reader was added after the
observation; it requires actual approved, successful, current-generation
test/lint receipts plus the matching final validation summary. It does not
infer evidence from worker claims or a summary alone. Reproduce that audit with:

```bash
STUDY_ROOT=/absolute/evidence-directory node --input-type=module - <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { auditValidationReceipts } from './scripts/workflows/receipts.mjs';
const root = process.env.STUDY_ROOT;
const protocol = JSON.parse(fs.readFileSync(path.join(root, 'protocol.json'), 'utf8'));
for (const run of protocol.runs) {
  const directory = path.join(run.repo, 'traces');
  const files = fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((file) => file.endsWith('.jsonl')) : [];
  if (files.length > 1) throw new Error('Multiple observations');
  const rows = files.length ? fs.readFileSync(path.join(directory, files[0]), 'utf8')
    .trim().split('\n').map(JSON.parse) : [];
  console.log(JSON.stringify({ id: run.id, receipts: auditValidationReceipts(rows) }));
}
JS
```

These receipts establish validation only. Acceptance still separately requires
the unchanged final inspection's original examples, current task-file hashes,
allowed scope, and task review. Completion additionally requires the terminal
process result and actual approved FINISH. See the live report for the combined
audit and the raw instrument's limitation.

Run the offline guard tests without credentials or live services:

```bash
pnpm exec vitest run src/workflow-study.test.ts src/workflow-receipts.test.ts
```
