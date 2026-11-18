from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tools.event_catalog import EVENT_TABLES, EventCatalogError, build_event_archive

FIXTURE = Path(__file__).parent / "fixtures/events/jp-1.0.4-sample.json"


class EventCatalogTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.tables = json.loads(FIXTURE.read_text())["tables"]
        self.write()

    def write(self):
        for name, rows in self.tables.items():
            (self.root / f"{name}.json").write_text(json.dumps({"_allData": rows}))

    def build(self, edition="jp", release="jp-test", locale="zh-CN"):
        return build_event_archive(self.root, release, edition=edition, locale=locale)

    def test_event_art_is_not_dropped_by_generic_extra_limit(self):
        from tools.build_site_catalog import select_catalog_records
        records = [{"source_file": Path("/tmp/" + kind + ".png"), "name": kind,
                    "kind": "other", "container_path": "Assets/AddressableResources/Image/Event/01/" + kind + "/image.png"}
                   for kind in ("Logo", "Top", "Other")]
        self.assertEqual(select_catalog_records(records, extra_limit=0), records[:2])

    def test_event_image_targets_follow_master_references(self):
        from tools.current_content_inputs import core_image_targets
        class Resources:
            catalog = type("Catalog", (), {"locations": []})()
            def rows(inner, table):
                return self.tables["MasterEvent"] if table == "MasterEvent" else []
            def prefix(inner, value): return value
        targets = core_image_targets(Resources())
        self.assertEqual(len(targets), 2)
        self.assertIn("Assets/AddressableResources/Image/Event/01/Top/event_top_01_0001.png", targets)
        self.assertTrue(all(value.startswith("image_assets_image_event_") for value in targets.values()))

    def test_real_jp_relations_and_japanese_fallback(self):
        archive = self.build()
        self.assertEqual(archive["warnings"], [])
        event = archive["records"][0]
        self.assertEqual(event["name"], "アイの奔流　AtoZ")
        self.assertEqual(event["nameLocale"], "ja")
        self.assertEqual(event["schedule"]["startAt"], "2026/09/30 18:00:00")
        self.assertEqual(event["schedule"]["timeZone"], "Asia/Tokyo")
        self.assertEqual(event["achievements"][2]["rewards"][0]["resourceId"], 63)
        self.assertIn("峰月 律", event["achievements"][2]["rewards"][0]["name"])
        self.assertEqual(event["loopRewards"][0]["intervalPoints"], 1000000)
        self.assertEqual(event["story"]["bandId"], 3)
        self.assertEqual(event["story"]["characterIds"], [11, 12, 13, 14, 15])
        self.assertEqual(len(event["story"]["episodes"]), 9)
        self.assertEqual(event["story"]["episodes"][0]["requiredPoints"], 500)
        self.assertEqual(event["story"]["episodes"][0]["name"], "しんきょく")
        self.assertEqual(event["story"]["episodes"][0]["description"], "そう、全国ツアーの看板曲！")
        self.assertEqual(sum(r["isAnotherEpisode"] for r in event["story"]["episodes"]), 2)
        self.assertEqual(len(event["effects"]), 20)
        self.assertEqual(event["effects"][0]["rankValues"], [3000, 3500, 4000, 4500, 5000])
        self.assertEqual(event["effects"][0]["valueUnit"], "raw_master_integer")

    def test_related_content_requires_more_than_overlapping_dates(self):
        event = self.tables["MasterEvent"][0]
        period = {"_startAt": event["_startAt"], "_endAt": event["_endAt"]}
        self.tables["MasterGacha"] = [
            {"_id": 10, "_nameTextId": "test-pool", "_lotGroupId": 10,
             "_warningTextId": "gacha_warning_event", **period},
            {"_id": 11, "_nameTextId": "test-pool", "_lotGroupId": 11,
             "_warningTextId": "gacha_warning_event", **period},
            {"_id": 12, "_nameTextId": "test-pool", "_lotGroupId": 10,
             "_warningTextId": "gacha_warning_event", "_eventId": 999, **period},
        ]
        self.tables["MasterGachaLot"] = [{"_id": 1, "_lotGroupId": 10, "_prizeGroupId": 10},
                                         {"_id": 2, "_lotGroupId": 11, "_prizeGroupId": 11}]
        self.tables["MasterGachaPrize"] = [
            {"_id": 1, "_groupId": 10, "_resourceType": 2, "_resourceId": 61, "_pickUpType": 2},
            {"_id": 2, "_groupId": 11, "_resourceType": 2, "_resourceId": 999, "_pickUpType": 2}]
        self.tables["MasterSeasonPass"] = [
            {"_id": 2, "_nameTextId": "test-pass", "_levelGroup": 2, **period},
            {"_id": 3, "_nameTextId": "test-other-pass", "_levelGroup": 3, **period},
            {"_id": 4, "_nameTextId": "test-pass", "_levelGroup": 2, "_eventId": 999, **period}]
        self.tables["MasterText"] += [
            {"_id": "test-pool", "_japanese": "UP pool"},
            {"_id": "test-pass", "_japanese": "アイの奔流 AtoZミッションパス"},
            {"_id": "test-other-pass", "_japanese": "Monthly Pass"}]
        self.tables["MasterSeasonPassLevel"] = [{"_id": 1, "_group": 2, "_level": 1, "_point": 0}]
        self.tables["MasterSeasonPassReward"] = [{"_id": 1, "_resourceType": 2, "_resourceId": 63, "_resourceCount": 1}]
        self.tables["MasterSeasonPassLevelReward"] = [{"_id": 1, "_seasonPassId": 2, "_level": 1, "_isPremium": False, "_rewardIds": [1]}]
        self.write()
        related = self.build()["records"][0]["related"]
        self.assertEqual([p["id"] for p in related["recruitment"]], [10])
        self.assertEqual(related["recruitment"][0]["eventRelationStatus"], "featured_cards_and_start")
        self.assertEqual([p["id"] for p in related["passes"]], [2])
        self.assertEqual(related["passes"][0]["levels"][0]["free"][0]["resourceId"], 63)
        self.assertEqual(related["missions"], [])

    def test_reward_group_is_event_group_not_common_group(self):
        event = self.build()["records"][0]
        normal = event["pointRules"]["normal"]
        self.assertEqual(normal["rewardGroup"], 2)
        self.assertEqual(len(normal["rewards"]), 6)
        self.assertTrue(all(r["group"] == 1 for r in normal["rewards"]))
        self.assertEqual(normal["rewards"][0]["reward"]["count"], 18)
        self.assertEqual(normal["points"][0]["value"], 15)
        self.assertEqual(normal["points"][0]["scoreRankLabel"], "D")
        self.assertEqual(event["pointRules"]["challenge"]["points"][0]["value"], 1500)

    def test_challenge_rank_rewards_join_each_song_and_never_become_live_rankings(self):
        archive = self.build()
        event = archive["records"][0]
        self.assertEqual([s["musicId"] for s in event["challengeSongs"]], [100109, 100056, 100063])
        self.assertTrue(all(len(s["rankingRewards"]) == 1 for s in event["challengeSongs"]))
        self.assertEqual(len({s["rankingRewards"][0]["id"] for s in event["challengeSongs"]}), 3)
        self.assertEqual(event["ranking"]["configured"], {"eventPoints": False, "music": True, "totalMusic": True})
        self.assertFalse(archive["capabilities"]["hasRanking"])
        self.assertEqual(event["ranking"]["liveDataStatus"], "not_collected")
        self.assertTrue(archive["instanceRoutesEnabled"])

    def test_challenge_rules_use_event_song_overrides_and_consumption_rates(self):
        # Normal-song missions must never replace the challenge variant's zeros.
        self.tables["MasterLiveMusic"][0]["_gekisouMission1"] = 3
        self.write()
        event = self.build()["records"][0]
        self.assertEqual(event["challengeSongs"][0]["attributeCode"], 2)
        self.assertEqual(event["challengeSongs"][0]["gekisouMissionTypes"], [0, 0, 0])
        self.assertEqual(event["challengeRules"]["consumptionOptions"], [
            {"cost": cost, "pointRate": rate, "rewardRate": rate}
            for cost, rate in [(200, 1), (400, 2), (800, 4), (1600, 8)]])
        self.assertEqual(event["challengeRules"]["normalLiveChallengePoints"][-1]["value"], 10)

    def test_missing_challenge_mission_is_not_reported_as_disabled(self):
        del self.tables["MasterChallengeMusic"][0]["_gekisouMission1"]
        self.write()
        self.assertEqual(self.build()["records"][0]["challengeSongs"][0]["gekisouMissionTypes"], [None, 0, 0])

    def test_currency_join_does_not_attach_unrelated_exchange(self):
        self.tables["MasterExchange"].append({"_id": 999, "_paymentResourceType": 1, "_paymentResourceId": 1})
        self.write()
        event = self.build()["records"][0]
        self.assertEqual([s["id"] for s in event["exchanges"]], [1])
        self.assertEqual(event["exchanges"][0]["products"][0]["reward"]["resourceId"], 64)
        self.assertEqual(event["exchanges"][0]["endAt"], "2026-10-19 20:59:59")

    def test_reused_currency_keeps_each_exchange_with_its_opening_event(self):
        old = self.tables["MasterEvent"][0]
        self.tables["MasterEvent"].append({**old, "_id": 2,
            "_startAt": "2026/10/09 15:00:00", "_endAt": "2026/10/17 14:59:59"})
        self.tables["MasterExchange"].append({**self.tables["MasterExchange"][0],
            "_id": 2, "_startAt": "2026-10-09 15:00:00", "_endAt": "2026-10-28 20:59:59"})
        self.write()
        for edition in ("global", "jp"):
            with self.subTest(edition=edition):
                events = self.build(edition=edition)["records"]
                self.assertEqual([[s["id"] for s in e["exchanges"]] for e in events], [[1], [2]])
                # The old exchange remains valid past its event and into the next event.
                self.assertEqual(events[0]["exchanges"][0]["endAt"], "2026-10-19 20:59:59")

    def test_missing_reward_is_explicit_not_zero_or_omitted(self):
        self.tables["MasterReward"] = [r for r in self.tables["MasterReward"] if r["_id"] != 1]
        self.write()
        archive = self.build()
        self.assertIn("missing_reference:MasterReward:1", archive["warnings"])
        reward = archive["records"][0]["achievements"][0]["rewards"][0]
        self.assertFalse(reward["resolved"])
        self.assertIsNone(reward["count"])

    def test_orphan_rows_are_counted_even_when_an_event_exists(self):
        self.tables["MasterEventAchievementReward"].append({"_id": 999, "_eventId": 999, "_eventPoint": 100})
        self.write()
        archive = self.build()
        self.assertEqual(archive["orphanAuxiliaryRowCount"], 1)
        self.assertEqual(len(archive["records"][0]["achievements"]), 3)

    def test_empty_global_snapshot_has_no_cross_edition_fallback(self):
        for name in EVENT_TABLES:
            self.tables[name] = []
        self.write()
        archive = self.build(edition="global", release="global-empty")
        self.assertEqual(archive["records"], [])
        self.assertEqual(archive["definitionCount"], 0)
        self.assertFalse(any(archive["capabilities"].values()))

    def test_explicit_edition_and_release_are_preserved_for_same_id(self):
        jp, glob = self.build(), self.build(edition="global", release="global-test")
        self.assertEqual(jp["records"][0]["id"], glob["records"][0]["id"])
        self.assertNotEqual(jp["records"][0]["edition"], glob["records"][0]["edition"])
        self.assertNotEqual(jp["records"][0]["sourceReleaseId"], glob["records"][0]["sourceReleaseId"])
        with self.assertRaisesRegex(EventCatalogError, "explicit"):
            self.build(edition=None)

    def test_duplicate_ids_and_malformed_tables_fail(self):
        self.tables["MasterEvent"].append(self.tables["MasterEvent"][0])
        self.write()
        with self.assertRaisesRegex(EventCatalogError, "duplicate"):
            self.build()
        (self.root / "MasterEvent.json").write_text('{"_allData": [1]}')
        with self.assertRaisesRegex(EventCatalogError, "array of objects"):
            self.build()

    def test_missing_ranking_flag_stays_unknown(self):
        del self.tables["MasterEvent"][0]["_isMusicRankingDisabled"]
        self.write()
        self.assertIsNone(self.build()["records"][0]["ranking"]["configured"]["music"])

    def test_missing_table_has_evidence_instead_of_silent_empty(self):
        (self.root / "MasterEventEffect.json").unlink()
        archive = self.build()
        self.assertIn("missing_table:MasterEventEffect", archive["warnings"])
        self.assertEqual(next(e for e in archive["evidence"] if e["table"] == "MasterEventEffect")["status"], "missing")


if __name__ == "__main__":
    unittest.main()
