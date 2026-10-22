# Offline terminal verification

This optional harness drives the compiled or installed CLI in a real POSIX PTY
or Windows ConPTY. It does not call live models or coding agents. Its native
test dependencies have a separate manifest and lockfile; ordinary development
and the published package do not install them.

```bash
pnpm --dir scripts/terminal install --frozen-lockfile
pnpm build
pnpm verify:terminal --output /absolute/new/evidence-directory
```

Use a new output directory outside the repository. On Windows, supply an
absolute Windows path, for example `C:/Temp/dev-ui-check`. The directory retains
fixtures, traces, application bytes, PTY bytes, reconstructed screens, and a
JSON report even after failure. Each scenario has a 30-second deadline and a
2 MiB output bound. `--only styled-40` selects one scenario for diagnosis.

To check an independently installed checkout archive, use:

```bash
pnpm verify:terminal --cli /absolute/consumer/node_modules/dev-orchestrator/dist/cli.js --output /absolute/new/packed-evidence
```

The CLI path is resolved through package-manager symlinks. The
[terminal CI workflow](../../.github/workflows/terminal.yml) builds, packs,
installs a private consumer, and runs both variants on Ubuntu and Windows with
Node 22. Its artifacts retain both reports and captures for seven days. It
does not publish an npm package.

## Boundaries and assertions

The harness starts disposable Git repositories with long paths, spaces, and
Unicode. It intercepts only the fixed TypeSafe endpoint and the worker/check
process boundaries. Requested Codex, Claude, and `npm run test` processes
become local Node fixtures. Read-only Git inspection, the real process runner,
policy, candidate selection, approvals, independent check transitions, and
trace writing remain real. Child environments contain a small OS allowlist
and a synthetic credential. Production credentials and local value files are
not loaded. Timeout cases shorten the existing 15-minute timer to 150 ms at
the test clock boundary; this does not change the production deadline.

The 33 scenarios per platform cover 40/60/80/120 columns, both adapters,
explicit networking, plain/non-TTY/CI/`NO_COLOR`/`TERM=dumb`, repair, recovery,
invalid input, budgets, prompt EOF/timeout/signals, alternative confirmation,
active execution and evaluation cancellation, and typed stop/quit. POSIX tests
include active SIGTERM and a TERM-resistant descendant. Windows substitutes an
extra plain Ctrl+D/Enter case; plain Ctrl+Z/Enter is also checked. Both modes
preserve separate completion acceptance and fresh independent checks.

`@xterm/headless` reconstructs the screen, including cursor movement and
wrapping. Checks compare the candidate parameters retained by the trace with
the rendered review, with trace depth truncation treated as unavailable data.
Initial worker and validation parameters are compared in full. Application
output is captured before ConPTY encoding: ConPTY itself can emit VT frames
even when the application is completely plain. Additional checks cover signal
listeners, raw input/cursor restoration, POSIX terminal flags, partial edits,
process exit, validation generations, budgets, credential redaction, terminal
injection, schema-v2 traces, and schema-v1 JSON/traces with and without
`--plain`.

The driver pins [node-pty 1.1.0](https://github.com/microsoft/node-pty/tree/v1.1.0)
and [xterm headless 6.0.0](https://github.com/xtermjs/xterm.js).
Only node-pty's exact build is allowed in this isolated pnpm workspace; Linux
needs Python, make, and a C++ compiler. Windows uses its packaged native
bindings and bundled ConPTY. An isolated, asserted cleanup shim disposes the
driver's retained ConPTY worker after the CLI has exited, avoiding the
[upstream natural-exit leak](https://github.com/microsoft/node-pty/issues/965).
Review that shim when upgrading the pinned driver. It is absent from the
production CLI and does not establish application cleanup on its behalf.

These checks establish terminal presentation and enforcement with synthetic
boundaries. They do not establish live model quality, native worker/package
manager launcher availability, screen-reader certification, or GUI font
appearance.
