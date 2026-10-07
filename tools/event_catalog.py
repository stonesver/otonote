"""Project event configuration from a single edition/release, never live rankings.

The JP 1.0.5 metadata verifies EventType, EventBonusType and resource enums.
Naive Master timestamps and bonus integers stay raw: no timezone or score
multiplier is invented by this archive adapter.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from tools.resource_pipeline.localization import resolve_localized_text
from tools.event_relations import build_event_relations

EVENT_TABLES = (
    "MasterEvent", "MasterEventAchievementReward", "MasterEventAchievementLoopReward",
    "MasterEventRankingReward", "MasterEventEffect", "MasterEventPickUpCard",
    "MasterEventBoxGacha", "MasterEventBoxGachaReward", "MasterEventMission",
    "MasterLiveEventPoint", "MasterLiveEventReward", "MasterChallengeLiveEventPoint",
    "MasterChallengeLiveEventReward", "MasterChallengeMusic", "MasterChallengeMusicRankingReward",
    "MasterChallengeMusicBoostBonus", "MasterLiveChallengePoint",
)
RESOURCE_TABLES = {1: "MasterItem", 2: "MasterMemberCard", 3: "MasterSupportCard",
                   8: "MasterLiveMusic", 9: "MasterStamp", 17: "MasterDegree"}
BONUS_TYPES = {0: "EventPoint", 1: "EventItem", 2: "ParameterAll",
               3: "ParameterPfm", 4: "ParameterTec", 5: "ParameterVis"}
SCORE_RANKS = {0: "None", 1: "E", 2: "D", 3: "C", 4: "B", 5: "A", 6: "S", 7: "SS"}


class EventCatalogError(ValueError):
    pass


def configured_time(value):
    return None if value is None or str(value).strip().lower() in ("", "null") else str(value)


class EventSource:
    def __init__(self, root: Path, locale: str):
        self.root, self.locale = root, locale
        self.tables, self.indexes, self.evidence = {}, {}, {}
        self.warnings = set()

    def rows(self, table):
        if table not in self.tables:
            path = self.root / f"{table}.json"
            if not path.is_file():
                self.warnings.add(f"missing_table:{table}")
                self.tables[table] = []
                self.evidence[table] = {"table": table, "rowCount": 0, "status": "missing"}
            else:
                raw = path.read_bytes()
                try:
                    document = json.loads(raw)
                except (ValueError, UnicodeError) as exc:
                    raise EventCatalogError(f"invalid JSON: {table}") from exc
                rows = document.get("_allData") if isinstance(document, dict) else None
                if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                    raise EventCatalogError(f"{table} requires an _allData array of objects")
                ids = [row.get("_id") for row in rows]
                if any(type(i) not in (int, str) for i in ids) or len(set(ids)) != len(ids):
                    raise EventCatalogError(f"invalid or duplicate IDs: {table}")
                self.tables[table] = rows
                self.evidence[table] = {"table": table, "rowCount": len(rows), "status": "available",
                                        "sha256": hashlib.sha256(raw).hexdigest()}
            self.indexes[table] = {row["_id"]: row for row in self.tables[table]}
        return self.tables[table]

    def entity(self, table, identity):
        self.rows(table)
        row = self.indexes[table].get(identity)
        if row is None:
            self.warnings.add(f"missing_reference:{table}:{identity}")
        return row or {}

    def text(self, identity, fallback):
        row = self.entity("MasterText", identity) if identity else {}
        return resolve_localized_text(row, self.locale, fallback,
                                      fallback_order=("ja", "en", "zh-CN", "zh-TW"))

    def name(self, table, identity):
        row = self.entity(table, identity)
        key = next((row[k] for k in ("_nameTextId", "_nameTextID", "_titleTextID", "_descriptionTextId")
                    if row.get(k)), None)
        return self.text(key, f"{table.removeprefix('Master')} #{identity}").text

    def resource(self, row):
        kind, identity = row.get("_resourceType"), row.get("_resourceId")
        table = RESOURCE_TABLES.get(kind)
        item = self.entity(table, identity) if table else {}
        name = self.name(table, identity) if table else f"Resource {kind}:{identity}"
        subtitle = item.get("_subtitleTextID") if kind == 2 else item.get("_descriptionTextID") if kind == 3 else None
        if subtitle:
            name = f"{name} · {self.text(subtitle, subtitle).text}"
        return {"resourceType": kind, "resourceId": identity,
                "count": row.get("_resourceCount"), "name": name,
                "resolved": bool(item), "rarity": item.get("_rarity"), "imagePath": item.get("_imagePath")}

    def rewards(self, row):
        result = []
        for identity in row.get("_rewardIds", []):
            reward = self.entity("MasterReward", identity)
            if reward:
                result.append({"rewardId": identity, **self.resource(reward)})
            else:
                result.append({"rewardId": identity, "resourceType": None, "resourceId": None,
                               "count": None, "name": f"Reward #{identity}", "resolved": False, "rarity": None})
        return result


def build_event_archive(root: Path, release_id: str, *, edition: str | None, locale="zh-CN") -> dict:
    source = EventSource(root, locale)
    definitions = source.rows("MasterEvent")
    if source.evidence["MasterEvent"]["status"] == "missing":
        raise EventCatalogError("missing MasterEvent")
    if definitions and edition not in ("jp", "global"):
        raise EventCatalogError("nonempty event data requires explicit jp/global edition")
    tables = {name: source.rows(name) for name in EVENT_TABLES}
    identifiers = {r["_id"] for r in definitions}
    orphans = [r for rows in tables.values() for r in rows
               if "_eventId" in r and r["_eventId"] not in identifiers]
    if orphans:
        source.warnings.add(f"orphan_event_rows:{len(orphans)}")
    records = []
    for row in sorted(definitions, key=lambda r: r["_id"]):
        identity = row["_id"]
        if type(identity) is not int or identity <= 0:
            raise EventCatalogError("event IDs must be positive integers")
        related = lambda table: [r for r in tables[table] if r.get("_eventId") == identity]
        title = source.text(row.get("_nameTextId"), f"Event #{identity}")
        achievements = [{"id": r["_id"], "points": r.get("_eventPoint"), "rewards": source.rewards(r)}
                        for r in related("MasterEventAchievementReward")]
        achievements.sort(key=lambda r: (r["points"] is None, r["points"] or 0, r["id"]))
        loops = [{"id": r["_id"], "startPoints": r.get("_loopStartEventPoint"),
                  "intervalPoints": r.get("_loopEventPoint"), "rewards": source.rewards(r)}
                 for r in related("MasterEventAchievementLoopReward")]
        effects = []
        for r in related("MasterEventEffect"):
            targets = []
            for field, table in (("_memberCardId", "MasterMemberCard"), ("_supportCardId", "MasterSupportCard"),
                                 ("_characterId", "MasterCharacter"), ("_bandId", "MasterBand")):
                if r.get(field):
                    kind = 2 if field == "_memberCardId" else 3 if field == "_supportCardId" else None
                    targets.append(source.resource({"_resourceType": kind, "_resourceId": r[field]})["name"]
                                   if kind else source.name(table, r[field]))
            effects.append({"id": r["_id"], "bonusType": r.get("_eventBonusType"),
                            "bonusKind": BONUS_TYPES.get(r.get("_eventBonusType"), "unknown"),
                            "targetNames": targets, "constraints": {k.removeprefix('_'): r.get(k) for k in
                                ("_resourceTypeConstraint", "_characterId", "_bandId", "_cardType", "_tagId", "_memberCardId", "_supportCardId")},
                            "rankValues": [r.get(f"_rank{i}EffectValue") for i in range(1, 6)],
                            "valueUnit": "raw_master_integer"})
        ranking_rewards = lambda rows: [{"id": r["_id"], "rankStart": r.get("_rankStart"),
                                         "rankEnd": r.get("_rankEnd"), "rewards": source.rewards(r)} for r in rows]
        challenge = []
        for r in related("MasterChallengeMusic"):
            group = r.get("_rankingRewardGroup")
            challenge.append({"id": r["_id"], "musicId": r.get("_liveMusicId"),
                              "name": source.name("MasterLiveMusic", r.get("_liveMusicId")),
                              "attributeCode": r.get("_musicType"),
                              "gekisouMissionTypes": [r.get(f"_gekisouMission{i}") for i in range(1, 4)],
                              # The source schema really spells this field _stratAt.
                              "startAt": configured_time(r.get("_startAt") or r.get("_stratAt")),
                              "endAt": configured_time(r.get("_endAt")), "rankingRewardGroup": group,
                              "rankingRewards": ranking_rewards([a for a in tables["MasterChallengeMusicRankingReward"]
                                                                  if group and a.get("_group") == group])})
        point_rules = {}
        for mode, prefix in (("normal", "Live"), ("challenge", "ChallengeLive")):
            field = prefix[0].lower() + prefix[1:]
            points_group, reward_group = row.get(f"_{field}EventPointGroup"), row.get(f"_{field}EventRewardGroup")
            point_rules[mode] = {
                "pointGroup": points_group, "rewardGroup": reward_group,
                "points": [{"scoreRank": r.get("_scoreRank"), "scoreRankLabel": SCORE_RANKS.get(r.get("_scoreRank"), "?"),
                            "value": r.get("_value")} for r in tables[f"Master{prefix}EventPoint"]
                           if points_group and r.get("_group") == points_group],
                # Reward grouping uses _eventGroup, not _group (verified against JP rows).
                "rewards": [{"scoreRank": r.get("_scoreRank"), "scoreRankLabel": SCORE_RANKS.get(r.get("_scoreRank"), "?"),
                             "group": r.get("_group"), "probabilityRaw": r.get("_probability"), "reward": source.resource(r)}
                            for r in tables[f"Master{prefix}EventReward"] if reward_group and r.get("_eventGroup") == reward_group],
            }
        chapter_id = row.get("_storyChapterId")
        chapter = source.entity("MasterStoryChapter", chapter_id) if chapter_id else {}
        episodes = [{"id": r["_id"], "number": r.get("_episodeNumber"),
                     "name": source.text(source.entity("MasterAdv", r.get("_advId")).get("_titleTextId"), f"Episode #{r['_id']}").text,
                     "description": source.text(r.get("_descriptionTextId"), "").text,
                     "requiredPoints": r.get("_eventPoint"), "advId": r.get("_advId"),
                     "isAnotherEpisode": r.get("_isAnotherEpisode") is True,
                     "isExtraEpisode": r.get("_isExtraEpisode") is True}
                    for r in source.rows("MasterStoryEpisode") if chapter and r.get("_chapterId") == chapter_id]
        shops = []
        event_item = row.get("_eventItemId")
        for shop in source.rows("MasterExchange"):
            # Explicit currency relation; do not infer an event association from names/dates.
            if not event_item or (shop.get("_paymentResourceType"), shop.get("_paymentResourceId")) != (1, event_item):
                continue
            products = [{"id": p["_id"], "reward": source.resource(p), "cost": p.get("_paymentResourceCount"),
                         "limit": p.get("_limitCount"), "resetType": p.get("_resetType"),
                         "paymentSteps": p.get("_paymentSteps", []), "paymentStepResourceCounts": p.get("_paymentStepResourceCounts", []),
                         "startAt": configured_time(p.get("_startAt")), "endAt": configured_time(p.get("_endAt"))}
                        for p in source.rows("MasterExchangeProduct") if p.get("_exchangeId") == shop["_id"]]
            shops.append({"id": shop["_id"], "name": source.name("MasterExchange", shop["_id"]),
                          "relation": "event_currency", "startAt": configured_time(shop.get("_startAt")),
                          "endAt": configured_time(shop.get("_endAt")), "products": products})
        flags = {name: not row[field] if type(row.get(field)) is bool else None for name, field in
                 (("eventPoints", "_isRankingDisabled"), ("music", "_isMusicRankingDisabled"), ("totalMusic", "_isTotalMusicRankingDisabled"))}
        records.append({"id": identity, "edition": edition, "sourceReleaseId": release_id,
                        "name": title.text, "nameLocale": title.actual_locale,
                        "eventType": row.get("_eventType"),
                        "mode": "challenge_live" if row.get("_eventType") == 1 else "unknown",
                        "schedule": {"startAt": configured_time(row.get("_startAt")), "endAt": configured_time(row.get("_endAt")),
                                     "displayEndAt": configured_time(row.get("_displayEndAt")),
                                     "timeZone": None, "status": "master_configuration"},
                        "assets": {k: row.get(f"_{k}Asset") or None for k in ("image", "logo", "background", "banner")},
                        "achievements": achievements, "loopRewards": loops, "effects": effects,
                        "related": build_event_relations(source, row, effects),
                        "pickupCards": [source.resource(r) for r in related("MasterEventPickUpCard")],
                        "challengeSongs": challenge, "pointRules": point_rules,
                        "challengeRules": {
                            "consumptionOptions": [{"cost": r.get("_consumedChallengePointCount"),
                                "pointRate": r.get("_eventPointRate"), "rewardRate": r.get("_liveMusicRewardRate")}
                                for r in tables["MasterChallengeMusicBoostBonus"]],
                            "normalLiveChallengePoints": [{"scoreRank": r.get("_scoreRank"),
                                "scoreRankLabel": SCORE_RANKS.get(r.get("_scoreRank"), "?"), "value": r.get("_value")}
                                for r in tables["MasterLiveChallengePoint"]]},
                        "story": {"chapterId": chapter_id, "name": source.name("MasterStoryChapter", chapter_id) if chapter else None,
                                  "bandId": chapter.get("_bandId") or None,
                                  "characterIds": chapter.get("_mainCharacterIds", []),
                                  "episodes": episodes}, "exchanges": shops,
                        "eventItem": source.resource({"_resourceType": 1, "_resourceId": event_item}) if event_item else None,
                        "ranking": {"configured": flags, "liveDataStatus": "not_collected", "rewards": ranking_rewards(related("MasterEventRankingReward"))},
                        "boxGachaStatus": "unparsed_configuration" if related("MasterEventBoxGacha") else "no_configuration",
                        "missionCount": len(related("MasterEventMission"))})
    return {"schemaVersion": 1, "sourceReleaseId": release_id, "edition": edition,
            "definitionCount": len(definitions), "instanceRoutesEnabled": bool(definitions),
            "orphanAuxiliaryRowCount": len(orphans), "records": records,
            "capabilities": {"hasStory": any(r["story"]["episodes"] for r in records),
                             "hasMode": any(r["mode"] != "unknown" for r in records),
                             "hasRewards": any(r["achievements"] or r["loopRewards"] or r["exchanges"] or r["ranking"]["rewards"]
                                               or any(s["rankingRewards"] for s in r["challengeSongs"]) for r in records),
                             "hasRanking": False},
            "evidence": list(source.evidence.values()), "warnings": sorted(source.warnings),
            "status": "definitions_available" if records else "reserved_no_definitions"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--master-root", type=Path, required=True)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--edition", choices=("jp", "global"), required=True)
    parser.add_argument("--locale", default="zh-CN")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    archive = build_event_archive(args.master_root, args.release_id, edition=args.edition, locale=args.locale)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(archive, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"events": archive["definitionCount"], "warnings": archive["warnings"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
