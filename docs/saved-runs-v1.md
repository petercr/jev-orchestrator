# Saved-run storage contract v1

This document records the storage contract introduced for v0.6 PR 1. The CLI
now creates records through opt-in `--orchestrate --save-run` and inspects them
through `--list-runs` / `--show-run <run-id>`. Executable resume remains planned.
Saved records are never executable instructions or approved candidates.

## Files and bounds

The default store is outside the repository:

- Windows: `%LOCALAPPDATA%\\dev-orchestrator\\saved-runs`, falling back to
  `%USERPROFILE%\\AppData\\Local\\dev-orchestrator\\saved-runs`.
- macOS: `~/Library/Application Support/dev-orchestrator/saved-runs`.
- Other Unix systems: `$XDG_STATE_HOME/dev-orchestrator/saved-runs`, falling
  back to `~/.local/state/dev-orchestrator/saved-runs`.

The store contains `runs/<uuid>/checkpoint.json`,
`runs/<uuid>/events.jsonl`, and ownership files under `locks/`. It is rejected
when located inside the selected worker-writable repository. Run IDs are
version-4 UUIDs; callers cannot choose a path through an ID.

Inspection does not create a missing store, change permissions, write traces,
acquire locks, or remove ownership files. It verifies checkpoint/ledger integrity
before displaying saved data. A present update lock prevents a stable read;
concurrent writes can also produce an integrity error, which is reported
without repair. Run and worktree locks are reported conservatively, since a PID
cannot prove whether ownership is stale. Inspection does not require the
repository to exist or resolve provider credentials.

Listing scans at most 128 store entries and displays at most 20 records, placing
unreadable records first and sorting valid records by update time. Unknown
entry names are counted without displaying them. A store with more than 128
entries refuses listing; `--show-run` still reads a known ID directly. Detail
shows up to 12 recent events. Unreadable records display only the validated ID
and an allowlisted error classification; unverified checkpoint text is never
used as fallback. Listing or showing never grants continuation permission.

| Record | Limit |
| --- | ---: |
| Checkpoint | 1 MiB |
| Event record | 4 KiB |
| Events per run | 128 |
| Runs per store | 128 |
| Orchestration iteration ceiling | 8 |
| Calls per worker | 2 |

The v1 checkpoint has exactly these top-level fields: `schemaVersion`,
`runId`, `createdAt`, `updatedAt`, `sequence`, `ledgerHead`, `status`,
`iterationLimit`, `repository`, `configuration`, `state`, and `checksum`.
The repository identity contains the canonical worktree root, Git common
directory, full HEAD object ID, and a worktree fingerprint. Configuration
freezes mock/live mode, provider and model identifiers, worker selection, and
Codex network permission. Cloudflare records also contain a SHA-256 fingerprint
of the account ID; the account ID itself is not stored.

`state` is a bounded, validated `AgentState`. Known current environment
credentials are redacted from persisted text. Provider keys, Cloudflare account
IDs, raw environment values, transport objects, abort signals, raw provider
responses, and executable candidates are excluded. Task text and bounded
repository excerpts can still contain sensitive information; the local store
is not encrypted, and pattern-based redaction cannot identify every secret.

No automatic retention or deletion is provided. For manual housekeeping, stop
the CLI and confirm that no process owns the affected run or worktree before
moving/removing an inactive `runs/<uuid>` directory. Preserve both checkpoint
and ledger when retaining a record. Never edit counters, reconstruct a partial
record, or remove an ownership file based only on its PID to force execution.

## Event ledger and ordering

Events use schema version 1 and are stored as one JSON object per newline. Each
event contains a sequence number, timestamp, previous-event hash, immutable run
identity hash, resulting state hash, event data, and SHA-256 event hash. The
checkpoint stores the current sequence and ledger head. Reads reject duplicate
JSON keys, unknown versions, malformed or oversized records, sequence gaps,
hash mismatches, identity changes, and checkpoint/ledger disagreement. No
migration or trace import is defined; unknown versions are inspection failures
and must never be resumed.

The event vocabulary records run creation and continuation, iteration
reservations, completed/failed evaluations, explicit action approvals,
execution reservations and outcomes, clarifications, clean stops, completion,
iteration exhaustion, and blocked states. Validation enforces increasing
iterations, the original ceiling, worker-call limits, exact call-counter
agreement, approval before dispatch, matching execution outcomes, and current
independent validation plus a fresh `FINISH` approval before a finished status.
Stops and continuations discard any outstanding action approval. An unresolved
execution prevents a resumable stop. These checks validate stored history; they
do not replace the orchestration policy or independently establish that task
acceptance criteria were met.

## Durability and ownership

On POSIX, the store and run directories use mode `0700`, and record and lock
files use `0600`. Writes use a private temporary file, file flush, atomic rename,
and directory flush where supported. Event appends flush the file and parent
directory. A failure between the ledger append and checkpoint replacement can
leave a mismatch; the store rejects that record instead of guessing which
state is current. The store rejects symbolic links and hard-linked record
files. It does not clean up stale locks automatically; an existing owner file
blocks another owner because a PID is not proof that a lock is safe to remove.

On Windows, the implementation requests restrictive creation modes, but
effective access control is inherited from the parent directory and is not
verified or rewritten as an ACL. Directory flushing is skipped because Node's
portable filesystem API does not provide the same supported operation there.
The Windows-specific filesystem and terminal matrix remains part of the later
v0.6 verification milestone; this PR's automated storage tests ran on POSIX.

Exclusive lock files coordinate processes using this store. A run lock keys one
run; a worktree lock keys its canonical root. Lock files are created with
exclusive-create semantics and removed only by their recorded token owner.
External editors and older CLI versions do not participate in these locks.

SHA-256 checks detect corruption and checkpoint-only edits or rollback when
compared with the event ledger. They do not authenticate the operator, protect
against a compromised local account, or detect a coordinated rewrite or
rollback of the entire store. The saved directory must therefore remain under
the operator's control and outside worker-writable repositories.

## Credential continuity decision

Resume will freeze the provider and model identifier and reload the selected
credential from the operator's current environment. It will never save a
credential value or compare a hash of one. Cloudflare's non-secret account ID
can be compared using its stored fingerprint. The other configured providers
expose no non-secret account identity in this client, so continuity for those
credentials cannot be verified. Before implementing resume, its review must
state that limitation and require an explicit operator continuation decision;
reloading a credential does not prove that it belongs to the same account.

Provider aliases such as `jev-latest` also do not pin the model implementation
served later. The current schema binds the selected identifier, not a remote
provider deployment or model revision.
