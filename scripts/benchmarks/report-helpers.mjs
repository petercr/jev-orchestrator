// Pure receipt parsing. Reporting never authorizes a worker or completion.
export function parseTestSummaries(text) {
  return [...text.matchAll(/^\s*Tests\s+(.+)$/gm)].map((match) => Object.fromEntries(
    [...match[1].matchAll(/(\d+) (passed|failed|skipped|todo)/g)].map((count) => [count[2], Number(count[1])]),
  )).filter((counts) => Object.keys(counts).length);
}

export function parseAcceptance(text) {
  const line = text.split('\n').find((line) => line.startsWith('{"fixtureLength":'));
  return line ? JSON.parse(line) : { passed: false };
}

export function directStatus(worker, receipt) {
  if (worker.cancelled) return 'cancelled';
  if (worker.timedOut) return 'timed_out';
  if (!worker.ok) return 'worker_failed';
  if (receipt.rootChecks.some((check) => check.timedOut)) return 'validation_timed_out';
  if (receipt.rootChecks.some((check) => check.exitCode !== 0 || check.timedOut || check.cancelled || check.outputLimitExceeded || check.spawnFailed)) return 'validation_failed';
  return receipt.acceptedPatch ? 'ready_for_review' : 'acceptance_failed';
}

export function comparisonOutcome(status, checks) {
  if (status === 'iteration_limit') return status;
  if (checks.some((check) => check.timedOut)) return 'validation_timed_out';
  if (checks.some((check) => check.exitCode !== 0 || check.cancelled || check.outputLimitExceeded || check.spawnFailed)) return 'validation_failed';
  return status;
}

export function timingStatistics(values) {
  if (!values.length) return { n: 0, mean: null, median: null, min: null, max: null, sampleStandardDeviation: null };
  if (!values.every((value) => Number.isFinite(value) && value >= 0)) throw new Error('Timings must be finite nonnegative numbers.');
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const middle = Math.floor(values.length / 2);
  let variance = null;
  if (values.length >= 2) {
    if (values.every(Number.isSafeInteger)) {
      // Exact integer sums reproduce Python's rational sample variance without
      // accumulating floating point error in the mean/subtractions.
      const n = BigInt(values.length);
      const sum = values.reduce((total, value) => total + BigInt(value), 0n);
      const squares = values.reduce((total, value) => total + BigInt(value) ** 2n, 0n);
      variance = Number(n * squares - sum ** 2n) / Number(n * (n - 1n));
    } else variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  }
  return {
    n: values.length, mean, median: values.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0], max: sorted.at(-1),
    sampleStandardDeviation: variance === null ? null : Math.sqrt(variance),
  };
}
