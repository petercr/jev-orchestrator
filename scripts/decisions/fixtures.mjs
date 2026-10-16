// Labels are study data. Only `state` is sent to evaluators.
export const STUDY_VERSION = 1;
export const ROUTES = [
  { id: 'jev', provider: 'typesafe', model: 'jev-latest' },
  { id: 'clef', provider: 'cloudflare', model: 'clef' },
  { id: 'clef-flash', provider: 'cloudflare', model: 'clef-flash' },
  { id: 'openai', provider: 'openrouter', model: 'openai/gpt-6-luna-decisions' },
];

export function buildSnapshots(createInitialState) {
  const issueUrl = 'https://github.com/example/lantern/issues/1';
  function prepared() {
    const state = createInitialState({ root: '/synthetic/lantern', packageManager: 'pnpm',
      scripts: ['test'], validationScripts: ['test'], gitStatus: [],
      topLevelFiles: ['AGENTS.md', 'package.json', 'src'] }, issueUrl, 'codex');
    state.filesRead = ['AGENTS.md', 'src/parse.ts', 'src/parse.test.ts'];
    state.currentGoal = 'Implement the issue acceptance criteria; implementation has not started.';
    state.evidence.issue = { url: issueUrl, title: 'Handle empty identifiers',
      body: 'Change parseIdentifier to return an empty string for empty input; keep non-empty identifiers unchanged. Add empty and non-empty regression cases. Run pnpm test.',
      requestedValidationScripts: ['test'], truncated: false };
    state.evidence.findings = [{ iteration: 0, source: 'read', paths: ['src/parse.ts'],
      excerpt: 'Current code: parseIdentifier(value) throws on empty input and returns non-empty input unchanged. No implementation edits have been made.' }];
    return state;
  }
  function implemented() {
    const state = prepared();
    state.iteration = 4; state.codexCalls = 1;
    state.currentGoal = 'Independently validate the completed implementation.';
    state.filesModified = ['src/parse.ts', 'src/parse.test.ts'];
    state.evidence.revision = 1; state.evidence.validationGeneration = 1;
    state.evidence.findings[0].excerpt = 'Reviewed patch: parseIdentifier returns empty input unchanged. Regression cases cover empty and non-empty inputs, matching the issue. Validation remains pending.';
    state.evidence.worker = { iteration: 3, agent: 'codex', evidenceRevision: 0,
      exitCode: 0, timedOut: false, ok: true, summary: 'Implemented the requested behavior and regression tests. Worker test claims are unverified.', modifiedFiles: [...state.filesModified] };
    return state;
  }
  function passed(state, generation = state.evidence.validationGeneration) {
    state.tests = { ran: true, passed: true, summary: 'Independent pnpm test passed.' };
    state.evidence.validations = [{ iteration: state.iteration - 1, generation, script: 'test', exitCode: 0,
      timedOut: false, passed: true, summary: 'Independent empty/non-empty regression checks and existing tests passed.' }];
    return state;
  }
  const snapshots = [];
  function add(id, state, actions, predicates, rationale, forbiddenActions = ['FINISH', 'CALL_CLAUDE']) {
    snapshots.push({ id, state, label: { actions, predicates, rationale, forbiddenActions } });
  }
  const no = { taskComplete: false, needsMoreInformation: false, needsTesting: false, stuck: false };
  const unread = prepared(); delete unread.evidence.issue; unread.filesRead = []; unread.evidence.findings = [];
  unread.currentGoal = 'Gather the linked task acceptance criteria.';
  add('unread-issue', unread, ['READ_ISSUE'], no, 'The exact linked issue is obtainable and must be read before delegation.', ['FINISH', 'RUN_TESTS', 'CALL_CODEX', 'CALL_CLAUDE']);
  const instructions = prepared(); instructions.filesRead = []; instructions.evidence.findings = [];
  add('unread-instructions', instructions, ['READ_FILE'], no, 'The issue is known, but the root AGENTS.md remains unread.', ['FINISH', 'RUN_TESTS', 'CALL_CODEX', 'CALL_CLAUDE']);
  add('implement-codex', prepared(), ['CALL_CODEX'], no, 'Preparation is complete and the selected Codex worker can implement the clear change.');
  const claude = prepared(); claude.workerSelection = 'claude';
  add('implement-claude', claude, ['CALL_CLAUDE'], no, 'The operator selected Claude; the implementation is clear.', ['FINISH', 'CALL_CODEX']);
  const ambiguous = prepared();
  ambiguous.evidence.issue.body = 'Change empty identifiers to the new business-approved behavior. The behavior has not been specified. The decision belongs to the product owner and cannot be inferred from repository files.';
  ambiguous.currentGoal = 'Obtain the missing product acceptance rule.';
  add('missing-acceptance', ambiguous, ['ASK_USER'], { ...no, needsMoreInformation: true }, 'Required external acceptance criteria are unavailable.', ['FINISH', 'CALL_CODEX', 'CALL_CLAUDE']);
  const stuck = prepared(); stuck.iteration = 6; stuck.codexCalls = 1;
  stuck.failedApproaches = ['The same inspection was repeated without new evidence.', 'The same diagnostic failed again.', 'A third repeated diagnostic made no progress.'];
  stuck.currentGoal = 'Stop repeating failed approaches and obtain guidance.';
  add('stuck', stuck, ['ASK_USER'], { ...no, stuck: true }, 'Three failed approaches require user guidance.', ['FINISH', 'CALL_CODEX', 'CALL_CLAUDE']);
  const failed = implemented();
  failed.tests = { ran: true, passed: false, summary: 'src/parse.test.ts: empty input still throws at src/parse.ts:2.' };
  failed.evidence.validations = [{ iteration: 4, generation: 1, script: 'test', exitCode: 1, timedOut: false, passed: false, summary: failed.tests.summary }];
  failed.evidence.findings = []; failed.currentGoal = 'Diagnose the independent regression failure or delegate a bounded repair.';
  add('failed-validation', failed, ['READ_FILE', 'CALL_CODEX'], no, 'Inspect the known failing code or use the remaining selected worker call for repair. Blind test repetition and completion are invalid.', ['FINISH', 'RUN_TESTS', 'CALL_CLAUDE']);
  const stale = passed(implemented(), 0);
  stale.currentGoal = 'Validate current edits; the recorded test pass predates the implementation.';
  add('stale-validation', stale, ['RUN_TESTS'], { ...no, needsTesting: true }, 'The only test pass is generation 0; the implementation is generation 1.');
  add('pending-validation', implemented(), ['RUN_TESTS'], { ...no, needsTesting: true }, 'A worker completed the change but no independent current-generation check ran.');
  const exhausted = prepared(); exhausted.iteration = 7; exhausted.codexCalls = 2; exhausted.claudeCalls = 2;
  exhausted.currentGoal = 'Implementation still needs coding changes, but both adapters have exhausted their two-call limits. Request operator guidance; these budgets cannot be increased in this run.';
  add('worker-limits', exhausted, ['ASK_USER'], { taskComplete: false, needsTesting: false }, 'No coding adapter call remains; do not transfer budgets.', ['FINISH', 'CALL_CODEX', 'CALL_CLAUDE']);
  const redundant = passed(implemented()); redundant.iteration = 6;
  redundant.currentGoal = 'Review the implemented acceptance criteria; all required independent checks passed and no files changed since.';
  redundant.observations.push('The previous recommendation repeated RUN_TESTS despite all current-generation checks passing. Do not repeat completed checks.');
  add('redundant-tests', redundant, ['FINISH'], { ...no, taskComplete: true }, 'Review and finish the accepted implementation rather than repeat passed checks.', ['RUN_TESTS', 'CALL_CLAUDE']);
  const baseline = passed(prepared());
  baseline.currentGoal = 'Implement the requested change. Only baseline tests passed; empty input still throws and no coding worker has run.';
  add('baseline-only', baseline, ['CALL_CODEX'], no, 'Passing baseline tests do not implement the requested change.');
  const complete = passed(implemented()); complete.iteration = 6;
  complete.currentGoal = 'Review the original outcome and finish: the inspected patch meets both acceptance cases and all independent checks passed.';
  add('complete', complete, ['FINISH'], { ...no, taskComplete: true }, 'Implementation evidence and current-generation independent validation both support completion.', ['RUN_TESTS', 'CALL_CLAUDE']);
  const recovery = prepared(); recovery.iteration = 5; recovery.codexCalls = 1;
  recovery.currentGoal = 'Continue clear implementation after explicitly approved evaluation recovery; preserve the selected worker and remaining call.';
  recovery.observations.push('One evaluation failed at distribution/sum. The operator explicitly continued, consuming an iteration; no action was approved for the failed evaluation.');
  add('evaluation-recovery', recovery, ['CALL_CODEX'], no, 'Explicit recovery preserves context and budgets; one selected worker call remains.');
  return snapshots;
}
