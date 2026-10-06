"""Kafka-free deterministic seed contract checks."""
import unittest
from seed import record


class SeedTests(unittest.TestCase):
    def test_same_identity_is_topic_isolated_and_revision_stable(self):
        client = record('client_orders', 199999)
        server = record('server_orders', 199999)
        update = record('client_orders', 199999, 1)
        self.assertEqual(client['key'], server['key'])
        self.assertEqual(client['key'], update['key'])
        self.assertNotEqual(client['row']['units'], server['row']['units'])
        self.assertNotEqual(client['row']['units'], update['row']['units'])
        self.assertEqual(client['partition'], update['partition'])

    def test_facets_and_identities_are_distinct(self):
        rows = [record('client_orders', i) for i in range(2048)]
        self.assertEqual(len({v['row']['customer'] for v in rows}), 2048)
        self.assertEqual(len({v['key']['id'] for v in rows}), 2048)
        self.assertEqual({v['partition'] for v in rows}, {0, 1})

    def test_exact_numbers_and_absence_states(self):
        rows = [record('client_orders', i)['row'] for i in range(4)]
        self.assertEqual(rows[0]['units'], '9007199254740993')
        self.assertEqual(rows[0]['price'], '0.00123456789012345678')
        self.assertNotIn('note', rows[0])
        self.assertIsNone(rows[1]['note'])
        self.assertEqual(rows[2]['note'], '')
        self.assertIn('e\u0301', rows[3]['note'])


if __name__ == '__main__':
    unittest.main()
