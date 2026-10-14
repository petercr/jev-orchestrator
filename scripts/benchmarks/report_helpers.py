"""Pure receipt parsing. Reporting never authorizes a worker or completion."""
import json
import re
import statistics

def parse_test_summaries(text):
    summaries = []
    for line in re.findall(r'^\s*Tests\s+(.+)$', text, re.MULTILINE):
        counts = {status: int(count) for count, status in re.findall(r'(\d+) (passed|failed|skipped|todo)', line)}
        if counts: summaries.append(counts)
    return summaries

def parse_acceptance(text):
    for line in text.splitlines():
        if line.startswith('{"fixtureLength":'):
            return json.loads(line)
    return {'passed': False}

def direct_status(worker, receipt):
    if worker.get('cancelled'): return 'cancelled'
    if worker.get('timedOut'): return 'timed_out'
    if not worker['ok']: return 'worker_failed'
    if any(check['timedOut'] for check in receipt['rootChecks']): return 'validation_timed_out'
    if any(check['exitCode'] != 0 or check['timedOut'] for check in receipt['rootChecks']): return 'validation_failed'
    return 'ready_for_review' if receipt['acceptedPatch'] else 'acceptance_failed'

def comparison_outcome(status, checks):
    if status == 'iteration_limit': return status
    if any(check['timedOut'] for check in checks): return 'validation_timed_out'
    if any(check['exitCode'] != 0 for check in checks): return 'validation_failed'
    return status

def timing_statistics(values):
    if not values: return {'n': 0, 'mean': None, 'median': None, 'min': None, 'max': None, 'sampleStandardDeviation': None}
    return {'n': len(values), 'mean': statistics.mean(values), 'median': statistics.median(values), 'min': min(values), 'max': max(values), 'sampleStandardDeviation': statistics.stdev(values) if len(values) >= 2 else None}
