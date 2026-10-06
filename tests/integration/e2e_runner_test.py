"""No Kafka/browser: freeze and cleanup failures must never become full acceptance."""
from pathlib import Path
import sys
import unittest
from copy import deepcopy
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from e2e import native_caught_up, check_candidate, finalize_acceptance, perform_cleanup, validate_build_mode


class CampaignEvidence(unittest.TestCase):
    def test_native_catchup_requires_exact_counts_and_every_acknowledged_cut(self):
        expected = {topic: {'count': 200000, 'sourceNext': {0: 100199, 1: 100199}} for topic in ('client_orders', 'server_orders')}
        health = {'ready': True, 'authority_safe': True, 'sources': [{'topic': topic, 'retention': {'active_payload_rows': 200000, 'safe': True, 'pending_due': False}, 'partitions': [{'partition': partition, 'assigned': True, 'bootstrap_complete': True, 'durable_next': '100199', 'derived_next': '100199', 'serving_next': '100200', 'fetched_next': '100999'} for partition in (0, 1)]} for topic in expected]}
        self.assertTrue(native_caught_up(health, expected))
        serialized_expected = {topic: {**value, 'sourceNext': {str(partition): cut for partition, cut in value['sourceNext'].items()}} for topic, value in expected.items()}
        self.assertTrue(native_caught_up(health, serialized_expected))
        for field in ('durable_next', 'derived_next', 'serving_next'):
            stale = deepcopy(health)
            stale['sources'][1]['partitions'][1][field] = '100198'
            self.assertFalse(native_caught_up(stale, expected), field + ' cannot be replaced by fetched progress')
            stale['sources'][1]['partitions'][1][field] = None
            self.assertFalse(native_caught_up(stale, expected), field + ' null is not ready')
        for modification in ('count', 'ready', 'safe', 'pending', 'missing', 'bootstrap'):
            stale = deepcopy(health)
            if modification == 'count': stale['sources'][0]['retention']['active_payload_rows'] -= 1
            elif modification == 'ready': stale['ready'] = False
            elif modification == 'safe': stale['sources'][1]['retention']['safe'] = False
            elif modification == 'pending': stale['sources'][1]['retention']['pending_due'] = True
            elif modification == 'missing': stale['sources'][1]['partitions'].pop()
            elif modification == 'bootstrap': stale['sources'][0]['partitions'][0]['bootstrap_complete'] = False
            self.assertFalse(native_caught_up(stale, expected), modification)

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
