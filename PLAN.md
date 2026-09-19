# Jev Orchestrator v0.1 plan

## Goal

Ship a reliable decision-only CLI. Given a repository path and coding task, it
collects a bounded repository snapshot, asks Jev for a typed recommendation,
applies local policy, prints the decision, and can write a safe JSONL trace.
It does not execute the selected action, modify the target repository, or invoke
Codex or Claude Code.

## Work plan

1. [x] Make setup predictable.
   - Pin the tested AI SDK release.
   - Document a Node 22 `--env-file=.env` command for live use.
   - Fail before a live request when `AI_GATEWAY_API_KEY` is missing or blank.
   - Keep mock mode independent of credentials.
   - Complete when a fresh checkout can install and run the documented mock
     command, while a keyless live run gives a clear error.

2. Harden Jev evaluation.
   - Add a request deadline and bounded retry policy.
   - Present clear, credential-safe errors for authentication, rate limits,
     unavailable models, and invalid responses.
   - Validate provider confidence metadata at the integration boundary.
   - Complete when provider failures are bounded and predictable.

3. Bound repository inspection.
   - Validate that the input is a directory and safely handle malformed
     `package.json` data and non-Git repositories.
   - Bound repository metadata, task text, Git output, and evaluation input.
   - Complete when large or unusual repositories cannot hang the CLI or create
     oversized evaluation requests.

4. Complete deterministic policy coverage.
   - Cover threshold boundaries, missing choice probabilities or confidence,
     required information, failed validation, and repositories with no
     validation scripts.
   - Decide and test how the `stuck` assessment affects routing.
   - Keep `FINISH` unavailable until validation evidence has passed.
   - Complete when every accepted route and relevant policy override has a
     deterministic test.

5. Finish the CLI contract.
   - Reject unknown flags and add `--version` and machine-readable `--json`
     output while retaining `--mock` and `--no-trace`.
   - Define documented exit codes and label decisions as unexecuted.
   - Complete when people and scripts can consume the same decision reliably.

6. Make traces safe and useful.
   - Add a schema version and a collision-resistant run ID.
   - Bound trace data, redact secrets, omit unneeded raw provider metadata, and
     document trace write failures.
   - Complete when a trace explains a decision without collecting credentials
     or unnecessarily large provider data.

7. Add offline integration coverage and continuous integration.
   - Test inspection, evaluation normalization, CLI output, traces, and failure
     paths with temporary repositories and mocked boundaries.
   - Run `pnpm check`, `pnpm test`, and `pnpm build` in CI without an API key or
     live model request.
   - Complete when the complete offline release gate is automated.

8. Verify live Gateway routing.
   - With `AI_GATEWAY_API_KEY` supplied locally, exercise representative tasks:
     locating code, investigating a bug, ambiguous requirements, and premature
     completion.
   - Review Jev recommendations and policy overrides; capture bounded latency
     and usage observations.
   - Complete when live responses normalize correctly and policy behavior matches
     the documented rules.

9. Prepare the release package.
   - Update the README and package contents.
   - Smoke-test the packaged `jev-agent` executable from another directory.
   - Complete when a local install follows the documented setup and commands.

## Release gate

- `pnpm check`, `pnpm test`, and `pnpm build` pass.
- The documented mock command succeeds without network access or a key.
- A live smoke test succeeds after the user supplies `AI_GATEWAY_API_KEY`.
- The CLI remains decision-only and target-repository inspection remains read-only.
