import unittest
from report_helpers import comparison_outcome, direct_status, parse_acceptance, parse_test_summaries, timing_statistics

class ReceiptTests(unittest.TestCase):
    def test_complete_logs_include_failed_and_pending_tests(self):
        result = parse_test_summaries(' Tests 88 passed (88)\n Tests 1 failed | 641 passed | 2 skipped (644)\n')
        self.assertEqual(result, [{'passed': 88}, {'failed': 1, 'passed': 641, 'skipped': 2}])

    def test_node_warning_does_not_replace_the_probe_result(self):
        self.assertEqual(parse_acceptance('{"fixtureLength":56,"passed":true}\n(node:1) Warning: module type\n')['passed'], True)
        self.assertEqual(parse_acceptance('Warning only\n'), {'passed': False})

    def test_worker_success_does_not_hide_independent_validation_failure(self):
        receipt = {'acceptedPatch': False, 'rootChecks': [{'exitCode': 1, 'timedOut': False}]}
        self.assertEqual(direct_status({'ok': True}, receipt), 'validation_failed')
        self.assertEqual(direct_status({'ok': False, 'cancelled': True}, receipt), 'cancelled')
        self.assertEqual(direct_status({'ok': False, 'timedOut': True}, receipt), 'timed_out')
        self.assertEqual(comparison_outcome('stopped', receipt['rootChecks']), 'validation_failed')
        self.assertEqual(comparison_outcome('iteration_limit', [{'exitCode': 0, 'timedOut': False}]), 'iteration_limit')

    def test_statistics_preserve_sample_counts_and_absent_samples(self):
        result = timing_statistics([10, 20, 60])
        self.assertEqual(result['n'], 3)
        self.assertEqual(result['mean'], 30)
        self.assertEqual(result['median'], 20)
        self.assertEqual((result['min'], result['max']), (10, 60))
        self.assertEqual(timing_statistics([])['mean'], None)

if __name__ == '__main__': unittest.main()
