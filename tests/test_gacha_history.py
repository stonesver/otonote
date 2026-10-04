"""Synthetic history only; no accounts, SDK configuration or live requests."""
import json
import unittest
from unittest.mock import patch

from tools.gacha_history import extract_history, GachaHistoryClient, HISTORY_METHOD
from tools.growth_export import ExportError
from tools.growth_login import BOOTSTRAP, GameClient, LoginError, SdkIdentity, integer, message


def execution(*prizes, pool=1, timestamp=1791130000):
    return message(2, integer(1, pool) + integer(2, 4) + integer(6, timestamp)
                   + b''.join(message(7, integer(1, p) + integer(2, 1)) for p in prizes))


class HistoryTests(unittest.TestCase):
    def test_execution_records_supersede_legacy_but_keep_real_duplicates(self):
        raw = message(1, integer(1, 51) + integer(2, 1791130000))
        raw += execution(51, 51) * 2
        result = extract_history(raw)
        self.assertEqual(result['coverage']['historyKind'], 'execution')
        self.assertEqual(result['coverage']['legacyOmittedCount'], 1)
        self.assertEqual(len(result['batches']), 2)
        self.assertEqual(result['batches'][0], result['batches'][1])
        self.assertEqual(result['batches'][0]['prizes'], [{'prizeId': 51, 'converted': True}] * 2)

    def test_legacy_has_no_invented_pool_and_zero_timestamp_is_unknown(self):
        result = extract_history(message(1, integer(1, 51)))
        self.assertEqual(result['batches'], [{'poolId': None, 'productId': None,
            'executedAt': None, 'prizes': [{'prizeId': 51, 'converted': False}]}])
        self.assertEqual(result['coverage']['historyKind'], 'legacy')
        self.assertIsNone(result['coverage']['retentionDays'])

    def test_empty_response_and_unknown_only_are_different(self):
        self.assertEqual(extract_history(b'')['batches'], [])
        with self.assertRaisesRegex(ExportError, 'unsupported_history_response'):
            extract_history(message(99, 'unrecognized'))

    def test_rejects_ambiguous_out_of_range_and_malformed_fields(self):
        bad = [integer(2, 1), message(2, integer(1, 1)), execution(0), execution(51, pool=0),
               execution(51, timestamp=2**63),
               message(2, integer(1, 1) + integer(1, 2) + message(7, integer(1, 3))),
               message(2, integer(1, 1) + message(7, integer(1, 3) + integer(2, 2))),
               message(1, message(1, 'not-an-id')), b'\x12\x80']
        for value in bad:
            with self.subTest(value=value), self.assertRaises(ExportError):
                extract_history(value)

    def test_limits_count_nested_prizes_and_batches_before_export(self):
        with patch('tools.gacha_history.MAX_PRIZES', 2), self.assertRaisesRegex(ExportError, 'too_many'):
            extract_history(execution(51, 51, 51))
        with patch('tools.gacha_history.MAX_BATCHES', 1), self.assertRaisesRegex(ExportError, 'too_many'):
            extract_history(execution(51) * 2)

    def test_new_client_only_adds_history_read_and_sends_empty_request(self):
        self.assertEqual(GachaHistoryClient.read_methods - GameClient.read_methods, {HISTORY_METHOD})
        for method in ['app.gacha.GachaService/Execute', 'app.gacha.GachaService/ConvertPoint', HISTORY_METHOD]:
            client = GameClient() if method == HISTORY_METHOD else GachaHistoryClient()
            with self.assertRaisesRegex(LoginError, 'game_target_refused'):
                client.rpc(BOOTSTRAP, method)
        client = GachaHistoryClient()
        with patch.object(client, 'authenticate', return_value=[('auth', 'PRIVATE')]), \
             patch.object(client, 'rpc', return_value=execution(51)) as rpc:
            result = client.export(SdkIdentity('PRIVATE', 'PRIVATE'), 'device', BOOTSTRAP)
        rpc.assert_called_once_with(BOOTSTRAP, HISTORY_METHOD, b'', [('auth', 'PRIVATE')])
        self.assertNotIn('PRIVATE', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
