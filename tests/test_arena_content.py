import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from tools.arena_content import build_arena_content, validate_arena_publication, read_arena_review


class ArenaContentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.tables = {
            "MasterArenaSeason": [{"_id": 1, "_startAt": "2026/10/28 0:00:00", "_endAt": "2026/11/28 14:59:58", "_rankingCountEndAt": "2026/11/28 14:59:59"}],
            "MasterArenaLeague": [{"_id": 7, "_bandId": 2, "_startAt": ""}],
            "MasterArenaLeagueRegulation": [{"_id": 1, "_leagueId": 7, "_liveMusicType": 99, "_gekisouMission1": 1, "_gekisouMission2": 0, "_gekisouMission3": 3, "_startAt": "2026/10/28 0:00:00", "_endAt": "2026/10/29 3:59:59", "private": "never published"}],
            "MasterArenaRank": [{"_id": 1, "_bandId": 2, "_rank": 1, "_division": 1, "_lp": 0}],
            "MasterBattleLivePlace": [{"_id": 1, "_matchRank": 1, "_matchPlayers": 2, "_place": 1, "_basePoint": 10}, {"_id": 2, "_matchRank": 1, "_matchPlayers": 2, "_place": 2, "_basePoint": -4}],
            "MasterLiveArenaRankReward": [{"_id": 1, "_leagueId": 7, "_rankMatchId": 1, "_resourceType": 1, "_resourceId": 3, "_count": 50}],
            "MasterItem": [{"_id": 3, "_nameTextId": "item"}],
            "MasterText": [{"_id": "item", "_simplifiedChinese": "测试物品", "_english": "Test item"}],
        }
        self.review = {"schemaVersion": 1, "sourceReleaseId": "test", "region": "global", "serverScopes": ["global-hmt"],
            "observedAt": "2026-10-28T00:00:00Z", "time": {"semanticsVersion": "inclusive-second-v1", "timeZone": "Asia/Tokyo"},
            "tables": {}, "resourceItems": {"1:3": 3}, "rewardGroups": [{"kind": "promotion", "bandId": 2, "rankId": 1, "label": "首次晋段", "rowIds": [1]}]}
        self.seal()

    def seal(self):
        for name, rows in self.tables.items():
            raw = json.dumps({"_allData": rows}).encode()
            (self.root / (name + ".json")).write_bytes(raw)
            self.review["tables"][name] = {"sha256": hashlib.sha256(raw).hexdigest(), "publishedIds": [r["_id"] for r in rows]}

    def build(self, **kw):
        return build_arena_content(self.root, "test", "global", review=self.review, **kw)

    def test_no_review_no_research_or_future_rows(self):
        data = build_arena_content(self.root, "test", "global")
        self.assertEqual(data["seasons"], []); self.assertFalse(data["capabilities"]["conditions"])
        self.review["tables"]["MasterArenaLeagueRegulation"]["publishedIds"] = []
        self.assertEqual(self.build()["regulations"], [])

    def test_server_masters_can_share_only_identical_reviewed_tables(self):
        self.review['masterVersion']='a'*32
        self.review['serverScopes']=['global-hmt','global-en','global-kr']
        hashes={name:row['sha256'] for name,row in self.review['tables'].items()}
        self.review['serverMasters']={server:dict(version=version*32,tables=copy.deepcopy(hashes))
            for server,version in [('global-hmt','a'),('global-en','b'),('global-kr','c')]}
        value=self.build();validate_arena_publication(value,'test','global')
        self.assertEqual(value['sourceMasterVersions']['global-en'],'b'*32)
        self.review['serverMasters']['global-en']['tables']['MasterArenaRank']='d'*64
        with self.assertRaisesRegex(ValueError,'tables differ'):self.build()
        value['sourceMasterVersions'].pop('global-kr')
        with self.assertRaises(ValueError):validate_arena_publication(value,'test','global')

    def test_whitelist_mapping_and_inclusive_seconds(self):
        d = self.build()
        self.assertEqual(d["leagues"][0]["id"], "7"); self.assertEqual(d["leagues"][0]["bandId"], "2")
        row = d["regulations"][0]
        self.assertEqual(row["missions"], [1, 0, 3]); self.assertEqual(row["attribute"], 99)
        self.assertEqual(row["validUntil"], "2026-10-28T19:00:00+00:00")
        self.assertNotIn("private", row)
        self.assertEqual(d["seasons"][0]["validUntil"], "2026-11-28T05:59:59+00:00")
        self.assertEqual(d["seasons"][0]["statisticsUntil"], "2026-11-28T06:00:00+00:00")
        self.assertEqual(d["basePoints"][-1]["points"], -4)
        self.assertTrue(d["capabilities"]["conditions"])

    def test_unknown_time_or_reward_reference_only_closes_affected_capability(self):
        self.review.pop("time"); self.review["resourceItems"] = {}
        d = self.build()
        self.assertFalse(d["capabilities"]["conditions"]); self.assertTrue(d["capabilities"]["ranks"])
        self.assertTrue(d["capabilities"]["basePoints"]); self.assertFalse(d["capabilities"]["rewards"])
        self.assertIsNone(d["regulations"][0]["validUntil"]); self.assertIn("2026/", d["regulations"][0]["sourceTimeText"])

    def test_release_server_and_source_hash_checked_before_publication(self):
        self.assertRaises(ValueError, validate_arena_publication, self.build(), "other", "global")
        self.review["serverScopes"] = ["jp"]
        self.assertRaises(ValueError, self.build)
        self.review["serverScopes"] = []
        (self.root / "MasterArenaSeason.json").write_text("{}")
        self.assertRaises(ValueError, self.build)

    def test_duplicate_points_disable_only_points_and_hotfix_changes_revision(self):
        old = self.build()["sourceRevision"]
        self.tables["MasterBattleLivePlace"].append({**self.tables["MasterBattleLivePlace"][0], "_id": 3})
        self.seal(); d = self.build()
        self.assertFalse(d["capabilities"]["basePoints"]); self.assertTrue(d["capabilities"]["conditions"])
        self.assertNotEqual(old, d["sourceRevision"])

    def test_activity_boundaries_need_their_own_verified_time_and_published_ids(self):
        self.tables['MasterEvent'] = [{'_id': 10, '_startAt': '2026/10/29 12:00:00', '_endAt': '2026/11/1 20:59:59', 'private': 'hidden'}]
        self.seal()
        self.assertEqual(self.build()['activityPeriods'], [])
        self.review['activityTime'] = {'semanticsVersion': 'inclusive-second-v1', 'timeZone': 'Asia/Tokyo'}
        data = self.build()
        self.assertEqual(data['activityPeriods'], [{'id':'10','validFrom':'2026-10-29T03:00:00+00:00','validUntil':'2026-11-01T12:00:00+00:00'}])
        validate_arena_publication(data, 'test', 'global')
        data['activityPeriods'][0]['validFrom'] = '2026/10/29 12:00:00'
        self.assertRaises(ValueError, validate_arena_publication, data, 'test', 'global')
        self.review['tables']['MasterEvent']['publishedIds'] = []
        self.assertEqual(self.build()['activityPeriods'], [])

    def test_personal_rank_master_binding_is_explicit_and_validated(self):
        self.assertNotIn('sourceMasterVersion',self.build())
        self.review['masterVersion']='a'*32
        value=self.build();self.assertEqual(value['sourceMasterVersion'],'a'*32)
        validate_arena_publication(value,'test','global')
        value['sourceMasterVersion']='invalid';self.assertRaises(ValueError,validate_arena_publication,value,'test','global')
        self.review['masterVersion']='invalid';self.assertRaises(ValueError,self.build)

    def test_localization_does_not_change_numeric_identity(self):
        a, b = self.build(), self.build(locale="en")
        self.assertEqual(a["sourceRevision"], b["sourceRevision"])
        self.assertEqual(a["regulations"], b["regulations"])
        self.assertEqual(b["rewards"][0]["items"][0]["name"], "Test item")

    def test_rank_badges_are_optional_reviewed_assets_not_condition_identity(self):
        before=self.build()
        raw=b'RIFF'+b'\x08\0\0\0'+b'WEBP'
        (self.root/'badge.webp').write_bytes(raw)
        self.review['rankIcons']=[dict(tier=1,path='badge.webp',sha256=hashlib.sha256(raw).hexdigest())]
        value=self.build()
        self.assertEqual(value['sourceRevision'],before['sourceRevision'])
        self.assertEqual(len(value['rankIcons']),1)
        validate_arena_publication(value,'test','global')
        self.review['rankIcons'][0]['sha256']='0'*64
        value=self.build()
        self.assertTrue(value['capabilities']['conditions'])
        self.assertEqual(value['rankIcons'],[])
        self.assertIn('rank_icons_unavailable',value['limitations'])

    def test_private_review_is_pinned_and_not_a_raw_master_fallback(self):
        source = {"region": "global", "contentReleaseId": "test"}
        self.assertIsNone(read_arena_review(source, self.root))
        raw = json.dumps(self.review).encode()
        path = self.root / "review.json"; path.write_bytes(raw)
        source["arenaReview"] = {"path": "review.json", "sha256": hashlib.sha256(raw).hexdigest()}
        self.assertEqual(read_arena_review(source, self.root), self.review)
        path.write_bytes(b"{}")
        self.assertRaises(ValueError, read_arena_review, source, self.root)
        source["arenaReview"]["path"] = "../escape.json"
        self.assertRaises(ValueError, read_arena_review, source, self.root)

    def trend(self):
        return {"source": "ArenaService.DeckTrend", "serverId": "global-hmt", "seasonId": "1", "bandId": "2", "musicId": 100001,
            "observedAt": "2026-10-28T00:00:00Z", "response": {"leaders": [{"memberCardId": 1}],
            "members": [{"memberCardId": 2, "internalNote": "never-publish", "useRate": 0.8}], "supports": [{"supportCardId": 3}]}, "internalNote": "never-publish"}

    def test_official_trend_is_scoped_whitelisted_and_separate_from_conditions(self):
        base = self.build()
        self.review["deckTrends"] = [self.trend()]
        data = self.build()
        self.assertTrue(data["capabilities"]["deckTrends"])
        self.assertEqual(data["deckTrends"][0]["leaders"], ["1"])
        self.assertEqual(data["deckTrends"][0]["supports"], ["3"])
        self.assertNotIn("internalNote", json.dumps(data)); self.assertNotIn("useRate", json.dumps(data))
        self.assertEqual(base["sourceRevision"], data["sourceRevision"])
        validate_arena_publication(data, "test", "global")
        data["deckTrends"][0]["internalNote"] = "forbidden"
        self.assertRaises(ValueError, validate_arena_publication, data, "test", "global")

    def test_trend_selects_latest_whole_response_and_preserves_official_order(self):
        older = self.trend(); newer = copy.deepcopy(older)
        newer["observedAt"] = "2026-10-28T01:00:00Z"; newer["response"]["members"] = [{"memberCardId": 4}, {"memberCardId": 2}]
        self.review["deckTrends"] = [newer, older]
        data = self.build(); self.assertEqual(len(data["deckTrends"]), 1)
        self.assertEqual(data["deckTrends"][0]["members"], ["4", "2"])
        validate_arena_publication(data, "test", "global")

    def test_unverified_trend_does_not_break_other_information(self):
        for field, value in (("source", "unknown"), ("serverId", "jp"), ("seasonId", "unknown"), ("observedAt", "2026-10-28 00:00:00")):
            observation = self.trend(); observation[field] = value
            self.review["deckTrends"] = [observation]; data = self.build()
            self.assertFalse(data["capabilities"]["deckTrends"]); self.assertTrue(data["capabilities"]["conditions"])
            self.assertTrue(data["capabilities"]["basePoints"])
        observation = self.trend(); other = copy.deepcopy(observation); other["response"]["leaders"] = []
        self.review["deckTrends"] = [observation, other]
        self.assertFalse(self.build()["capabilities"]["deckTrends"])

    def test_verified_empty_response_is_distinct_from_missing_observation(self):
        observation = self.trend(); observation["response"] = {"leaders": [], "members": [], "supports": []}
        self.review["deckTrends"] = [observation]
        self.assertTrue(self.build()["capabilities"]["deckTrends"])
        self.assertEqual(self.build()["deckTrends"][0]["members"], [])
