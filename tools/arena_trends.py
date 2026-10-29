"""Public whitelist for reviewed official ArenaService.DeckTrend observations.

Only response card IDs and explicit query scope are published. No personal decks,
credentials, invented counts, percentages or member/support pairing are exposed.
"""
import hashlib
import json
from datetime import datetime

SOURCE = "ArenaService.DeckTrend"
SERVERS = {"global": {"global-hmt", "global-kr", "global-en"}, "jp": {"jp"}}


def project_deck_trends(records, region, seasons, leagues):
    if not isinstance(records, list):
        raise ValueError("invalid official trend observations")
    season_ids = {s["id"] for s in seasons}
    band_ids = {l["bandId"] for l in leagues}
    latest = {}
    for record in records:
        if not isinstance(record, dict) or record.get("source") != SOURCE:
            raise ValueError("unverified trend source")
        server = record.get("serverId")
        season, band = str(record.get("seasonId", "")), str(record.get("bandId", ""))
        music = record.get("musicId")
        if server not in SERVERS[region] or season not in season_ids or band not in band_ids or type(music) is not int or music <= 0:
            raise ValueError("official trend scope mismatch")
        observed = record.get("observedAt")
        if not isinstance(observed, str):
            raise ValueError("official trend observation time missing")
        stamp = datetime.fromisoformat(observed.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            raise ValueError("official trend observation must be absolute")
        response = record.get("response")
        if not isinstance(response, dict):
            raise ValueError("official trend response missing")
        groups = {}
        for kind, field in (("leaders", "memberCardId"), ("members", "memberCardId"), ("supports", "supportCardId")):
            rows = response.get(kind)
            if not isinstance(rows, list) or any(not isinstance(row, dict) or type(row.get(field)) is not int or row[field] <= 0 for row in rows):
                raise ValueError("official trend card group malformed")
            groups[kind] = [str(row[field]) for row in rows]
        value = dict(source=SOURCE, serverId=server, seasonId=season, bandId=band,
                     musicId=str(music), observedAt=observed, **groups)
        value["sourceRevision"] = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
        key = (server, season, band, music)
        previous = latest.get(key)
        if previous:
            previous_stamp = datetime.fromisoformat(previous["observedAt"].replace("Z", "+00:00"))
            if stamp == previous_stamp and value["sourceRevision"] != previous["sourceRevision"]:
                raise ValueError("conflicting official trend observations")
            if stamp <= previous_stamp:
                continue
        latest[key] = value
    return [latest[key] for key in sorted(latest)]


def validate_public_trends(records, region, seasons, leagues):
    """Reject raw response fields or mixed identities before public sealing."""
    fields = {"source", "serverId", "seasonId", "bandId", "musicId", "observedAt", "sourceRevision", "leaders", "members", "supports"}
    if not isinstance(records, list):
        raise ValueError("invalid public trend projection")
    inputs = []
    try:
        for record in records:
            if not isinstance(record, dict) or set(record) != fields:
                raise ValueError("non-whitelisted public trend fields")
            inputs.append({**{k: record[k] for k in ("source", "serverId", "seasonId", "bandId", "observedAt")},
                "musicId": int(record["musicId"]), "response": {
                    "leaders": [{"memberCardId": int(i)} for i in record["leaders"]],
                    "members": [{"memberCardId": int(i)} for i in record["members"]],
                    "supports": [{"supportCardId": int(i)} for i in record["supports"]]}})
        if project_deck_trends(inputs, region, seasons, leagues) != records:
            raise ValueError("public trend identity or digest mismatch")
    except (KeyError, TypeError, OverflowError) as exc:
        raise ValueError("invalid public trend projection") from exc
