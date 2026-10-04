import json
import tempfile
import unittest
from pathlib import Path
from tools.system_details import SystemContext, build_missions, configured_time, enrich_systems


class SystemDetailsTest(unittest.TestCase):
    def context(self, tables):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        for name, rows in tables.items():
            (root / f"{name}.json").write_text(json.dumps({"_allData": rows}))
        return SystemContext(root, "zh-CN")

    def test_limited_group_dates_rewards_and_release_day(self):
        ctx = self.context({
            "MasterText": [{"_id": "name", "_simplifiedChinese": "开服任务"},
                           {"_id": "desc", "_simplifiedChinese": "演出{AchievementCount}次"}],
            "MasterLimitedMissionGroup": [{"_id": 3, "_missionCategory": 2, "_nameTextID": "name",
                "_startAt": "2026/09/24", "_endAt": "2026/10/28", "_completeRewardIds": [9]}],
            "MasterLimitedMission": [{"_id": 1, "_limitedMissionGroupId": 3, "_descriptionTextId": "desc",
                "_achievementCount": 5, "_releaseDay": 2, "_missionRewardIds": [9], "_endAt": "null"}],
            "MasterMissionReward": [{"_id": 9, "_resourceType": 1, "_resourceId": 1, "_resourceCount": 10}],
        })
        mission = build_missions(ctx)[0]
        self.assertEqual(mission["category"], "limited")
        self.assertEqual(mission["endAt"], "2026/10/28")
        self.assertEqual(mission["description"], "演出5次")
        self.assertEqual(mission["completeRewards"][0]["count"], 10)
        self.assertEqual(mission["releaseDay"], 2)

    def test_grouped_stages_keep_rewards_and_sort_targets(self):
        ctx = self.context({"MasterText": [{"_id": "desc", "_simplifiedChinese": "演出{AchievementCount}次"}],
            "MasterMission": [{"_id": i, "_missionCategory": 4, "_descriptionTextId": "desc",
                "_useTypeGrouping": True, "_achievementCount": target, "_missionRewardIds": []}
                for i, target in [(1, 10), (2, 5)]]})
        groups = build_missions(ctx)
        self.assertEqual(len(groups), 1)
        self.assertEqual([s["target"] for s in groups[0]["stages"]], [5, 10])
        self.assertEqual(groups[0]["description"], "演出5次")

    def test_daily_tasks_group_even_without_type_grouping(self):
        ctx = self.context({"MasterMission": [
            {"_id": i, "_missionCategory": 1, "_missionType": i, "_useTypeGrouping": False,
             "_missionRewardIds": []} for i in (1, 2, 3)]})
        groups = build_missions(ctx)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["title"], "每日任务")
        self.assertEqual(len(groups[0]["stages"]), 3)

    def test_programme_groups_different_objectives_without_losing_conditions(self):
        ctx = self.context({"MasterLimitedMissionGroup": [{"_id": 1, "_missionCategory": 2}],
            "MasterLimitedMission": [{"_id": i, "_limitedMissionGroupId": 1, "_missionType": i,
                "_releaseDay": i, "_missionRewardIds": []} for i in (1, 2)]})
        group = build_missions(ctx)[0]
        self.assertEqual(len(group["stages"]), 2)
        self.assertEqual([s["releaseDay"] for s in group["stages"]], [1, 2])

    def test_live_difficulty_is_zero_based_and_score_rank_includes_e_and_d(self):
        ctx = self.context({"MasterText": [{"_id": "d", "_simplifiedChinese": "{MusicDifficulty} / {ScoreRank}"}],
            "MasterMission": [{"_id": 1, "_descriptionTextId": "d", "_musicDifficulty": 0, "_scoreRank": 6}]})
        self.assertEqual(build_missions(ctx)[0]["description"], "EASY / S")

    def test_missing_mission_reward_fails_instead_of_silently_omitting(self):
        ctx = self.context({"MasterMission": [{"_id": 1, "_missionRewardIds": [404]}]})
        with self.assertRaisesRegex(ValueError, "missing mission rewards"):
            build_missions(ctx)

    def test_unknown_placeholder_is_not_exposed(self):
        ctx = self.context({"MasterText": [{"_id": "desc", "_simplifiedChinese": "达到{NewCondition}"}],
            "MasterMission": [{"_id": 1, "_descriptionTextId": "desc", "_missionRewardIds": []}]})
        self.assertEqual(build_missions(ctx)[0]["description"], "任务条件详情暂未收录")

    def test_unlock_rewards_use_their_own_table_even_when_item_ids_collide(self):
        ctx = self.context({
            "MasterText": [{"_id": name, "_simplifiedChinese": name} for name in ("item", "song", "degree", "spot")],
            "MasterItem": [{"_id": 1, "_nameTextId": "item", "_type": 12}],
            "MasterLiveMusic": [{"_id": 1, "_titleTextID": "song", "_jacketAssetName": "jacket"}],
            "MasterDegree": [{"_id": 1, "_nameTextId": "degree", "_imagePath": "Image/Degree/title"}],
            "MasterHomeSpot": [{"_id": 1, "_nameTextId": "spot", "_thumbnailAssetPath": "Image/Spot/scene"}],
        })
        for kind, name, path in [(8, "song", "Image/Jacket/jacket"), (17, "degree", "Image/Degree/title"), (19, "spot", "Image/Spot/scene")]:
            with self.subTest(kind=kind):
                reward = ctx.reward({"_resourceType": kind, "_resourceId": 1, "_resourceCount": 2})
                self.assertEqual((reward["name"], reward["imagePath"], reward["count"]), (name, path, 2))
                self.assertIsNone(reward["itemType"])

    def test_permanent_collections_preserve_objectives_without_summing_character_templates(self):
        ctx = self.context({
            "MasterMissionReward": [{"_id": 1, "_resourceType": 1, "_resourceId": 1, "_resourceCount": 10}],
            "MasterMission": [
                {"_id": 1, "_missionCategory": 4, "_storyChapterId": 1, "_missionRewardIds": [1]},
                {"_id": 2, "_missionCategory": 4, "_storyChapterId": 2, "_missionRewardIds": [1]},
                {"_id": 3, "_missionCategory": 4, "_missionRewardIds": [1]},
            ],
            "MasterCharacterMission": [{"_id": 4, "_missionCategory": 7, "_missionRewardIds": [1]}],
        })
        groups = build_missions(ctx)
        self.assertEqual({g["title"] for g in groups}, {"剧情阅读", "综合养成"})
        self.assertEqual({s["id"] for g in groups for s in g["stages"]}, {1, 2, 3, 4})
        self.assertEqual({g["category"] for g in groups}, {"permanent"})
        story = next(g for g in groups if g["title"] == "剧情阅读")
        self.assertEqual(len(story["sections"]), 2)
        self.assertEqual(story["previewRewards"][0]["count"], 20)
        growth = next(g for g in groups if g["title"] == "综合养成")
        self.assertEqual(growth["previewRewards"][0]["count"], 10)
        self.assertEqual(sum(s["isCharacterTemplate"] for s in growth["sections"]), 1)

    def test_missing_completion_reward_fails_instead_of_disappearing(self):
        ctx = self.context({"MasterLimitedMissionGroup": [{"_id": 1, "_completeRewardIds": [404]}],
            "MasterLimitedMission": [{"_id": 1, "_limitedMissionGroupId": 1}]})
        with self.assertRaisesRegex(ValueError, "missing completion rewards"):
            build_missions(ctx)

    def test_hidden_objectives_form_one_collection_separate_from_permanent_performance(self):
        ctx = self.context({"MasterMission": [
            {"_id": 1, "_missionCategory": 9, "_descriptionTextId": "Mission_Description_ScoreRankCharacter", "_missionType": 122},
            {"_id": 2, "_missionCategory": 9, "_descriptionTextId": "Mission_Description_LiveClearMusic", "_missionType": 123},
            {"_id": 3, "_missionCategory": 4, "_missionType": 124},
        ]})
        groups = build_missions(ctx)
        hidden = next(g for g in groups if g["category"] == "secret")
        self.assertEqual(hidden["title"], "隐藏任务")
        self.assertEqual(len(hidden["sections"]), 2)
        self.assertEqual([s["id"] for s in hidden["stages"]], [1, 2])
        performance = next(g for g in groups if g["title"] == "演出挑战")
        self.assertEqual([s["id"] for s in performance["stages"]], [3])

    def test_unknown_rerun_omitted_and_no_guaranteed_probability_invented(self):
        ctx = self.context({"MasterGacha": [{"_id": 1, "_lotGroupId": 2}],
            "MasterGachaLot": [{"_lotGroupId": 2, "_prizeGroupId": 3, "_weight": 300,
                "_rarityConstraint": 4, "_resourceTypeConstraint": 2},
                {"_lotGroupId": 2, "_prizeGroupId": 4, "_weight": 9700, "_rarityConstraint": 2, "_resourceTypeConstraint": 3}],
            "MasterGachaPrize": [{"_groupId": 3, "_resourceType": 2, "_resourceId": 51, "_pickUpType": 2,
                "_pickUpFixedRate": 50}]})
        result = {"gachaPools": [{"id": 1, "name": "Pool", "startAt": "null", "endAt": "null",
                    "products": [], "isLimited": False}], "vipRanks": [], "studioUnits": [], "evidence": []}
        pool = enrich_systems(result, ctx.root, ctx.locale)["gachaPools"][0]
        self.assertNotIn("isRerun", pool)
        self.assertNotIn("guaranteedPercent", pool)
        self.assertEqual(pool["probabilityGroups"][0]["percent"], 3)
        self.assertAlmostEqual(sum(g["percent"] for g in pool["probabilityGroups"]), 100)
        self.assertEqual(pool["prizes"][0]["fixedRateBasisPoints"], 50)
        self.assertIsNone(pool["endAt"])

    def test_null_times_are_empty(self):
        for value in (None, "", "null", " NULL "):
            self.assertIsNone(configured_time(value))

    def test_history_projection_keeps_distinct_prize_ids_for_same_card(self):
        ctx = self.context({'MasterGachaPrize': [
            {'_id': 101, '_groupId': 1, '_resourceType': 2, '_resourceId': 51, '_pickUpType': 1},
            {'_id': 102, '_groupId': 2, '_resourceType': 2, '_resourceId': 51, '_pickUpType': 2}]})
        result = enrich_systems({'gachaPools': [], 'vipRanks': [], 'studioUnits': [], 'evidence': []}, ctx.root, ctx.locale)
        self.assertEqual([row['id'] for row in result['gachaHistoryPrizes']], [101, 102])
        self.assertEqual([row['isPickup'] for row in result['gachaHistoryPrizes']], [False, True])

    def test_reward_preview_prioritizes_gems_cards_tickets_and_aggregates_stages(self):
        ctx = self.context({
            "MasterItem": [{"_id": identity, "_type": kind} for identity, kind in [(1, 12), (3, 14), (9, 2)]],
            "MasterMissionReward": [{"_id": i, "_resourceType": kind, "_resourceId": identity, "_resourceCount": count}
                for i, kind, identity, count in [(1, 1, 3, 1000), (2, 1, 9, 1), (3, 3, 70, 1), (4, 1, 1, 50)]],
            "MasterMission": [{"_id": i, "_missionCategory": 1, "_missionRewardIds": ids}
                for i, ids in [(1, [1, 2, 3, 4]), (2, [4, 3])]],
        })
        group = build_missions(ctx)[0]
        self.assertEqual([(r["resourceType"], r["resourceId"], r["count"]) for r in group["previewRewards"]],
                         [(1, 1, 100), (3, 70, 2), (1, 9, 1), (1, 3, 1000)])
        self.assertEqual(len(group["stages"]), 2)

    def test_rank_rewards_and_practice_draws_keep_items_amounts_and_weights(self):
        ctx = self.context({
            "MasterItem": [{"_id": 39, "_nameTextId": "item", "_imagePath": "Item/39"}],
            "MasterText": [{"_id": "item", "_simplifiedChinese": "招募券"}],
            "MasterVipDailyReward": [{"_id": 1, "_vipRank": 7, "_day": 1,
                "_resourceType": 1, "_resourceId": 39, "_resourceCount": 2}],
            "MasterVipRankUpReward": [{"_id": 2, "_vipRank": 7,
                "_resourceType": 1, "_resourceId": 39, "_resourceCount": 5}],
            "MasterOfflineBonusUnitLevel": [{"_offlineBonusUnitId": 1, "_offlineBonusLevel": 1, "_earnItemLot": 3}],
            "MasterOfflineBonusItemLot": [{"_groupId": 4, "_resourceType": 1, "_resourceId": 39,
                "_resourceCount": amount, "_weight": weight} for amount, weight in [(1, 3), (2, 1)]],
        })
        result = enrich_systems({"gachaPools": [], "vipRanks": [{"rank": 7}],
            "studioUnits": [{"id": 1, "bandId": 1, "name": "MyGO!!!!!", "levels": [
                {"level": 1, "itemLotGroupId": 4, "rawEarnCoin": 50}]}], "evidence": []}, ctx.root, ctx.locale)
        rank = result["vipRanks"][0]
        self.assertEqual(rank["dailyRewards"][0]["name"], "招募券")
        self.assertEqual(rank["dailyRewards"][0]["count"], 2)
        self.assertEqual(rank["rankUpRewards"][0]["count"], 5)
        unit = result["studioUnits"][0]
        self.assertEqual(unit["levels"][0]["rawEarnCoin"], 50)
        self.assertEqual(unit["levels"][0]["itemDraws"], 3)
        self.assertEqual([r["percent"] for r in unit["itemRewards"]["4"]], [75, 25])
