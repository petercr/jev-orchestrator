export function schedule(snapshots, routes, repetitions) {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) throw new Error('Repetitions must be 1–3.');
  return Array.from({ length: repetitions }, (_, repetition) => snapshots.flatMap((snapshot, index) =>
    routes.map((_, offset) => ({ snapshotId: snapshot.id, routeId: routes[(offset + index + repetition) % routes.length].id, repetition: repetition + 1 })))).flat();
}

export function grade(snapshot, result, policy, guardedAction, actions) {
  const assessment = result.assessment;
  const choice = assessment.nextAction.choice;
  const correct = snapshot.label.actions.includes(choice);
  return {
    rawCorrect: correct, policyCorrect: snapshot.label.actions.includes(policy.selected),
    guardedCorrect: snapshot.label.actions.includes(guardedAction),
    forbiddenRecommendation: snapshot.label.forbiddenActions.includes(choice),
    forbiddenPolicy: snapshot.label.forbiddenActions.includes(policy.selected),
    forbiddenGuarded: snapshot.label.forbiddenActions.includes(guardedAction),
    override: policy.override, candidateOverride: guardedAction !== policy.selected,
    abstention: guardedAction === 'ASK_USER', avoidableAbstention: guardedAction === 'ASK_USER' && !snapshot.label.actions.includes('ASK_USER'),
    completionReview: policy.completionReview ?? null,
    actionBrier: snapshot.label.actions.length === 1
      ? actions.reduce((sum, action) => sum + ((assessment.nextAction.probabilities[action] ?? 0) - Number(action === snapshot.label.actions[0])) ** 2, 0) : null,
    predicateScores: Object.entries(snapshot.label.predicates).map(([field, expected]) => ({ field, expected,
      probability: assessment[field].probability, squaredError: (assessment[field].probability - Number(expected)) ** 2 })),
    topProbability: assessment.nextAction.probabilities[choice], confidence: assessment.nextAction.confidence ?? null,
  };
}

export function statistics(values) {
  if (!values.length) return { n: 0, mean: null, p50: null, p90: null, p95: null, min: null, max: null };
  if (!values.every((value) => Number.isFinite(value) && value >= 0)) throw new Error('Invalid statistic input.');
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { n: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: percentile(0.5), p90: percentile(0.9), p95: percentile(0.95), min: sorted[0], max: sorted.at(-1) };
}

export function reliability(pairs) {
  const bins = Array.from({ length: 5 }, (_, index) => ({ lower: index / 5, upper: (index + 1) / 5, n: 0, sum: 0, correct: 0 }));
  for (const [probability, correct] of pairs) {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Invalid reliability input.');
    const bin = bins[Math.min(4, Math.floor(probability * 5))];
    bin.n += 1; bin.sum += probability; bin.correct += Number(correct);
  }
  const rows = bins.map((bin) => ({ lower: bin.lower, upper: bin.upper, n: bin.n,
    mean: bin.n ? bin.sum / bin.n : null, accuracy: bin.n ? bin.correct / bin.n : null }));
  return { n: pairs.length, expectedCalibrationError: pairs.length
    ? rows.reduce((total, bin) => total + (bin.n ? bin.n * Math.abs(bin.mean - bin.accuracy) : 0), 0) / pairs.length : null, bins: rows };
}

// Only allowlisted numeric fields survive instrumentation. No body or error text.
export function reportedUsage(body) {
  const usage = body?.result?.usage ?? body?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const output = {};
  for (const [field, aliases] of Object.entries({ inputTokens: ['input_tokens', 'prompt_tokens'], outputTokens: ['output_tokens', 'completion_tokens'], totalTokens: ['total_tokens'] })) {
    for (const alias of aliases) {
      if (Number.isSafeInteger(usage[alias]) && usage[alias] >= 0) { output[field] = usage[alias]; break; }
    }
  }
  return Object.keys(output).length ? output : null;
}

export function summarize(rows, routes, planned) {
  return { planned, attempted: rows.length, unstarted: planned - rows.length, models: routes.map((route) => {
    const all = rows.filter((row) => row.routeId === route.id);
    const valid = all.filter((row) => row.outcome === 'normalized');
    const count = (field) => valid.filter((row) => row.grade[field]).length;
    const predicates = [...new Set(valid.flatMap((row) => row.grade.predicateScores.map((score) => score.field)))];
    return { ...route, attempted: all.length, normalized: valid.length, failed: all.length - valid.length,
      servedModels: [...new Set(valid.map((row) => row.servedModel).filter(Boolean))],
      rawCorrect: count('rawCorrect'), policyCorrect: count('policyCorrect'), guardedCorrect: count('guardedCorrect'),
      refusals: all.filter((row) => row.attempts.some((attempt) => attempt.refusal)).length,
      forbiddenRecommendations: count('forbiddenRecommendation'), forbiddenPolicy: count('forbiddenPolicy'), forbiddenGuarded: count('forbiddenGuarded'),
      overrides: count('override'), candidateOverrides: count('candidateOverride'), abstentions: count('abstention'), avoidableAbstentions: count('avoidableAbstention'),
      completionReviews: valid.filter((row) => row.grade.completionReview !== null).length,
      failures: Object.fromEntries([...new Set(all.filter((row) => row.failure).map((row) => row.failure.code))].map((code) => [code, all.filter((row) => row.failure?.code === code).length])),
      latencyMs: statistics(all.map((row) => row.durationMs)), normalizedLatencyMs: statistics(valid.map((row) => row.durationMs)),
      actionBrier: statistics(valid.map((row) => row.grade.actionBrier).filter((value) => value !== null)),
      predicates: Object.fromEntries(predicates.map((field) => [field, statistics(valid.flatMap((row) => row.grade.predicateScores.filter((score) => score.field === field).map((score) => score.squaredError)))])),
      topProbabilityReliability: reliability(valid.map((row) => [row.grade.topProbability, row.grade.rawCorrect])),
      confidenceReliability: reliability(valid.filter((row) => row.grade.confidence !== null).map((row) => [row.grade.confidence, row.grade.rawCorrect])),
      usage: Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens'].map((field) => {
        const values = all.flatMap((row) => row.attempts.map((attempt) => attempt.usage?.[field]).filter((value) => value !== undefined));
        return [field, { responses: values.length, sum: values.length ? values.reduce((a, b) => a + b, 0) : null }];
      })),
      httpAttempts: all.reduce((sum, row) => sum + row.attempts.length, 0),
      snapshots: [...new Set(all.map((row) => row.snapshotId))].map((snapshotId) => {
        const items = all.filter((row) => row.snapshotId === snapshotId);
        return { snapshotId, n: items.length, normalized: items.filter((row) => row.outcome === 'normalized').length,
          rawCorrect: items.filter((row) => row.grade?.rawCorrect).length, guardedCorrect: items.filter((row) => row.grade?.guardedCorrect).length,
          requests: items.map((row) => row.requestedAction ?? row.failure?.code ?? row.outcome),
          guarded: items.map((row) => row.guardedAction ?? row.outcome), latencyMs: statistics(items.map((row) => row.durationMs)) };
      }),
    };
  }) };
}
