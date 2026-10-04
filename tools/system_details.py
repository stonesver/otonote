"""Player-facing projections shared by missions, recruitment and practice."""
from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

from tools.resource_pipeline.localization import resolve_localized_text
from tools.card_taxonomy import ATTRIBUTE_DEFINITIONS


def optional_rows(root: Path, name: str) -> list[dict]:
    path = root / f"{name}.json"
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("_allData"), list):
        raise ValueError(f"Invalid Master table: {name}")
    return data["_allData"]


def configured_time(value):
    return None if value is None or str(value).strip().lower() in ("", "null") else value


class SystemContext:
    def __init__(self, root: Path, locale: str):
        self.root, self.locale = root, locale
        self.en = locale == "en"
        self.tables = {}
        self.texts = {r["_id"]: r for r in self.rows("MasterText")}

    def rows(self, name):
        if name not in self.tables:
            self.tables[name] = optional_rows(self.root, name)
        return self.tables[name]

    def text(self, key, fallback=""):
        return resolve_localized_text(self.texts.get(key), self.locale, fallback).text

    def entity(self, table, identity):
        return next((r for r in self.rows(table) if r["_id"] == identity), {})

    def name(self, table, identity, fallback):
        row = self.entity(table, identity)
        key = next((row[k] for k in ("_nameTextId", "_nameTextID", "_titleTextID", "_descriptionTextId") if row.get(k)), "")
        return self.text(key, fallback)

    def reward(self, row):
        kind, identity = row.get("_resourceType", 1), row.get("_resourceId", 0)
        # App.Protobuf.Entity.ResourceType: Music=8, Degree=17, Background=18, Spot=19.
        table = {1: "MasterItem", 2: "MasterMemberCard", 3: "MasterSupportCard", 8: "MasterLiveMusic",
                 17: "MasterDegree", 18: "MasterBackground", 19: "MasterHomeSpot"}.get(kind)
        item = self.entity(table, identity) if table else {}
        image_path = item.get("_imagePath") or item.get("_thumbnailAssetPath") or None
        if kind == 8 and item.get("_jacketAssetName"):
            image_path = f"Image/Jacket/{item['_jacketAssetName']}"
        return {"resourceType": kind, "resourceId": identity,
                "itemType": item.get("_type") if kind == 1 else None,
                "count": row.get("_resourceCount", row.get("_amount", 1)),
                "name": self.name(table, identity, f"{'Reward' if self.en else '奖励'} #{identity}") if table else f"{'Reward' if self.en else '奖励'} #{identity}",
                "imagePath": image_path}


# Verified against App.Master.MissionCategory in the production v39 metadata.
CATEGORIES = {1: ("daily", "每日", "Daily"), 2: ("limited", "限时", "Limited"),
              3: ("event", "活动", "Event"), 4: ("permanent", "常驻", "Permanent"),
              5: ("beginner", "新手", "Beginner"), 6: ("comeback", "回归", "Comeback"),
              7: ("character", "角色", "Character"), 8: ("invitation", "邀请", "Invitation"),
              9: ("secret", "隐藏", "Hidden"), 10: ("event", "活动每日", "Event daily"),
              11: ("circle", "社群", "Circle"), 12: ("circle", "社群每日", "Circle daily"),
              13: ("event", "活动社群", "Event circle"), 14: ("event", "活动社群每日", "Event circle daily"),
              15: ("music", "乐曲解锁", "Song unlock"), 16: ("home", "主页解锁", "Home unlock")}


def build_missions(ctx: SystemContext):
    rewards = {r["_id"]: r for r in ctx.rows("MasterMissionReward")}
    groups = {}
    sources = [("MasterMission", None), ("MasterLimitedMission", None),
               ("MasterEventMission", 3), ("MasterCharacterMission", 7),
               ("MasterSeasonPassMission", None), ("MasterCircleMission", 11),
               ("MasterInvitationMission", 8)]
    for table, default_category in sources:
        for row in ctx.rows(table):
            parent = {}
            if table == "MasterLimitedMission":
                parent = ctx.entity("MasterLimitedMissionGroup", row.get("_limitedMissionGroupId"))
            elif table == "MasterEventMission":
                parent = ctx.entity("MasterEvent", row.get("_eventId"))
            elif table == "MasterSeasonPassMission":
                parent = ctx.entity("MasterSeasonPass", row.get("_seasonPassId"))
            code = row.get("_missionCategory", parent.get("_missionCategory", default_category))
            cat, zh, en = CATEGORIES.get(code, ("other", "其他", "Other"))
            category_label = en if ctx.en else zh
            if table == "MasterSeasonPassMission":
                cat = "pass"
                category_label = "Pass" if ctx.en else "通行证"
            parent_name = ctx.text(parent.get("_nameTextID", parent.get("_nameTextId")), category_label)
            replacements = {"AchievementCount": str(row.get("_achievementCount", 0)),
                            "Value": str(row.get("_value", 0)), "BandRank": str(row.get("_bandRank", 0)),
                            "MissionCategory": (en if ctx.en else zh),
                            "ScoreRank": {0: "—", 1: "E", 2: "D", 3: "C", 4: "B", 5: "A", 6: "S", 7: "SS"}.get(row.get("_scoreRank"), "—"),
                            "MusicDifficulty": {0: "EASY", 1: "NORMAL", 2: "HARD", 3: "EXPERT", 4: "MASTER"}.get(row.get("_musicDifficulty"), "—"),
                            "CardType": next((a["names"].get(ctx.locale, a["names"]["en"]) for a in ATTRIBUTE_DEFINITIONS
                                              if a["code"] == row.get("_cardType")), "任意属性" if not ctx.en else "any attribute")}
            related = []
            for placeholder, field, entity_table, generic, route in [
                ("CharacterId", "_characterId", "MasterCharacter", "该角色" if not ctx.en else "this character", "/characters/character-"),
                ("BandId", "_bandId", "MasterBand", "指定乐队" if not ctx.en else "the band", ""),
                ("MusicId", "_musicId", "MasterLiveMusic", "指定歌曲" if not ctx.en else "the song", "/music/music-"),
                ("StoryChapterId", "_storyChapterId", "MasterStoryChapter", "指定章节" if not ctx.en else "the chapter", ""),
                ("EpisodeId", "_episodeId", "MasterStoryEpisode", "指定剧情" if not ctx.en else "the episode", ""),
                ("ExchangeId", "_exchangeId", "MasterExchange", "交换所" if not ctx.en else "Exchange", "")]:
                identity = row.get(field, 0)
                replacements[placeholder] = ctx.name(entity_table, identity, generic) if identity else generic
                if identity and route:
                    related.append({"name": replacements[placeholder], "href": f"{route}{identity}/"})
            episode = ctx.entity("MasterStoryEpisode", row.get("_episodeId"))
            replacements["EpisodeId.Value"] = str(episode.get("_episodeNumber", row.get("_episodeId", 0)))
            template = ctx.text(row.get("_descriptionTextId"), "")
            unresolved = [x for x in re.findall(r"\{([^}]+)\}", template) if x not in replacements]
            description = re.sub(r"\{([^}]+)\}", lambda m: replacements.get(m[1], "—"), template)
            if not description or unresolved:
                description = "Condition details unavailable" if ctx.en else "任务条件详情暂未收录"
            # Group by player-facing programme first, not individual task IDs.
            # Every original task, condition and reward remains in the group's stages.
            title = parent_name
            key_data = [table, parent.get("_id"), code, row.get("_startAt"), row.get("_endAt")]
            if parent:
                if table == "MasterSeasonPassMission":
                    title = f"{parent_name} · {en if ctx.en else zh}"
            elif cat == "daily":
                title = "Daily missions" if ctx.en else "每日任务"
            elif row.get("_storyChapterId"):
                key_data.append(row["_storyChapterId"])
                title = replacements["StoryChapterId"]
            elif cat == "secret":
                key_data.append(row.get("_descriptionTextId"))
                title = ({"Mission_Description_ScoreRankCharacter": "角色编队评级挑战",
                          "Mission_Description_LiveClearMusic": "指定乐曲演出挑战"}.get(row.get("_descriptionTextId"), "隐藏任务")
                         if not ctx.en else "Character formation challenges" if row.get("_missionType") == 122 else "Song completion challenges")
            else:
                key_data += [row.get("_missionType"), row.get("_descriptionTextId"), row.get("_characterId"),
                             row.get("_bandId"), row.get("_musicId"), row.get("_cardType")]
                title = ctx.text(row.get("_titleTextId"), "") or ctx.text(
                    str(row.get("_descriptionTextId", "")).replace("Mission_Description_", "Mission_Name_"), "")
                title = re.sub(r"\{([^}]+)\}", lambda m: replacements.get(m[1], "—"), title)
                if not title:
                    title = description
                if not ctx.en:
                    title = {"Mission_Description_BandRank": f"{replacements['BandId']} · 乐队等级",
                             "Mission_Description_PlayerRank": "玩家等级成长",
                             "Mission_Description_BandEvaluation": f"{replacements['BandId']} · 乐队评分"}.get(row.get("_descriptionTextId"), title)
            key = json.dumps(key_data)
            missing_complete = set(parent.get("_completeRewardIds", [])) - rewards.keys()
            if missing_complete:
                raise ValueError(f"{table} {row['_id']} references missing completion rewards: {sorted(missing_complete)}")
            if key not in groups:
                groups[key] = {"id": f"{table}-{row['_id']}", "category": cat, "categoryLabel": category_label,
                               "groupName": parent_name, "title": title, "description": description, "stages": [],
                               "releaseDay": row.get("_releaseDay", 0), "related": related,
                               "startAt": configured_time(parent.get("_startAt")) or configured_time(row.get("_startAt")),
                               "endAt": configured_time(parent.get("_endAt")) or configured_time(row.get("_endAt")),
                               "completeRewards": [ctx.reward(rewards[i]) for i in parent.get("_completeRewardIds", []) if i in rewards],
                               "sourceTable": table, "isCharacterTemplate": table == "MasterCharacterMission"}
                groups[key]["bannerAsset"] = parent.get("_bannerAsset") or None
                groups[key]["bandId"] = row.get("_bandId") or ctx.entity("MasterStoryChapter", row.get("_storyChapterId")).get("_bandId") or None
            reward_ids = row.get("_missionRewardIds", [])
            missing = set(reward_ids) - rewards.keys()
            if missing:
                raise ValueError(f"{table} {row['_id']} references missing mission rewards: {sorted(missing)}")
            stage_rewards = [ctx.reward(rewards[i]) for i in reward_ids]
            if row.get("_seasonPassPoint"):
                stage_rewards.append({"resourceType": 0, "resourceId": 0, "count": row["_seasonPassPoint"],
                                      "name": "Pass points" if ctx.en else "通行证积分", "imagePath": None})
            groups[key]["stages"].append({"id": row["_id"], "description": description,
                                         "releaseDay": row.get("_releaseDay", 0), "priority": row.get("_priority", 0),
                                         "related": related, "target": row.get("_achievementCount", 0), "rewards": stage_rewards})
    # Keep fine-grained objectives inside broad permanent collections.
    collections = {}
    for group in groups.values():
        bucket = None
        if group["category"] == "permanent":
            first = ctx.entity(group["sourceTable"], group["stages"][0]["id"])
            bucket = "story" if first.get("_storyChapterId") else "performance" if first.get("_missionType") == 124 else "growth"
        elif group["category"] == "character": bucket = "growth"
        elif group["category"] == "secret": bucket = "secret"
        elif group["category"] in ("music", "home"): bucket = "unlocks"
        key = (bucket, group["endAt"]) if bucket else (group["id"],)
        if key not in collections:
            titles = {"story": ("剧情阅读", "Story reading"), "growth": ("综合养成", "Growth & training"),
                      "performance": ("演出挑战", "Performance challenges"), "unlocks": ("乐曲与场景解锁", "Song & scene unlocks"),
                      "secret": ("隐藏任务", "Hidden missions")}
            collections[key] = {**group, "stages": [], "sections": [], "isCharacterTemplate": False,
                                "category": "permanent" if bucket and bucket != "secret" else group["category"],
                                "categoryLabel": ("Permanent" if ctx.en else "常驻") if bucket and bucket != "secret" else group["categoryLabel"],
                                "title": titles[bucket][int(ctx.en)] if bucket else group["title"],
                                "bandId": None if bucket else group["bandId"],
                                "id": f"collection-{bucket}-{group['id']}" if bucket else group["id"]}
        collection = collections[key]
        starts = [value for value in (collection["startAt"], group["startAt"]) if value]
        collection["startAt"] = min(starts, key=lambda value: tuple(map(int, re.findall(r"\d+", value)))) if starts else None
        section = {"id": group["id"], "title": group["title"], "taskCount": len(group["stages"]),
                   "isCharacterTemplate": group["isCharacterTemplate"], "categoryLabel": group["categoryLabel"],
                   "startAt": group["startAt"], "endAt": group["endAt"]}
        # Unlock groups otherwise have identical titles for music and home conditions.
        if bucket == "unlocks": section["title"] = f"{group['categoryLabel']} · {group['title']}"
        collection["sections"].append(section)
        collection["stages"].extend({**stage, "sectionId": group["id"],
                                     "isCharacterTemplate": group["isCharacterTemplate"]} for stage in group["stages"])
    for group in collections.values():
        group["stages"].sort(key=lambda s: (s["releaseDay"], s["priority"], s["target"], s["id"]))
        group["description"] = group["stages"][0]["description"]
        group["rewardNames"] = list(dict.fromkeys(r["name"] for s in group["stages"] for r in s["rewards"]))
        preview = {}
        # Character templates apply per character, so do not add them to shared reward totals.
        for reward in group["completeRewards"] + [r for s in group["stages"] if not s["isCharacterTemplate"] for r in s["rewards"]]:
            key = (reward["resourceType"], reward["resourceId"])
            if key not in preview:
                preview[key] = dict(reward)
            else:
                preview[key]["count"] += reward["count"]
        def reward_priority(reward):
            if reward.get("itemType") in (12, 13): return 0
            if reward["resourceType"] in (2, 3): return 1
            if reward.get("itemType") == 2: return 2
            return 3
        group["previewRewards"] = sorted(preview.values(), key=reward_priority)[:4]
        group["rewardKindCount"] = len(preview)
    order = {key: index for index, key in enumerate(["limited", "event", "daily", "beginner", "pass", "permanent", "music", "home", "character", "secret"])}
    return sorted(collections.values(), key=lambda group: order.get(group["category"], 99))


def enrich_systems(result, root, locale):
    ctx = SystemContext(root, locale)
    result["missions"] = build_missions(ctx)
    lots = defaultdict(list)
    prizes = defaultdict(list)
    for row in ctx.rows("MasterGachaLot"):
        lots[row["_lotGroupId"]].append(row)
    for row in ctx.rows("MasterGachaPrize"):
        prizes[row["_groupId"]].append(row)
    # Keep exact prize identities: the display list below intentionally merges
    # duplicate rewards across groups, while account history refers to _id.
    result["gachaHistoryPrizes"] = [
        {"id": row["_id"], "resourceType": row["_resourceType"], "resourceId": row["_resourceId"],
         "groupId": row["_groupId"], "isPickup": row.get("_pickUpType") == 2}
        for row in ctx.rows("MasterGachaPrize") if row.get("_id")
    ]
    for pool in result["gachaPools"]:
        row = ctx.entity("MasterGacha", pool["id"])
        pool["startAt"], pool["endAt"] = configured_time(pool["startAt"]), configured_time(pool["endAt"])
        pool["description"] = ctx.text(row.get("_descriptionTextId"))
        pool["categories"] = []
        product_rows = [ctx.entity("MasterGachaProduct", p["id"]) for p in pool["products"]]
        # Classification uses explicit published copy and consumption types; isLimited is a separate card-exclusivity flag.
        searchable = " ".join([pool["name"], pool["description"]]).lower()
        if re.search(r"生日|birthday|バースデー|誕生日", searchable): pool["categories"].append("birthday")
        if row.get("_warningTextId") == "gacha_warning_event" or row.get("_eventId"):
            pool["categories"].append("event")
        for item_type, category in [(2, "ticket"), (23, "pass"), (15, "ad")]:
            if any(p.get("_itemType") == item_type for p in product_rows): pool["categories"].append(category)
        if pool["endAt"]: pool["categories"].append("limited")
        elif not pool["categories"] and not pool["isLimited"]: pool["categories"].append("permanent")
        # Omit the property entirely when no explicit rerun evidence exists.
        if row.get("_isRerun") is True: pool["isRerun"] = True
        elif row.get("_isRerun") is False: pool["isRerun"] = False
        for product, raw in zip(pool["products"], product_rows):
            item = (ctx.entity("MasterItem", row.get("_gachaTicketItemId")) if raw.get("_itemType") == 2
                    else next((i for i in ctx.rows("MasterItem") if i.get("_type") == raw.get("_itemType")), {}))
            product.update({"costName": ctx.text(item.get("_nameTextId"), {23: "通行证", 24: "TGW 免费次数"}.get(raw.get("_itemType"), "—")),
                            "ensuredCount": raw.get("_ensuredCount", 0), "ensuredRarity": raw.get("_ensuredRarity", 0),
                            "ensuredType": raw.get("_ensuredType", 0), "limitCount": raw.get("_limitConsumeCount", 0),
                            "resetType": raw.get("_resetType", 0), "firstTimePrice": raw.get("_firstTimePrice", 0)})
        pool_lots = lots[row["_lotGroupId"]]
        total = sum(lot.get("_weight", 0) for lot in pool_lots)
        pool["probabilityGroups"] = [{"rarity": lot.get("_rarityConstraint", 0),
                                      "resourceType": (prizes[lot["_prizeGroupId"]][0].get("_resourceType", 0)
                                                       if prizes[lot["_prizeGroupId"]] else lot.get("_resourceTypeConstraint", 0)),
                                      "prizeGroupId": lot["_prizeGroupId"],
                                      "percent": lot.get("_weight", 0) / total * 100 if total else None}
                                     for lot in pool_lots]
        pool["prizes"] = []
        seen = set()
        for lot in pool_lots:
            for prize in prizes[lot["_prizeGroupId"]]:
                key = (prize.get("_resourceType"), prize.get("_resourceId"))
                if key in seen: continue
                seen.add(key)
                pool["prizes"].append({**ctx.reward(prize), "isPickup": prize.get("_pickUpType") == 2,
                                       "fixedRateBasisPoints": prize.get("_pickUpFixedRate", 0),
                                       "addedRateBasisPoints": prize.get("_pickUpAddedRate", 0),
                                       "startAt": configured_time(prize.get("_startAt")),
                                       "endAt": configured_time(prize.get("_endAt"))})
        pool["probabilityStatus"] = "master_weights_only"
    for rank in result["vipRanks"]:
        rank["productsPrice"] = ctx.entity("MasterVip", rank["rank"]).get("_productsPrice", 0)
        rank["rankUpRewards"] = [ctx.reward(r) for r in ctx.rows("MasterVipRankUpReward") if r["_vipRank"] == rank["rank"]]
        rank["dailyRewards"] = [{**ctx.reward(r), "day": r["_day"]} for r in ctx.rows("MasterVipDailyReward") if r["_vipRank"] == rank["rank"]]
    for unit in result["studioUnits"]:
        unit["name"] = ctx.name("MasterBand", unit["bandId"], unit["name"])
        unit["itemRewards"] = {}
        for level in unit["levels"]:
            source = next(r for r in ctx.rows("MasterOfflineBonusUnitLevel")
                          if r["_offlineBonusUnitId"] == unit["id"] and r["_offlineBonusLevel"] == level["level"])
            level["itemDraws"] = source.get("_earnItemLot", 0)
            group_id = level["itemLotGroupId"]
            if str(group_id) not in unit["itemRewards"]:
                group = [r for r in ctx.rows("MasterOfflineBonusItemLot") if r["_groupId"] == group_id]
                total = sum(r["_weight"] for r in group)
                unit["itemRewards"][str(group_id)] = [{**ctx.reward(r), "percent": r["_weight"] / total * 100 if total else None} for r in group]
    result["studioExpFactors"] = [{"bandRank": r["_bandRank"], "factor": r["_expFactor"] / 10000}
                                  for r in ctx.rows("MasterOfflineBonusExpFactor")]
    existing = {r["table"] for r in result["evidence"]}
    result["evidence"].extend({"table": name, "rowCount": len(rows)} for name, rows in ctx.tables.items() if name not in existing)
    return result
