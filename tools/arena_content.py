"""Whitelist projection of reviewed, publishable Arena Master rows.

A review binds table bytes and explicitly enumerates public rows. Missing review,
unknown time semantics and unknown reward links fail closed, independently.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from tools.resource_pipeline.localization import resolve_localized_text
from tools.arena_trends import validate_public_trends
from tools.arena_assets import project_rank_icons, validate_rank_icons

TABLES = ("MasterArenaSeason", "MasterArenaLeague", "MasterArenaLeagueRegulation",
          "MasterArenaRank", "MasterBattleLivePlace", "MasterLiveArenaReward",
          "MasterLiveArenaRankReward", "MasterArenaSeasonReward", "MasterText", "MasterItem", "MasterEvent")
SERVERS = {"global": {"global-hmt", "global-kr", "global-en"}, "jp": {"jp"}}


def arena_master_version(data, server):
    if server not in data.get('serverScopes',[]):return None
    versions=data.get('sourceMasterVersions')
    return versions.get(server) if versions is not None else data.get('sourceMasterVersion')


def build_arena_content(master_root, release_id, region, locale="zh-CN", review=None):
    """Only an explicit per-release review can admit rows into public content.

    Review is a private build input, never copied into the projection. Time v1
    accepts second-precision local start, inclusive end, in a reviewed IANA zone.
    Other source semantics must get a new adapter instead of being guessed.
    """
    if region not in SERVERS:
        raise ValueError("unsupported arena region")
    out = dict(schemaVersion=1, region=region, sourceReleaseId=release_id,
               observedAt=None, sourceRevision=None, serverScopes=[], timeZone=None,
               timeSemanticsVersion=None, seasons=[], leagues=[], regulations=[], activityPeriods=[],
               ranks=[], basePoints=[], rewards=[], dailyReward=None, deckTrends=[], rankIcons=[],
               capabilities={k: False for k in ("conditions", "ranks", "basePoints", "rewards", "rankings", "deckTrends")},
               limitations=["publication_scope_unverified"])
    if review is None:
        return out
    if review.get("schemaVersion") != 1 or review.get("sourceReleaseId") != release_id or review.get("region") != region:
        raise ValueError("arena review identity mismatch")
    master_version = review.get('masterVersion')
    if master_version is not None:
        if not isinstance(master_version,str) or not re.fullmatch(r'[a-f0-9]{32}',master_version):
            raise ValueError('invalid arena master version')
        out['sourceMasterVersion'] = master_version
    scopes = review.get("serverScopes", [])
    if not isinstance(scopes, list) or not set(scopes) <= SERVERS[region]:
        raise ValueError("arena review server mismatch")
    observed = review.get("observedAt")
    if observed is not None:
        if not isinstance(observed, str) or datetime.fromisoformat(observed.replace("Z", "+00:00")).tzinfo is None:
            raise ValueError("arena observation must be absolute")
    tables, hashes, rank_inventory = {}, {}, {}
    for name in TABLES:
        spec = review.get("tables", {}).get(name)
        if spec is None:
            tables[name] = []
            continue
        raw = (Path(master_root) / (name + ".json")).read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest != spec.get("sha256"):
            raise ValueError("arena reviewed table changed: " + name)
        rows = json.loads(raw).get("_allData")
        ids = spec.get("publishedIds")
        if not isinstance(rows, list) or not isinstance(ids, list):
            raise ValueError("arena table/public scope malformed: " + name)
        if name == 'MasterArenaRank':
            for row in rows:
                rank_inventory.setdefault(str(row.get('_bandId')),set()).add(str(row.get('_id')))
        selected = [r for r in rows if r.get("_id") in ids]
        if len(selected) != len(ids) or len({r["_id"] for r in selected}) != len(ids):
            raise ValueError("arena published IDs missing or duplicated: " + name)
        tables[name], hashes[name] = selected, digest
    out.update(observedAt=observed, serverScopes=scopes,
               sourceRevision=hashlib.sha256(json.dumps({"hashes": hashes, "review": {k: v for k, v in review.items() if k not in ("deckTrends", "rankIcons")}}, sort_keys=True).encode()).hexdigest(),
               limitations=[])
    bindings=review.get('serverMasters')
    if bindings is not None:
        if not isinstance(bindings,dict) or set(bindings)!=set(scopes):raise ValueError('arena server Master coverage mismatch')
        versions={}
        for server,binding in bindings.items():
            if (not isinstance(binding,dict) or set(binding)!={'version','tables'}
                    or not isinstance(binding['version'],str) or not re.fullmatch(r'[a-f0-9]{32}',binding['version'])
                    or binding['tables']!=hashes):raise ValueError('arena server Master tables differ')
            versions[server]=binding['version']
        if master_version not in versions.values():raise ValueError('arena primary Master missing')
        out['sourceMasterVersions']=versions
    texts = {r["_id"]: r for r in tables["MasterText"]}
    def name(row):
        return resolve_localized_text(texts.get(row.get("_nameTextId")), locale, str(row["_id"])).text
    def number(row, key):
        value = row[key]
        if type(value) is not int:
            raise ValueError("arena integer required: " + key)
        return value
    def project(table, target, fn):
        try:
            out[target] = [fn(r) for r in tables[table]]
        except (KeyError, ValueError, TypeError):
            out[target] = []
            out["limitations"].append(target + "_invalid")
    time = review.get("time", {})
    zone = None
    if time.get("semanticsVersion") == "inclusive-second-v1":
        zone = ZoneInfo(time["timeZone"])
        out.update(timeZone=time["timeZone"], timeSemanticsVersion=time["semanticsVersion"])
    else:
        out["limitations"].append("time_unverified")
    def instant(raw, end=False, *, tz=zone):
        if not tz or not raw:
            return None
        local = datetime.strptime(raw, "%Y/%m/%d %H:%M:%S")
        # Reject ambiguous/nonexistent wall times; the source needs another adapter.
        stamp = local.replace(tzinfo=tz)
        if stamp.utcoffset() != local.replace(tzinfo=tz, fold=1).utcoffset() or stamp.astimezone(timezone.utc).astimezone(tz).replace(tzinfo=None) != local:
            raise ValueError("ambiguous arena wall time")
        return (stamp.astimezone(timezone.utc) + (timedelta(seconds=1) if end else timedelta())).isoformat()
    def interval(row):
        start, end = instant(row.get("_startAt")), instant(row.get("_endAt"), True)
        if zone and (not start or not end or start >= end):
            raise ValueError("invalid arena interval")
        return dict(validFrom=start, validUntil=end,
                    sourceTimeText=" → ".join(str(row.get(k, "")) for k in ("_startAt", "_endAt")))
    project("MasterArenaSeason", "seasons", lambda r: dict(id=str(r["_id"]), name=name(r), **interval(r),
            statisticsUntil=instant(r.get("_rankingCountEndAt"), True), statisticsSourceText=r.get("_rankingCountEndAt", "")))
    project("MasterArenaLeague", "leagues", lambda r: dict(id=str(r["_id"]), bandId=str(number(r, "_bandId")), name=name(r),
            opensAt=instant(r.get("_startAt")), openingSourceText=r.get("_startAt") if isinstance(r.get("_startAt"), str) else None))
    def regulation(r):
        attribute = number(r, "_liveMusicType")
        missions = [number(r, "_gekisouMission" + str(i)) for i in (1, 2, 3)]
        if attribute not in (0, 1, 2, 3, 4, 5, 99) or any(m not in (0, 1, 2, 3) for m in missions):
            raise ValueError("unsupported arena condition")
        return dict(id=str(r["_id"]), leagueId=str(r["_leagueId"]), attribute=attribute, missions=missions, **interval(r))
    project("MasterArenaLeagueRegulation", "regulations", regulation)
    # Event time semantics are reviewed separately from Arena wall times.
    activity_time = review.get("activityTime", {})
    if activity_time.get("semanticsVersion") == "inclusive-second-v1":
        activity_zone = ZoneInfo(activity_time["timeZone"])
        def activity(row):
            start = instant(row.get("_startAt"), tz=activity_zone)
            end = instant(row.get("_endAt"), True, tz=activity_zone)
            if not start or not end or start >= end:
                raise ValueError("invalid activity interval")
            return dict(id=str(row["_id"]), validFrom=start, validUntil=end)
        project("MasterEvent", "activityPeriods", activity)
    elif tables["MasterEvent"]:
        out["limitations"].append("activity_time_unverified")
    project("MasterArenaRank", "ranks", lambda r: dict(id=str(r["_id"]), bandId=str(number(r, "_bandId")), name=name(r),
            tier=number(r, "_rank"), division=number(r, "_division"), threshold=number(r, "_lp"),
            opensAt=instant(r.get("_startAt")), openingSourceText=r.get("_startAt") if isinstance(r.get("_startAt"), str) else None))
    out['completeRankBands'] = [band for band in {r['bandId'] for r in out['leagues']}
        if rank_inventory.get(band) and rank_inventory[band] == {r['id'] for r in out['ranks'] if r['bandId']==band}]
    out['completeRankBands'].sort()
    project("MasterBattleLivePlace", "basePoints", lambda r: dict(tier=number(r, "_matchRank"), players=number(r, "_matchPlayers"),
            place=number(r, "_place"), points=number(r, "_basePoint")))
    points = out["basePoints"]
    if len({(r["tier"], r["players"], r["place"]) for r in points}) != len(points) or any(not 2 <= r["players"] <= 5 or not 1 <= r["place"] <= r["players"] for r in points):
        out["basePoints"] = []
        out["limitations"].append("basePoints_conflict")
    league_ids = {r["id"] for r in out["leagues"]}
    if any(r["leagueId"] not in league_ids for r in out["regulations"]):
        out["regulations"] = []
        out["limitations"].append("league_reference_missing")
    if len({r["bandId"] for r in out["leagues"]}) != len(out["leagues"]):
        out["limitations"].append("league_conflict")
    # Resource type/id -> item is deliberately a reviewed relationship, not an
    # assumption that all resource IDs share the MasterItem namespace.
    items = {str(r["_id"]): r for r in tables["MasterItem"]}
    reward_tables = {"daily": "MasterLiveArenaReward", "promotion": "MasterLiveArenaRankReward", "season": "MasterArenaSeasonReward"}
    for group in review.get("rewardGroups", []):
        try:
            kind = group["kind"]
            source = {str(r["_id"]): r for r in tables[reward_tables[kind]]}
            rewards = []
            for row_id in group["rowIds"]:
                row = source[str(row_id)]
                item_id = review["resourceItems"][f'{row["_resourceType"]}:{row["_resourceId"]}']
                item = items[str(item_id)]
                count = number(row, "_count" if kind == "promotion" else "_resourceCount")
                if count <= 0:
                    raise ValueError("invalid arena reward count")
                rewards.append(dict(itemId=str(item_id), name=name(item), count=count))
            if not rewards:
                raise ValueError("empty arena reward")
            band = str(group.get("bandId", ""))
            rank_id = str(group.get("rankId", ""))
            if kind == "promotion" and not any(r["id"] == rank_id and r["bandId"] == band for r in out["ranks"]):
                raise ValueError("arena promotion reference missing")
            out["rewards"].append(dict(kind=kind, bandId=band, rankId=rank_id,
                    label=str(group["label"]), items=rewards))
        except (KeyError, TypeError, ValueError):
            out["limitations"].append("reward_reference_unverified")
    daily = review.get("dailyReward")
    if isinstance(daily, dict) and type(daily.get("limit")) is int and daily["limit"] > 0 and daily.get("resetTime") == "04:00":
        out["dailyReward"] = dict(limit=daily["limit"], resetTime=daily["resetTime"])
    out["capabilities"].update(conditions=bool(zone and out["seasons"] and out["leagues"] and out["regulations"] and "league_conflict" not in out["limitations"]),
                               ranks=bool(out["ranks"]), basePoints=bool(out["basePoints"]), rewards=bool(out["rewards"]))
    # Retired feature: old review inputs remain readable, but no new trends are published.
    try:
        out['rankIcons'] = project_rank_icons(master_root, review.get('rankIcons', []))
    except (OSError, KeyError, ValueError, TypeError):
        out['limitations'].append('rank_icons_unavailable')
    return out


def validate_arena_publication(value, release_id, region):
    """Reject accidentally mixed release identity before sealing public content."""
    if value.get("schemaVersion") != 1 or value.get("sourceReleaseId") != release_id or value.get("region") != region:
        raise ValueError("arena projection identity mismatch")
    if value.get('sourceMasterVersion') is not None and (not isinstance(value['sourceMasterVersion'],str)
            or not re.fullmatch(r'[a-f0-9]{32}',value['sourceMasterVersion'])):
        raise ValueError('invalid arena master version')
    for key in ("seasons", "leagues", "regulations", "ranks", "basePoints", "rewards", "serverScopes"):
        if not isinstance(value.get(key), list):
            raise ValueError("arena projection list missing: " + key)
    if not set(value["serverScopes"]) <= SERVERS[region]:
        raise ValueError("arena projection server mismatch")
    versions=value.get('sourceMasterVersions')
    if versions is not None and (not isinstance(versions,dict) or set(versions)!=set(value['serverScopes'])
            or any(not isinstance(v,str) or not re.fullmatch(r'[a-f0-9]{32}',v) for v in versions.values())
            or value.get('sourceMasterVersion') not in versions.values()):
        raise ValueError('invalid arena server Master versions')
    complete=value.get('completeRankBands',[])
    if not isinstance(complete,list) or len(set(complete))!=len(complete) or any(not isinstance(b,str) or b not in {l['bandId'] for l in value['leagues']} for b in complete):
        raise ValueError('invalid arena rank coverage')
    periods = value.get("activityPeriods", [])
    if not isinstance(periods, list):
        raise ValueError("arena activity periods invalid")
    seen = set()
    for row in periods:
        if (not isinstance(row, dict) or set(row) != {"id", "validFrom", "validUntil"}
                or not isinstance(row["id"], str) or row["id"] in seen):
            raise ValueError("arena activity period identity invalid")
        def absolute(raw):
            if not isinstance(raw, str):
                raise ValueError("activity period needs an absolute time")
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                raise ValueError("activity period needs a time zone")
            return dt
        if absolute(row["validFrom"]) >= absolute(row["validUntil"]):
            raise ValueError("arena activity period time invalid")
        seen.add(row["id"])
    if "deckTrends" in value:
        validate_public_trends(value["deckTrends"], region, value["seasons"], value["leagues"])
        if bool(value["deckTrends"]) != (value.get("capabilities", {}).get("deckTrends") is True):
            raise ValueError("arena trend capability mismatch")
    if 'rankIcons' in value:
        validate_rank_icons(value['rankIcons'])


def read_arena_review(source, root):
    """Read a pinned private review once, without copying it into public outputs."""
    binding = source.get("arenaReview")
    registry=False
    if binding is None and (os.environ.get('OURNOTES_ARENA_REVIEW_PATH') or os.environ.get('OURNOTES_ARENA_REVIEW_SHA256')):
        binding=dict(path=os.environ.get('OURNOTES_ARENA_REVIEW_PATH'),sha256=os.environ.get('OURNOTES_ARENA_REVIEW_SHA256'))
        registry=True
    if binding is None:
        return None
    if not isinstance(binding, dict) or not isinstance(binding.get("path"), str):
        raise ValueError("invalid arena review binding")
    root = Path(root).resolve()
    path = (root / binding["path"]).resolve()
    if root not in path.parents:
        raise ValueError("arena review escapes input root")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != binding.get("sha256"):
        raise ValueError("arena review digest mismatch")
    value = json.loads(raw)
    if registry and isinstance(value,dict) and value.get('schemaVersion')==1 and value.get('region')==source['region'] and value.get('sourceReleaseId')!=source['contentReleaseId']:
        return None
    if not isinstance(value, dict) or value.get("schemaVersion") != 1 or value.get("region") != source["region"] or value.get("sourceReleaseId") != source["contentReleaseId"]:
        raise ValueError("arena review identity mismatch")
    if registry:value['rankIcons']=project_rank_icons(path.parent,value.get('rankIcons',[]))
    return value
