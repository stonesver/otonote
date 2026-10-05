from __future__ import annotations

import json
import hashlib
import tempfile
import unittest
from pathlib import Path

from tools.arena_rank import ArenaRankError, build_arena_rank

REVIEWED_EVIDENCE = Path(__file__).resolve().parents[1] / "catalog/evidence/arena-client.json"
REVIEWED_SHA256 = "2fa9fc8a8ba121b4fcbb486a4f2b88d6dcf1754720ad1dfe2371740387a8bfb0"


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


class ArenaRankBuildTest(unittest.TestCase):
    def test_repository_evidence_keeps_historical_projection_and_missing_fails(self) -> None:
        self.assertEqual(hashlib.sha256(REVIEWED_EVIDENCE.read_bytes()).hexdigest(), REVIEWED_SHA256)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            master, _fixture_evidence = self.fixture(root)
            result = build_arena_rank(master, "jp-test-release", REVIEWED_EVIDENCE)
            self.assertEqual(result["status"], "server_unavailable")
            self.assertEqual(len(result["capabilities"]), 15)
            self.assertFalse(result["evidence"]["featureFlags"]["CcEnableArenas"])
            with self.assertRaisesRegex(ArenaRankError, "missing Arena evidence"):
                build_arena_rank(master, "jp-test-release", root / "missing-evidence.json")

    def fixture(self, root: Path) -> tuple[Path, Path]:
        master = root / "master"
        master.mkdir()
        write_json(
            master / "MasterText.json",
            {
                "_allData": [
                    {
                        "_id": "Mission_Description_ArenaPlay",
                        "_japanese": "ランクマッチを{0}回プレイしよう",
                    },
                    {
                        "_id": "ui_profile_gekisou_arena_not_availale",
                        "_japanese": "現在撃奏アリーナは開催されていません",
                    },
                    {
                        "_id": "ui_arena_top_ranking",
                        "_japanese": "ランキング",
                    },
                    {
                        "_id": "ui_arena_reward_window_season_tab",
                        "_japanese": "シーズン",
                    },
                ]
            },
        )
        write_json(
            master / "MasterLiveGekisouMatchingBucket.json",
            {"_allData": [{"_id": 1}]},
        )
        write_json(
            master / "MasterLiveGekisouRankingScoreBonus.json",
            {"_allData": [{"_id": 1}, {"_id": 2}]},
        )
        evidence = root / "arena-client-evidence.json"
        write_json(
            evidence,
            {
                "schemaVersion": 1,
                "featureFlags": {"CcEnableArenas": False},
                "clientSymbols": [
                    "ArenaPlay",
                    "ArenaRank",
                    "GekisouArena",
                    "GekisouArenaRank",
                ],
                "resources": [
                    "Btn_GekisoArena",
                    "BattleLiveArenaPenLight",
                ],
            },
        )
        return master, evidence

    def test_builds_an_explicit_server_unavailable_projection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            master, evidence = self.fixture(Path(temporary))
            result = build_arena_rank(master, "test-release", evidence)

        self.assertEqual(result["status"], "server_unavailable")
        self.assertIsNone(result["currentSeason"])
        self.assertEqual(result["pastSeasons"], [])
        self.assertIn("seasonId", result["missingServerFields"])
        self.assertTrue(
            any(item["id"] == "rating" for item in result["capabilities"])
        )
        self.assertEqual(
            result["relationships"][0]["statement"],
            "当前版本与撃奏高度关联",
        )
        self.assertFalse(result["evidence"]["featureFlags"]["CcEnableArenas"])

    def test_incomplete_season_cannot_unlock_the_page(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            master, evidence = self.fixture(Path(temporary))
            result = build_arena_rank(
                master,
                "test-release",
                evidence,
                season_payload={
                    "seasonId": "season-1",
                    "startAt": "2026-01-01T00:00:00Z",
                },
            )

        self.assertIsNone(result["currentSeason"])
        self.assertEqual(result["status"], "server_data_incomplete")
        self.assertIn("endAt", result["missingServerFields"])

    def test_rejects_unreviewed_client_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            master, evidence = self.fixture(Path(temporary))
            write_json(evidence, {"schemaVersion": 1})
            with self.assertRaisesRegex(ArenaRankError, "clientSymbols"):
                build_arena_rank(master, "test-release", evidence)

    def test_complete_season_accepts_a_real_leaderboard_or_status(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            master, evidence = self.fixture(Path(temporary))
            season = {
                "seasonId": "season-1",
                "startAt": "2026-01-01T00:00:00Z",
                "endAt": "2026-02-01T00:00:00Z",
                "status": "ended",
                "leaderboard": [],
                "rewardDefinitions": [{"type": "season", "rewardIds": [1]}],
                "sourceReleaseId": "test-release",
            }
            result = build_arena_rank(
                master,
                "test-release",
                evidence,
                season_payload=season,
            )

        self.assertEqual(result["status"], "season_available")
        self.assertEqual(result["currentSeason"], season)
        self.assertEqual(result["missingServerFields"], [])


if __name__ == "__main__":
    unittest.main()
