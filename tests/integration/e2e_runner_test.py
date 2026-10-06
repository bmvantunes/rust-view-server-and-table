"""No Kafka/browser: freeze and cleanup failures must never become full acceptance."""
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from e2e import check_candidate, finalize_acceptance, perform_cleanup, validate_build_mode


class CampaignEvidence(unittest.TestCase):
    def test_full_campaign_cannot_reuse_stale_native_executable(self):
        with self.assertRaisesRegex(ValueError, 'only permitted'):
            validate_build_mode(None, True)
        validate_build_mode(100, True)
        validate_build_mode(None, False)

    def test_any_build_or_campaign_source_change_rejects_full_acceptance(self):
        for phase in ('during native build', 'before web build', 'during web build', 'during browser campaign'):
            with self.subTest(phase=phase), self.assertRaisesRegex(RuntimeError, 'frozen acceptance invalid'):
                check_candidate('before', 'after', None, phase)
        self.assertTrue(check_candidate('same', 'same', None, 'after native build'))
        self.assertFalse(check_candidate('before', 'after', 100, 'during development smoke'))

    def test_cleanup_attempts_every_owned_resource_after_multiple_failures(self):
        attempted = []
        def action(name, fail=False):
            def run():
                attempted.append(name)
                if fail:
                    raise RuntimeError(name + ' failed')
            return run
        failures = perform_cleanup([(name, action(name, name in ('child', 'producer'))) for name in ('child', 'control', 'producer', 'handles', 'broker')])
        self.assertEqual(attempted, ['child', 'control', 'producer', 'handles', 'broker'])
        self.assertEqual([failure['resource'] for failure in failures], ['child', 'producer'])
        result = {'status': 'passed', 'mode': 'full-200000', 'candidateFrozen': True, 'fullCampaignAcceptance': True}
        finalize_acceptance(result, failures)
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(result['fullCampaignAcceptance'])

    def test_only_frozen_full_success_with_successful_cleanup_qualifies(self):
        for mode, frozen, status, expected in [('smoke', True, 'passed', False), ('full-200000', False, 'passed', False), ('full-200000', True, 'failed', False), ('full-200000', True, 'passed', True)]:
            with self.subTest(mode=mode, frozen=frozen, status=status):
                result = {'mode': mode, 'candidateFrozen': frozen, 'status': status}
                finalize_acceptance(result, [])
                self.assertEqual(result['fullCampaignAcceptance'], expected)


if __name__ == '__main__':
    unittest.main()
