"""Tests for anonymous ranking insights aggregation and API privacy boundaries."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from backend.ranking_insights import generate_all_insights, query_ranking_insights


def _deck(mids: list[int], sids: list[int], *, power: int = 250000, mrank: int = 5, srank: int = 5, lsl: int = 5, psl: int = 5) -> dict:
    return {
        "totalPower": power,
        "cards": [
            {
                "slot": i,
                "performanceOrder": i,
                "member": {
                    "masterId": mids[i],
                    "exp": 1000,
                    "rank": mrank,
                    "awake": 5,
                    "liveSkillLevel": lsl,
                    "performanceSkillLevel": psl,
                },
                "support": {
                    "masterId": sids[i],
                    "exp": 1000,
                    "rank": srank,
                },
            }
            for i in range(5)
        ],
    }


def _write_arena(root: Path, server: str, season: str, band: str, entries: list[dict]) -> None:
    path = root / server / "arena" / f"season-{season}" / f"band-{band}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": 1,
        "serverId": server,
        "seasonId": season,
        "bandId": band,
        "observedAt": "2026-11-20T00:00:00+00:00",
        "expiresAt": "2026-11-20T00:30:00+00:00",
        "source": {
            "method": "app.arena.ArenaService/ArenaRanking",
            "clientVersion": "1.1.0",
            "contentReleaseId": "global-1.1.0-86",
            "projectionSha256": "a" * 64,
        },
        "coverage": {"startRank": 1, "endRank": 1000},
        "maxRank": 12000,
        "entries": entries,
    }
    path.write_text(json.dumps(payload), encoding="utf-8")


def _write_event_archive(root: Path, server: str, event_id: str, boards: list[dict]) -> None:
    folder = root / server / "archive"
    folder.mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": 1,
        "serverId": server,
        "observedAt": "2026-11-20T00:00:00+00:00",
        "expiresAt": "2026-11-20T01:00:00+00:00",
        "boards": boards,
    }
    raw = json.dumps(payload).encode("utf-8")
    (folder / f"event-{event_id}-post-end.json").write_bytes(raw)
    meta = {
        "schemaVersion": 1,
        "eventId": event_id,
        "eventName": "Test Event",
        "observedAt": payload["observedAt"],
        "sha256": hashlib.sha256(raw).hexdigest(),
    }
    (folder / f"event-{event_id}-post-end.meta.json").write_text(json.dumps(meta), encoding="utf-8")


class RankingInsightsTest(unittest.TestCase):
    def test_arena_insights_privacy_and_new_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            entries = [
                {"playerId": "secret-p1", "name": "SecretName1", "rank": 1, "point": 5000,
                 "deck": _deck([1, 2, 3, 4, 5], [101, 102, 103, 104, 105], power=260000, mrank=5, psl=5)},
                {"playerId": "secret-p2", "name": "SecretName2", "rank": 2, "point": 4900,
                 "deck": _deck([1, 2, 3, 4, 6], [101, 102, 103, 104, 106], power=210000, mrank=3, psl=5)},
                {"playerId": "secret-p3", "name": "SecretName3", "rank": 550, "point": 2000,
                 "deck": _deck([1, 2, 3, 4, 5], [101, 102, 103, 104, 105], power=190000, mrank=2, psl=2)},
            ]
            _write_arena(root, "global-hmt", "1", "1", entries)
            _write_arena(root, "global-hmt", "1", "2", [
                {"playerId": "secret-p4", "name": "SecretName4", "rank": 1, "point": 4800,
                 "deck": _deck([11, 12, 13, 14, 15], [101, 102, 107, 108, 109], power=240000)},
            ])

            res = query_ranking_insights(root, mode="arena", server="global-hmt", season="1", band="1")
            serialized = json.dumps(res)
            self.assertEqual(res["status"], "available")
            self.assertNotIn("secret-p1", serialized)
            self.assertNotIn("SecretName1", serialized)
            self.assertEqual(res["stats"]["n"], 3)
            self.assertEqual(res["stats"]["powerStats"]["lowestHeadTeam"]["rank"], 2)
            self.assertEqual(res["stats"]["powerStats"]["lowestHeadTeam"]["totalPower"], 210000)
            self.assertEqual(res["stats"]["skillVsRank"]["lowRankFullSkill"], 5)
            self.assertEqual(res["stats"]["orderPreference"]["0"][0]["key"], 1)
            self.assertTrue(any(c["support"] == 101 and len(c["boards"]) == 2 for c in res["crossBand"]))

    def test_activity_insights_cross_song_and_closing_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deck_a = _deck([1, 2, 3, 4, 5], [101, 102, 103, 104, 105], power=240000)
            deck_b = _deck([1, 2, 3, 4, 6], [101, 102, 103, 104, 106], power=220000)
            boards = [
                {
                    "eventId": "5",
                    "eventName": "Test Event",
                    "type": "music",
                    "musicId": "1001",
                    "musicName": "Song A",
                    "entries": [
                        {"playerId": "p1", "name": "P1", "rank": 1, "score": 3000000, "highScoreDeck": deck_a},
                        {"playerId": "p2", "name": "P2", "rank": 2, "score": 2900000, "highScoreDeck": deck_b},
                    ],
                },
                {
                    "eventId": "5",
                    "eventName": "Test Event",
                    "type": "music",
                    "musicId": "1002",
                    "musicName": "Song B",
                    "entries": [
                        {"playerId": "p1", "name": "P1", "rank": 1, "score": 3100000, "highScoreDeck": deck_a},
                        {"playerId": "p2", "name": "P2", "rank": 3, "score": 2800000, "highScoreDeck": deck_a},
                    ],
                },
            ]
            _write_event_archive(root, "global-hmt", "5", boards)

            # Create minimal history.sqlite3
            db_path = root / "global-hmt" / "history.sqlite3"
            conn = sqlite3.connect(db_path)
            conn.executescript("""
                CREATE TABLE observations (id TEXT PRIMARY KEY, event TEXT NOT NULL, music TEXT NOT NULL,
                  observed REAL NOT NULL, start REAL, end REAL, final INTEGER NOT NULL, coverage TEXT NOT NULL, source TEXT NOT NULL);
                CREATE TABLE scores (observation TEXT NOT NULL, rank INTEGER NOT NULL, score INTEGER NOT NULL, PRIMARY KEY(observation, rank));
            """)
            end_ts = 1763500000.0
            for oid, hrs, final_flag, base_score in [("o24", 24, 0, 1000000), ("o12", 12, 0, 1050000), ("o6", 6, 0, 1080000), ("o1", 1, 0, 1120000), ("of", 0, 1, 1150000)]:
                conn.execute("INSERT INTO observations VALUES (?, '5', '1001', ?, ?, ?, ?, '1-100', 'test')", (oid, end_ts - hrs * 3600, end_ts - 86400 * 7, end_ts, final_flag))
                for r, mult in [(10, 1.4), (50, 1.2), (100, 1.0)]:
                    conn.execute("INSERT INTO scores VALUES (?, ?, ?)", (oid, r, int(base_score * mult)))
            conn.commit()
            conn.close()

            res = query_ranking_insights(root, mode="activity", server="global-hmt", event="5", music="1001")
            self.assertEqual(res["status"], "available")
            self.assertEqual(res["crossSong"]["multiSongPlayers"], 2)
            self.assertEqual(res["crossSong"]["categories"]["samePairing"], 1)
            self.assertEqual(res["crossSong"]["categories"]["changedMembers"], 1)
            self.assertIsNotNone(res["repeatExample"])
            self.assertEqual(len(res["repeatExample"]["placements"]), 2)
            self.assertEqual(len(res["closingHistory"]), 1)
            c100 = next(c for c in res["closingHistory"][0]["changes"] if c["rank"] == 100)
            self.assertEqual(c100["increase"], 150000)

            out_dir = root / "out"
            counts = generate_all_insights(root, out_dir)
            self.assertEqual(counts["activity"], 2)

            teaser = query_ranking_insights(root, mode="activity", server="global-hmt", event="5", music="1001", view="teaser")
            self.assertEqual(teaser["status"], "available")
            self.assertTrue(teaser["isFinal"])
            self.assertNotIn("tiers", teaser)
            self.assertNotIn("allSongsUsage", teaser)
            self.assertEqual(len(teaser["stats"]["members"]["top"]), 1)
            self.assertEqual(len(teaser["closingHistory"]), 1)
            self.assertEqual([c["rank"] for c in teaser["closingHistory"][0]["changes"]], [100])
            self.assertLess(len(json.dumps(teaser)), len(json.dumps(res)))

    def test_arena_teaser_and_http_etag_cache_headers(self) -> None:
        from fastapi.testclient import TestClient
        from backend.app import create_app
        from backend.config import EnabledEnvironment, QueryServiceConfig
        from backend.contracts import Channel, Region

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            obs_root = root / "observations"
            _write_arena(obs_root, "global-hmt", "1", "1", [
                {"playerId": "p1", "name": "P1", "rank": 1, "point": 5000,
                 "deck": _deck([1, 2, 3, 4, 5], [101, 102, 103, 104, 105], power=260000)},
            ])
            _write_event_archive(obs_root, "global-hmt", "5", [{
                "eventId": "5",
                "eventName": "Test Event",
                "type": "music",
                "musicId": "1001",
                "musicName": "Song A",
                "entries": [
                    {"playerId": "p1", "name": "P1", "rank": 1, "score": 3000000,
                     "highScoreDeck": _deck([1, 2, 3, 4, 5], [101, 102, 103, 104, 105])},
                ],
            }])

            app = create_app(QueryServiceConfig(
                data_root=root,
                host="127.0.0.1",
                port=8000,
                enabled_environments=(EnabledEnvironment(region=Region.GLOBAL, channel=Channel.PRODUCTION),),
                freshness_seconds=3600,
                cache_control_max_age=60,
            ))
            client = TestClient(app)

            # Live arena teaser: short public cache + ETag + 304 support
            r1 = client.get("/api/v1/ranking-insights", params={"mode": "arena", "server": "global-hmt", "season": "1", "band": "1", "view": "teaser"})
            self.assertEqual(r1.status_code, 200)
            self.assertIn("max-age=120", r1.headers["cache-control"])
            etag = r1.headers["etag"]
            self.assertTrue(etag.startswith('W/"'))
            body = r1.json()
            self.assertNotIn("tiers", body)
            self.assertNotIn("allBandsUsage", body)

            r2 = client.get("/api/v1/ranking-insights", params={"mode": "arena", "server": "global-hmt", "season": "1", "band": "1", "view": "teaser"}, headers={"If-None-Match": etag})
            self.assertEqual(r2.status_code, 304)
            self.assertEqual(r2.content, b"")

            # Finalized activity archive: long immutable-like cache
            r3 = client.get("/api/v1/ranking-insights", params={"mode": "activity", "server": "global-hmt", "event": "5", "music": "1001", "view": "teaser"})
            self.assertEqual(r3.status_code, 200)
            self.assertIn("max-age=3600", r3.headers["cache-control"])

            # Invalid view rejected
            r4 = client.get("/api/v1/ranking-insights", params={"mode": "arena", "server": "global-hmt", "view": "bogus"})
            self.assertEqual(r4.status_code, 400)


if __name__ == "__main__":
    unittest.main()
