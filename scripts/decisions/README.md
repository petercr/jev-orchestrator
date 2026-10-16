# Decision snapshot comparison

This v0.3 study evaluates the four decision models against the same 14 synthetic
coding-task snapshots. It invokes the existing evaluator and policy, and checks
worker candidates for selection/call budgets. It executes no repository tool,
validation command, or coding worker. Recommendations remain unexecuted.

`fixtures.mjs` fixes labels before live evaluation. Cases cover unread issues
and instructions, both worker selections, missing acceptance criteria, stuck
work, failed/stale/pending validation, exhausted workers, redundant tests,
baseline-only tests, accepted completion, and explicit evaluation recovery.
Failed validation permits either reading the known failing file or delegating
a bounded repair. Other cases have a single reference action. Predicate labels
are omitted where their interpretation is ambiguous. Labels and rationales are
never sent to a model. These hand-authored labels are a small project-specific
reference set, not universal ground truth for coding workflows.

The fixed routes are direct TypeSafe `jev-latest`, Cloudflare `clef` and
`clef-flash`, and OpenRouter `openai/gpt-6-luna-decisions`. Keep the production
TypeSafe default and all approval, worker, iteration, validation, and confidence
controls unchanged. Provider prerequisites and data handling are documented in
[README](../../README.md#evaluation-providers). Only synthetic snapshot evidence
is sent to those services. The comparison needs the existing TypeSafe,
Cloudflare, and OpenRouter credentials, plus the Cloudflare account ID.

```bash
pnpm build
pnpm compare:decisions --plan

# The parent exists; the output directory must be new and outside the checkout.
# Use Varlock to load local credentials, including encrypted values.
pnpm env:run node scripts/decisions/run.mjs --live /external/new-output 3
```

The live opt-in is mandatory. Repetitions are bounded to 1–3, defaulting to 3.
The default schedules 168 evaluations, at most 336 HTTP attempts, sequentially.
Route order rotates by snapshot and repetition. Each evaluator retains the
production 10-second deadline, one transient retry, and 64 KiB response limit;
the study also stops after 15 minutes. Configuration is bound once per route.
Input and question hashes verify identical bounded evidence on every HTTP
attempt. A mismatch stops the study. Existing output directories are refused.

SIGINT/SIGTERM cancels the current evaluation and stops scheduling. Every
completed/failed/interrupted observation is retained, along with planned and
unstarted counts. There is no automatic replacement of failures or executable
resume. A complete comparison includes all scheduled observations, even failures.
Changing labels, prompts, or protocol requires a new study version and cohort.

The output contains a manifest, bounded inputs with separate labels, copied
harness sources, allowlisted observations, and aggregate JSON. Source HEAD,
working-tree status, runtime/harness hashes, served models, and input identity
are recorded. Credentials, headers, account IDs/URLs, raw provider bodies,
error messages, and refusal text are excluded. Usage keeps only explicitly
returned nonnegative integer token counts, with coverage counts. Missing usage
stays unknown; no cost estimate or provider price assumption is made.

Reporting separates raw routing correctness, policy correctness, worker-guard
correctness, forbidden recommendations/selections, policy/candidate overrides,
abstentions, and acceptance-review candidates. A forbidden action is one that
violates the fixture's preparation, worker, validation, or completion boundary;
it does not mean an unsafe action was executed. Abstention/manual-review counts
are potential operator interventions; no operator alternatives are exercised.
Failures remain in the attempted denominator. Refusals are counted only when
an explicit refusal shape was observed; other invalid responses are not guessed
to be refusals. Per-snapshot results retain all repetitions.

Multiclass action Brier is the sum of squared errors over the known actions,
without renormalization; the set-valued repair case is excluded. Predicate
Brier uses only labeled predicates. Five-bin reliability tables compare chosen
action probability and, separately, provider confidence with empirical routing
correctness. Confidence semantics differ across APIs, so its alignment is a
diagnostic, not proof that confidence is a calibrated probability. Missing
confidence is excluded with an explicit sample count. Timing uses the local
monotonic clock and includes transport, bounded response instrumentation,
retries, and backoff. All-attempt and normalized-only latency distributions have
their own counts; p50/p90/p95 use nearest rank. This is decision latency, not
end-to-end coding-agent performance. Repeated small synthetic snapshots cannot
establish general quality, safety, speed, or confidence calibration.

Offline tests use repository-owned assessment fixtures and no live requests:

```bash
pnpm exec vitest run src/decision-benchmark.test.ts
```
