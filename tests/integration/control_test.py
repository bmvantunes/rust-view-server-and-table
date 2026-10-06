"""Kafka-free tests of optimistic save admission, write fencing and local HTTP boundary."""
import http.client
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import control
from seed import record


def fixture():
    producer = control.Producer.__new__(control.Producer)
    producer.lock = threading.RLock()
    producer.rows = {topic: {} for topic in control.TOPICS}
    producer.cuts = {topic: {0: 0, 1: 0} for topic in control.TOPICS}
    producer.counts = {topic: 0 for topic in control.TOPICS}
    producer.failed = False
    for index in (0, 1):
        producer.rows['client_orders'][f'key-{index}'] = record('client_orders', index)['row']
    return producer


def change(producer, index):
    before = producer.rows['client_orders'][f'key-{index}']
    return {'rowId': f'key-{index}', 'orderId': before['orderId'], 'expected': dict(before),
            'row': {**before, 'customer': 'edited'}}


class ControlAdmission(unittest.TestCase):
    def test_expected_snapshot_retains_initial_cuts_after_later_commit(self):
        producer = fixture()
        before = producer.expected()
        row = record('client_orders', 0, revision=1)
        producer._apply([row], [{'ack': row['ack'], 'topic': row['topic'], 'partition': 0, 'offset': 7, 'key': 'key-0'}])
        self.assertEqual(before['client_orders']['sourceNext'][0], 0)
        self.assertEqual(producer.expected()['client_orders']['sourceNext'][0], 8)
        self.assertNotEqual(before['client_orders']['sha256'], producer.expected()['client_orders']['sha256'])

    def test_entire_batch_cas_precedes_any_publish(self):
        producer = fixture()
        producer.publish = Mock()
        changes = [change(producer, 0), change(producer, 1)]
        changes[1]['expected']['units'] = '17'
        with self.assertRaises(control.Conflict):
            producer.save({'topic': 'client_orders', 'changes': changes})
        producer.publish.assert_not_called()

    def test_save_keeps_generated_key_partition_and_exact_wire_values(self):
        producer = fixture()
        producer.publish = Mock(return_value=[{'offset': 8}])
        value = change(producer, 1)
        self.assertEqual(producer.save({'topic': 'client_orders', 'changes': [value]}), [{'offset': 8}])
        emitted = producer.publish.call_args.args[0][0]
        self.assertEqual(emitted['key'], {'id': 'order-000001'})
        self.assertEqual(emitted['partition'], 1)
        self.assertEqual(emitted['row']['units'], '9007199254740994')
        self.assertEqual(emitted['row']['price'], '1.01123456789012345678')
        self.assertIsNone(emitted['row']['note'])

    def test_identity_change_and_duplicate_change_are_rejected(self):
        for mode in ('identity', 'duplicate'):
            producer = fixture()
            producer.publish = Mock()
            value = change(producer, 0)
            values = [value]
            if mode == 'identity':
                value['row']['orderId'] = 'order-000005'
            else:
                values.append(value)
            with self.assertRaises(ValueError):
                producer.save({'topic': 'client_orders', 'changes': values})
            producer.publish.assert_not_called()

    def test_ambiguous_commit_fences_later_writes_and_retains_intent(self):
        producer = fixture()
        producer.process = Mock(stdin=io.StringIO())
        with tempfile.TemporaryFile(mode='w+') as journal:
            producer.receipts = journal
            with patch.object(control, 'read_line', side_effect=RuntimeError('receipt lost')):
                with self.assertRaisesRegex(RuntimeError, 'receipt lost'):
                    producer.publish([record('client_orders', 0)])
            self.assertTrue(producer.failed)
            first_sent = producer.process.stdin.getvalue()
            with self.assertRaisesRegex(RuntimeError, 'fenced'):
                producer.publish([record('client_orders', 1)])
            self.assertEqual(producer.process.stdin.getvalue(), first_sent)
            journal.seek(0)
            entries = [json.loads(line) for line in journal]
            self.assertEqual([entry['phase'] for entry in entries], ['prepared'])


class ControlHTTP(unittest.TestCase):
    def setUp(self):
        self.producer = fixture()
        self.producer.publish = Mock(return_value=[])
        self.server = control.serve(self.producer, port=0, origin='http://127.0.0.1:31337', token='test-secret', run='test-owned')
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def request(self, payload, *, origin='http://127.0.0.1:31337', token='test-secret', path='/save', extra=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        headers = {'Origin': origin, 'X-RVS-Token': token, 'Content-Type': 'application/json', **(extra or {})}
        connection.request('POST', path, json.dumps(payload), headers)
        response = connection.getresponse()
        status = response.status
        response.read()
        connection.close()
        return status

    def test_bad_origin_or_token_never_reaches_producer(self):
        payload = {'topic': 'client_orders', 'changes': [change(self.producer, 0)]}
        self.assertEqual(self.request(payload, origin='https://unowned.invalid'), 403)
        self.assertEqual(self.request(payload, token='wrong'), 403)
        self.producer.publish.assert_not_called()

    def test_oversized_payload_and_unowned_topic_are_rejected(self):
        self.assertEqual(self.request({}, extra={'Content-Length': str(1024 * 1024 + 1)}), 400)
        self.assertEqual(self.request({'topic': 'other', 'index': 0}, path='/update'), 400)
        self.producer.publish.assert_not_called()

    def test_conflict_is_409_and_reset_requires_exact_run(self):
        value = change(self.producer, 0)
        value['expected']['customer'] = 'stale'
        self.assertEqual(self.request({'topic': 'client_orders', 'changes': [value]}), 409)
        self.assertEqual(self.request({'confirmRun': 'other'}, path='/reset'), 400)
        self.producer.publish.assert_not_called()

    def test_public_seed_path_updates_journal_authority_before_optimistic_save(self):
        import seed
        old = change(self.producer, 0)
        def publish(records):
            receipts = [{'ack': row['ack'], 'topic': row['topic'], 'partition': row['partition'],
                         'offset': 100 + index, 'key': 'key-' + str(int(row['key']['id'][6:]))}
                        for index, row in enumerate(records)]
            self.producer._apply(records, receipts)
            return receipts
        self.producer.publish = Mock(side_effect=publish)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / '.local/runs/test-owned/cluster'
            directory.mkdir(parents=True)
            (directory / 'control.json').write_text(json.dumps({'url': f'http://127.0.0.1:{self.port}', 'origin': 'http://127.0.0.1:31337', 'run': 'test-owned'}))
            (directory / 'session-token').write_text('test-secret')
            with patch.object(seed, 'ROOT', root), patch('kafka.read_state', return_value={'clusterId': 'cluster'}), patch('builtins.print'):
                seed.seed('test-owned', 1, start=0, revision=2)
        self.assertEqual(self.request({'topic': 'client_orders', 'changes': [old]}), 409)
        self.assertEqual(self.request({'topic': 'client_orders', 'changes': [change(self.producer, 0)]}), 200)

    def test_success_returns_only_after_producer_ack(self):
        self.assertEqual(self.request({'topic': 'client_orders', 'changes': [change(self.producer, 0)]}), 200)
        self.producer.publish.assert_called_once()

class ControlLifecycle(unittest.TestCase):
    def test_startup_timeout_closes_child_handles_and_releases_owner_lock(self):
        import fcntl
        process = Mock()
        process.poll.return_value = None
        process.stdin = io.StringIO()
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            config = directory / 'service.json'
            config.write_text('{}')
            with patch.object(control.subprocess, 'Popen', return_value=process), patch.object(control, 'read_line', side_effect=RuntimeError('startup receipt timeout')):
                with self.assertRaisesRegex(RuntimeError, 'startup receipt timeout'):
                    control.Producer(config, directory)
            self.assertTrue(process.stdin.closed)
            process.wait.assert_called_once_with(timeout=20)
            with config.with_suffix('.control.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_uncertain_replay_closes_handles_without_starting_child(self):
        import fcntl
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            config = directory / 'service.json'
            config.write_text('{}')
            (directory / 'producer-receipts.ndjson').write_text(json.dumps({'phase': 'prepared', 'records': [record('client_orders', 0)]}) + '\n')
            with patch.object(control.subprocess, 'Popen') as spawn:
                with self.assertRaisesRegex(RuntimeError, 'uncertain'):
                    control.Producer(config, directory)
                spawn.assert_not_called()
            with config.with_suffix('.control.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)


if __name__ == '__main__':
    unittest.main()
