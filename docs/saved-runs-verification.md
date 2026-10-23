# v0.6 offline restart verification

PR 5 of the [v0.6 plan](../PLAN.md#v06-draft-saved-runs-and-safe-resume)
extends the resume implementation merged in PR #69. The package version is
still `0.5.0`; these are checkout archive checks, not a published v0.6 release.
The separately authorized live pilot remains a release requirement.

## Enforcement coverage

`src/saved-runs/matrix.test.ts` exercises all six evaluator routes with both
worker selections: direct TypeSafe/Jev, Vercel/Jev, OpenRouter/Jev,
OpenRouter/OpenAI Decisions, and Cloudflare Clef/Clef-flash. Each of the 12
combinations has a successful three-segment task and an exhausted-budget task,
for 24 cases. Each segment binds a fresh evaluator using stored configuration
and reconstructed durable state. HTTP and coding-worker boundaries are
synthetic; Git inspection, policy, candidates, approval, execution transitions,
independent Node checks, snapshots, and the store remain real.

Successful tasks stop after implementation, resume to reread instructions and
stop again, then resume to reread and independently validate before explicit
completion acceptance. Seven distinct iteration reservations, one actual
worker dispatch, three trace segments, and fresh validation generation 3 are
asserted. A moderate completion assessment requires selecting FINISH and then
approving its resolved candidate. Previous approvals never execute again.

Exhaustion tasks consume both calls to the selected worker over separate
segments, retain the excluded worker restriction, and stop at the original
seven-iteration ceiling. Neither the model nor a manual alternative can grant
a third call, transfer allowances, or finish without validation. The terminal
result is `iteration_limit`, exit 1, with the patch and ledger preserved.

CLI failure checks block before evaluator binding, review, approval, or dispatch
for missing credentials, conflicting/empty selectors, changed Cloudflare
account, changed HEAD, unavailable repositories or instructions, run/worktree
owners, invalid snapshots, partial ledgers, and unresolved execution. Removed
validation scripts remain required after content review. Existing store and
loop fixtures additionally exercise partial writes, failed persistence at each
boundary, stale ownership, unknown schemas, cancellation, and explicit
evaluation recovery. These tests use deterministic fixtures without live calls.

## Process and terminal coverage

The [optional harness](../scripts/terminal/README.md) retains the 33 original
unsaved terminal scenarios and adds 14 saved-run scenarios, for 47 per full
matrix. Each worker uses three separate CLI processes for its accepted task;
additional processes stop at the continuation review with typed stop, EOF,
Ctrl+C, and timeout. Styled Codex enables networking explicitly; plain Claude
retains restricted tools. Empty/invalid review input grants nothing. Declined
reviews leave checkpoint and ledger bytes unchanged and release ownership.

Each walkthrough also checks six preflight blockers per worker in bounded pipe
processes, plus credential-free list/show. After the second clean stop, the
harness changes instruction and check contents. The final review displays
these changes, rereads instructions, performs independent validation, and
requires a separate completion approval. Actual worker launch counts, durable
iterations, validation generations, trace linkage, and empty ownership
directories are asserted. State homes are isolated outside worker repositories
on each platform; real operator history and credentials are never loaded.

Existing assertions retain parameter visibility, wrapping, terminal injection
and credential redaction, raw mode/cursor/signal cleanup, POSIX terminal flags,
prompt and active-process interruption, partial edits, current-generation
validation, and conventional exits. Both decision-only JSON/trace cases retain
schema 1; orchestration traces retain schema 2. There are no runtime dependency,
permission, policy, or package-version changes in this milestone.

## Evidence and limits

Local results and the checkout archive receipt are retained outside Git under
`/home/peterc/.cache/dev-v06-verification/20261023`. Native Windows fixtures,
reports, and installed consumer are under
`C:/Users/pcruc/AppData/Local/Temp/dev-v06-20261023`. Failed and intermediate
captures remain alongside the final results.

| Local environment | Node | Compiled / installed terminal scenarios |
| --- | --- | --- |
| WSL2 Linux, POSIX PTY | 22.23.3 | 47 / 47 passed |
| WSL2 Linux, POSIX PTY | 24.22.1 | 47 / 47 passed |
| WSL2 Linux, POSIX PTY | 26.12.1 | 47 / 47 passed |
| Native Windows, bundled ConPTY | 26.7.0 | 47 / 47 passed |

These eight full matrices total 376 terminal walkthroughs. Every full matrix
also checks both schema-v1 JSON/trace variants. Final
installed matrices include all 12 preflight blockers; native compiled checks
repeat the saved scenarios with these blockers as separate captured runs.
All 1,551 tests across 46 files passed serially, alongside `pnpm check`,
`pnpm build`, and `pnpm env:check:schema`.
The candidate archive contains 86 files and no source, tests, terminal driver,
or native harness dependencies. Its SHA-256 is
`0260aa55faf6c724a79b27b75b38c221b232242addaab71ae3c7329c7667715a`;
`package-receipt.json` retains each archived file's hash and the base commit.

The [terminal workflow](../.github/workflows/terminal.yml) runs compiled and
independently installed matrices on Ubuntu and Windows with Node 22, 24, and
26, retaining reports and captures for seven days. Local evidence covers Linux
PTYs and native Windows ConPTY; Windows 22/24 are CI checks. ConPTY's pinned
test-driver cleanup remains separate from product process cleanup.

These checks establish restart enforcement and terminal behavior with
synthetic boundaries. They do not establish live model routing quality,
credential account continuity, power-loss durability, Windows ACL hardening,
native coding-worker launcher availability, screen-reader behavior, or macOS
terminal behavior. Windows continues to inherit the parent ACL and omit
directory flushes, as described in the [storage contract](saved-runs-v1.md).
No model or coding-agent service was called, and nothing was published.
