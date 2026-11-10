# Saved-run history JSON v1

This unreleased reporting format is available in the current checkout:

```bash
dev-agent --list-runs --json
dev-agent --show-run <run-id> --json
```

Both commands read the existing local store without credentials, network
access, repository inspection, writes, locks, traces, or prompts. `--plain` may
also be supplied; JSON bypasses terminal rendering. Task arguments, execution
overrides, and `--resume --json` are rejected. Published v0.6.0 predates this
format.

Each successful inspection writes one JSON document to stdout. Select its
`kind` and `schemaVersion` before consuming fields. This schema is separate
from decision JSON v1, orchestration traces v2, and saved records v1. Those
formats are unchanged. A history report cannot be imported or resumed.

## List envelope

An empty store produces:

```json
{
  "schemaVersion": 1,
  "kind": "saved-run-list",
  "readOnly": true,
  "status": "ok",
  "limit": 20,
  "total": 0,
  "hiddenRuns": 0,
  "ignoredEntries": 0,
  "runs": []
}
```

`runs` contains at most 20 reports. Unreadable records appear first, followed
by valid records in descending saved update time, with run ID breaking ties.
`total` counts recognized run IDs; `hiddenRuns` counts those outside the list.
`ignoredEntries` counts unrecognized store entries without exposing their names.
The existing 128-entry scan limit remains; a known ID can still be inspected
directly when listing fails or omits it.

`status` is `partial` when the displayed runs include an unavailable record or
unrecognized entries were ignored. Otherwise it is `ok`. Hidden valid records
alone do not make the report partial.

## Detail envelope and reports

Detail uses `schemaVersion: 1`, `kind: "saved-run-detail"`, `readOnly: true`,
`status: "ok" | "unavailable"`, and a single `run` report. A valid saved run
has these fields:

| Field | Meaning |
| --- | --- |
| `kind`, `runId`, `status` | `valid`, the validated UUID, and the saved lifecycle status. |
| `createdAt`, `updatedAt`, `segments` | Saved timestamps and ledger-derived segment count. |
| `task` | Bounded, sanitized saved task text. |
| `repository` | Saved canonical root and directory availability; detail adds saved `head` and `gitCommonDirectory`. |
| `configuration` | Saved mode, provider/model, worker selection (`auto`, `codex`, or `claude`), and Codex network boolean. |
| `iterations` | `used`, original `limit`, and `remaining`, derived from validated reservations. |
| `workerCalls` | Per-worker `used`, `available`, and `excluded`; excluded workers have zero available calls. |
| `workerUsage` | Per-worker reported input/output/total tokens, `reportedCalls`, and `unavailableCalls`. |
| `validation` | Saved `generation` and `checks`, each with a script and `passed`, `failed`, or `pending` status. |
| `continuation` | `preflightRequired: true`, explicit recovery requirement, and recorded blockers. |
| `lastFailure`, `lastStop` | Optional bounded descriptions when recorded. |
| `timeline` | Detail only: total event count and the latest 12 `recent` events, each with sequence, timestamp, type, and a bounded description. |

Usage is reporting data. An unresolved attempt stays charged, and unavailable
usage is counted explicitly rather than reconstructed. Earlier passing checks
describe the saved generation; continuation starts fresh validation. Directory
availability does not check current HEAD, working files, instructions, or
configuration. Even an empty blocker list does not authorize resume or task
completion. `continuation.preflightRequired` is always true.

All free text uses the same bounded credential redaction and terminal-control
sanitization as human-readable history. The projection never includes the raw
checkpoint, full task state or evidence, approval objects, executable
candidates, account fingerprints, checksums, or full event payloads.

An unavailable record contains only `kind: "unavailable"`, its validated
`runId`, and an `error` with an allowlisted `code` and description. Unverified
task, timestamp, status, budget, and configuration fields are never recovered
from malformed records for display.

## Exit codes and errors

- Exit 0: empty listing or successful inspection, including a valid blocked or
  finished saved run. `status: "ok"` means inspection succeeded.
- Exit 1: partial listing, missing/unreadable run, or another operational error.
- Exit 2: invalid command usage.

Command-level failures, such as an unreadable store or invalid flags, use the
existing CLI JSON error envelope (`schemaVersion: 1`, `status: "error"`,
`error`, `exitCode`) on stderr, leaving stdout empty. They do not fabricate a
history report. Inspection never
repairs storage, clears ownership, changes permissions, or runs a saved action.
