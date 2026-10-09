import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from backend.player_rankings import query_player_rankings, validate_observation
from tools.import_player_rankings import (ensure_final_archive_metadata, publish,
                                          publish_final_observation)


class PlayerRankingTests(unittest.TestCase):
    def snapshot(self, server="jp"):
        return {"schemaVersion": 1, "serverId": server, "observedAt": "2026-09-30T00:00:00Z", "expiresAt": "2026-09-30T01:00:00Z", "boards": [
            {"eventId": "event-1", "eventName": "Example", "type": "event-points", "entries": [
                {"playerId": str(i), "name": "Player", "rank": i, "score": 100 - i} for i in (1, 2, 3)]}]}

    def test_independent_servers_and_expired_data(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); source = root / "input.json"
            source.write_text(json.dumps(self.snapshot())); target = publish(source, root, "jp")
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)
            self.assertEqual(query_player_rankings(root, server="global-en")["status"], "unavailable")
            result = query_player_rankings(root, server="jp", now=datetime(2026, 9, 30, 2, tzinfo=timezone.utc))
            self.assertEqual(result["status"], "stale")
            self.assertEqual(result["entries"][0]["playerKey"], "jp:1")

    def test_cursor_cannot_cross_server_event_or_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); source = root / "input.json"
            for server in ("jp", "global-en"):
                source.write_text(json.dumps(self.snapshot(server))); publish(source, root, server)
            first = query_player_rankings(root, server="jp", limit=1)
            second = query_player_rankings(root, server="jp", limit=1, cursor=first["nextCursor"])
            self.assertEqual(second["entries"][0]["rank"], 2)
            with self.assertRaises(ValueError):
                query_player_rankings(root, server="global-en", cursor=first["nextCursor"])
            data = self.snapshot(); data["boards"][0]["entries"][0]["score"] = 200
            source.write_text(json.dumps(data)); publish(source, root, "jp")
            with self.assertRaises(ValueError):
                query_player_rankings(root, server="jp", cursor=first["nextCursor"])

    def test_wrong_identity_and_duplicate_players_rejected(self):
        with self.assertRaises(ValueError): validate_observation(self.snapshot(), "global-kr")
        data = self.snapshot(); data["boards"][0]["entries"].append(data["boards"][0]["entries"][0])
        with self.assertRaises(ValueError): validate_observation(data, "jp")

    def test_empty_success_is_distinct_from_missing_board(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); source = root / "input.json"; data = self.snapshot()
            data["boards"][0]["entries"] = []; source.write_text(json.dumps(data)); publish(source, root, "jp")
            self.assertEqual(query_player_rankings(root, server="jp", now=datetime(2026, 9, 30, 0, 5, tzinfo=timezone.utc))["status"], "empty")
            self.assertEqual(query_player_rankings(root, server="jp", board="music")["status"], "unavailable")

    def test_http_route_is_server_scoped_and_not_cached(self):
        from fastapi.testclient import TestClient
        from tests.test_query_http import _make_config, _build_app
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = _make_config(root)
            source = root / "input.json"
            source.write_text(json.dumps(self.snapshot()))
            publish(source, config.data_root / "observations", "jp")
            with TestClient(_build_app(config)) as client:
                result = client.get("/api/v1/player-rankings?server=jp&limit=1")
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.headers["cache-control"], "no-store")
                self.assertEqual(result.json()["entries"][0]["playerKey"], "jp:1")
                self.assertEqual(client.get("/api/v1/player-rankings?server=global-hmt").json()["entries"], [])
                self.assertEqual(client.get("/api/v1/player-rankings?server=global").status_code, 400)
                self.assertEqual(client.get("/api/v1/player-rankings?server=jp&cursor=broken").status_code, 400)

    def test_final_archive_is_immutable_and_does_not_replace_current(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            older = self.snapshot('global-hmt')
            older['boards'][0]['eventId'] = '1'
            older['observedAt'] = '2026-10-09T16:00:00Z'
            older['expiresAt'] = '2026-10-09T16:15:00Z'
            current = self.snapshot('global-hmt')
            current['boards'][0]['eventId'] = '2'
            source = root / 'input.json'; source.write_text(json.dumps(current))
            current_path = publish(source, root, 'global-hmt')
            before = current_path.read_bytes()
            final_path = publish_final_observation(older, root, 'global-hmt')
            final_bytes = final_path.read_bytes()
            self.assertEqual(current_path.read_bytes(), before)
            self.assertEqual(final_path.stat().st_mode & 0o777, 0o644)
            self.assertEqual(final_path.parent.stat().st_mode & 0o777, 0o755)
            self.assertTrue(final_path.with_suffix('.meta.json').exists())
            changed = json.loads(json.dumps(older))
            changed['boards'][0]['entries'][0]['score'] = 999
            self.assertEqual(publish_final_observation(changed, root, 'global-hmt'), final_path)
            self.assertEqual(final_path.read_bytes(), final_bytes)
            live = query_player_rankings(root, server='global-hmt', now=datetime(2026, 10, 10, tzinfo=timezone.utc))
            self.assertEqual(live['eventId'], '2')
            self.assertEqual([item['id'] for item in live['events']], ['2', '1'])
            self.assertIn('结束后归档', live['events'][1]['name'])
            final = query_player_rankings(root, server='global-hmt', event='1', limit=1,
                                          now=datetime(2026, 10, 10, tzinfo=timezone.utc))
            self.assertEqual(final['eventId'], '1')
            self.assertTrue(final['isFinal'])
            self.assertEqual(final['status'], 'stale')
            self.assertEqual(final['totalEntries'], 3)
            with self.assertRaises(ValueError):
                query_player_rankings(root, server='global-hmt', event='2', cursor=final['nextCursor'])
            final_path.write_bytes(final_bytes + b' ')
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                query_player_rankings(root, server='global-hmt', event='1')

    def test_archive_metadata_can_be_repaired_without_recapture(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            value = self.snapshot('global-hmt')
            value['boards'][0]['eventId'] = '1'
            path = publish_final_observation(value, root, 'global-hmt')
            sidecar = path.with_suffix('.meta.json')
            sidecar.unlink()
            self.assertTrue(ensure_final_archive_metadata(root, 'global-hmt', '1'))
            self.assertTrue(sidecar.exists())
            self.assertFalse(ensure_final_archive_metadata(root, 'global-hmt', '2'))
            self.assertEqual(query_player_rankings(root, server='global-hmt')['eventId'], '1')
            self.assertFalse(query_player_rankings(root, server='global-en')['events'])
            with self.assertRaises(ValueError):
                ensure_final_archive_metadata(root, 'global-hmt', '../1')

    def test_empty_final_board_can_be_archived(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            value = self.snapshot('global-hmt')
            value['boards'][0]['eventId'] = '1'
            value['boards'][0]['entries'] = []
            publish_final_observation(value, root, 'global-hmt')
            result = query_player_rankings(root, server='global-hmt', event='1')
            self.assertTrue(result['isFinal'])
            self.assertEqual(result['totalEntries'], 0)


if __name__ == "__main__": unittest.main()
