"""Read-only anonymous ranking insights aggregation for Event and Arena observations."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from statistics import median
from typing import Any

from backend.arena_population import query_population
from backend.arena_rankings import (
    ID as ARENA_ID,
    observation_path as arena_observation_path,
    validate_observation as validate_arena_observation,
)
from backend.player_rankings import (
    FINAL_EVENT_ID,
    SERVERS,
    final_archive_paths,
    list_final_archives,
    public_high_score_deck,
    validate_observation as validate_player_observation,
)

SCHEMA_VERSION = 1
ARENA_BANDS = ("1", "2", "3", "4", "5")
CHECKPOINT_HOURS = (24, 12, 6, 1)
# Disjoint tolerance windows around each checkpoint so early/sparse history
# does not fabricate a 24h curve or map multiple checkpoints to the same sample.
CHECKPOINT_TOLERANCE_HOURS = {24: 6.0, 12: 3.5, 6: 2.0, 1: 0.75}
TRACKED_RANKS = (10, 50, 100)
MUSIC_ID = re.compile(r"[A-Za-z0-9_-]{1,100}")

_CACHE: dict[tuple[Any, ...], tuple[str, dict[str, Any]]] = {}
_CACHE_MAX = 64


def _file_digest(path: Path) -> str:
    if not path.is_file():
        return "missing"
    stat = path.stat()
    return f"{stat.st_size}:{stat.st_mtime_ns}"


def _extract_complete_pairs(deck: dict[str, Any] | None) -> list[dict[str, Any]] | None:
    if not isinstance(deck, dict):
        return None
    cards = deck.get("cards")
    if not isinstance(cards, list) or len(cards) != 5:
        return None
    out: list[dict[str, Any]] = []
    for row in cards:
        member = row.get("member") if isinstance(row, dict) else None
        support = row.get("support") if isinstance(row, dict) else None
        if not isinstance(member, dict) or not isinstance(support, dict):
            return None
        mid = member.get("masterId")
        sid = support.get("masterId")
        if type(mid) is not int or type(sid) is not int:
            return None
        out.append({
            "slot": row.get("slot", 0),
            "performanceOrder": row.get("performanceOrder", 0),
            "member": member,
            "support": support,
        })
    return out


def _percentile(sorted_vals: list[int], q: float) -> int:
    if not sorted_vals:
        return 0
    idx = int(round((len(sorted_vals) - 1) * q))
    idx = max(0, min(len(sorted_vals) - 1, idx))
    return int(sorted_vals[idx])


def aggregate_entries(
    entries: list[dict[str, Any]],
    *,
    is_arena: bool = False,
    head_end: int = 100,
    include_head_ranks: bool = True,
) -> dict[str, Any]:
    """Compute anonymous aggregate statistics from validated public ranking entries."""
    member_sets: Counter[tuple[int, ...]] = Counter()
    paired_sets: Counter[tuple[tuple[int, int], ...]] = Counter()
    member_usage: Counter[int] = Counter()
    support_usage: Counter[int] = Counter()
    pair_usage: Counter[tuple[int, int]] = Counter()

    member_rank_dist: Counter[str] = Counter()
    support_rank_dist: Counter[str] = Counter()
    live_skill_dist: Counter[str] = Counter()
    perf_skill_dist: Counter[str] = Counter()

    order_counts: dict[int, Counter[int]] = {i: Counter() for i in range(5)}
    powers: list[int] = []
    lowest_head_team: dict[str, Any] | None = None

    skill_vs_rank = {
        "fullRankFullSkill": 0,
        "lowRankFullSkill": 0,
        "fullRankLowSkill": 0,
        "other": 0,
        "sampleSlots": 0,
    }

    head_member_ranks: dict[int, list[int]] = defaultdict(list)
    head_support_ranks: dict[int, list[int]] = defaultdict(list)

    complete = 0
    excluded = 0

    for entry in entries:
        deck_raw = entry.get("deck") if is_arena else entry.get("highScoreDeck")
        cards = _extract_complete_pairs(deck_raw)
        if cards is None:
            excluded += 1
            continue
        complete += 1
        rank = int(entry.get("rank", 0))
        score = int(entry.get("point" if is_arena else "score", 0))
        in_head = 1 <= rank <= head_end

        mids = tuple(sorted(c["member"]["masterId"] for c in cards))
        pairs = tuple(sorted((c["member"]["masterId"], c["support"]["masterId"]) for c in cards))
        member_sets[mids] += 1
        paired_sets[pairs] += 1

        total_power = deck_raw.get("totalPower") if isinstance(deck_raw, dict) else None
        if type(total_power) is int and total_power > 0:
            powers.append(total_power)
            if in_head and (lowest_head_team is None or total_power < lowest_head_team["totalPower"]):
                lowest_head_team = {
                    "rank": rank,
                    "score": score,
                    "totalPower": total_power,
                    "pairs": [[m, s] for m, s in pairs],
                }

        for c in cards:
            m = c["member"]
            s = c["support"]
            mid = m["masterId"]
            sid = s["masterId"]
            member_usage[mid] += 1
            support_usage[sid] += 1
            pair_usage[(mid, sid)] += 1

            order = c.get("performanceOrder")
            if type(order) is int and 0 <= order <= 4:
                order_counts[order][mid] += 1

            mr = m.get("rank")
            sr = s.get("rank")
            if type(mr) is int:
                member_rank_dist[str(mr)] += 1
            if type(sr) is int:
                support_rank_dist[str(sr)] += 1

            lsl = m.get("liveSkillLevel")
            psl = m.get("performanceSkillLevel")
            if type(lsl) is int:
                live_skill_dist[str(lsl)] += 1
            if type(psl) is int:
                perf_skill_dist[str(psl)] += 1

            active_skill = psl if is_arena else lsl
            if in_head and type(mr) is int and type(active_skill) is int:
                skill_vs_rank["sampleSlots"] += 1
                if mr >= 5 and active_skill >= 5:
                    skill_vs_rank["fullRankFullSkill"] += 1
                elif mr < 5 and active_skill >= 5:
                    skill_vs_rank["lowRankFullSkill"] += 1
                elif mr >= 5 and active_skill < 5:
                    skill_vs_rank["fullRankLowSkill"] += 1
                else:
                    skill_vs_rank["other"] += 1

            if include_head_ranks and in_head:
                if len(head_member_ranks[mid]) < 40:
                    head_member_ranks[mid].append(rank)
                if len(head_support_ranks[sid]) < 40:
                    head_support_ranks[sid].append(rank)

    powers.sort()
    power_stats = (
        {
            "count": len(powers),
            "min": powers[0],
            "median": int(round(median(powers))),
            "p90": _percentile(powers, 0.9),
            "max": powers[-1],
            "lowestHeadTeam": lowest_head_team,
        }
        if powers
        else None
    )

    order_preference = {
        str(slot): [
            {"key": mid, "count": cnt, "pct": round(100.0 * cnt / complete, 1) if complete else 0.0}
            for mid, cnt in counter.most_common(5)
        ]
        for slot, counter in order_counts.items()
    }

    # Keep top 10 supports per member (UI displays top 6); trims long-tail 1-count pairs.
    pairs_by_member: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for (mid, sid), cnt in pair_usage.most_common():
        bucket = pairs_by_member[mid]
        if len(bucket) < 10:
            bucket.append((sid, cnt))
    trimmed_pairs = [
        {"key": [mid, sid], "count": cnt}
        for mid, items in pairs_by_member.items()
        for sid, cnt in items
    ]
    trimmed_pairs.sort(key=lambda item: -item["count"])

    result: dict[str, Any] = {
        "total": len(entries),
        "n": complete,
        "excluded": excluded,
        "members": {
            "unique": len(member_sets),
            "top": [{"key": list(k), "count": v} for k, v in member_sets.most_common(10)],
        },
        "paired": {
            "unique": len(paired_sets),
        },
        "memberUsage": [{"key": k, "count": v} for k, v in member_usage.most_common()],
        "supportUsage": [{"key": k, "count": v} for k, v in support_usage.most_common()],
        "pairUsage": trimmed_pairs,
        "growth": {
            "memberRank": dict(member_rank_dist),
            "supportRank": dict(support_rank_dist),
            "liveSkillLevel": dict(live_skill_dist),
            "performanceSkillLevel": dict(perf_skill_dist),
        },
        "powerStats": power_stats,
        "orderPreference": order_preference,
        "skillVsRank": skill_vs_rank,
    }
    if include_head_ranks:
        result["headEnd"] = head_end
        result["headCardRanks"] = {
            "member": {str(k): v for k, v in head_member_ranks.items()},
            "support": {str(k): v for k, v in head_support_ranks.items()},
        }
    return result


def _build_tiers(
    entries: list[dict[str, Any]],
    ranges: list[tuple[int, int]],
    *,
    is_arena: bool,
) -> list[dict[str, Any]]:
    tiers: list[dict[str, Any]] = []
    for start, end in ranges:
        subset = [e for e in entries if start <= int(e.get("rank", 0)) <= end]
        if not subset:
            continue
        agg = aggregate_entries(subset, is_arena=is_arena, head_end=end, include_head_ranks=False)
        if agg["n"] == 0:
            continue
        tiers.append({
            "ranks": [start, end],
            "stats": {
                "n": agg["n"],
                "memberUsage": agg["memberUsage"],
                "supportUsage": agg["supportUsage"],
                "growth": agg["growth"],
                "powerStats": agg["powerStats"],
            },
        })
    return tiers


def _compute_cross_song(music_boards: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute anonymous multi-song team reuse & swap categories across an event's songs."""
    player_songs: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    for b in music_boards:
        mid = str(b.get("musicId", ""))
        for entry in b.get("entries", []):
            cards = _extract_complete_pairs(entry.get("highScoreDeck"))
            if cards is None:
                continue
            pid = str(entry.get("playerId", ""))
            if not pid:
                continue
            members = tuple(sorted(c["member"]["masterId"] for c in cards))
            supports = tuple(sorted(c["support"]["masterId"] for c in cards))
            pairs = tuple(sorted((c["member"]["masterId"], c["support"]["masterId"]) for c in cards))
            player_songs[pid][mid] = {
                "rank": int(entry.get("rank", 0)),
                "members": members,
                "supports": supports,
                "pairs": pairs,
            }

    histogram: Counter[str] = Counter()
    categories = {
        "samePairing": 0,
        "sameCardsChangedPairing": 0,
        "sameMembersChangedSupports": 0,
        "changedMembers": 0,
    }
    multi_song_players = 0
    best_example: tuple[tuple[int, int, int], dict[str, Any]] | None = None

    for songs_map in player_songs.values():
        pair_counts: Counter[tuple[tuple[int, int], ...]] = Counter(v["pairs"] for v in songs_map.values())
        max_same_team = max(pair_counts.values())
        histogram[str(max_same_team)] += 1

        if len(songs_map) >= 2:
            multi_song_players += 1
            unique_pairs = {v["pairs"] for v in songs_map.values()}
            unique_members = {v["members"] for v in songs_map.values()}
            unique_supports = {v["supports"] for v in songs_map.values()}
            if len(unique_pairs) == 1:
                categories["samePairing"] += 1
            elif len(unique_members) == 1 and len(unique_supports) == 1:
                categories["sameCardsChangedPairing"] += 1
            elif len(unique_members) == 1:
                categories["sameMembersChangedSupports"] += 1
            else:
                categories["changedMembers"] += 1

        # Candidate anonymized repeat example (most songs with same team, lowest sum of ranks)
        top_pair, count = pair_counts.most_common(1)[0]
        if count >= 2:
            placements = sorted(
                [{"music": m, "rank": v["rank"]} for m, v in songs_map.items() if v["pairs"] == top_pair],
                key=lambda x: x["music"],
            )
            rank_sum = sum(p["rank"] for p in placements)
            max_rank = max(p["rank"] for p in placements)
            score_key = (-count, max_rank, rank_sum)
            if best_example is None or score_key < best_example[0]:
                best_example = (
                    score_key,
                    {"placements": placements, "pairs": [[m, s] for m, s in top_pair]},
                )

    return {
        "crossSong": {
            "uniquePlayersWithCompleteDecks": len(player_songs),
            "multiSongPlayers": multi_song_players,
            "categories": categories,
        },
        "sameTeamSongsHistogram": dict(sorted(histogram.items(), key=lambda kv: int(kv[0]))),
        "repeatExample": best_example[1] if best_example else None,
    }


def _query_closing_history(
    root: Path,
    server: str,
    event_id: str,
    song_names: dict[str, str],
    final_board_scores: dict[str, dict[int, int]] | None = None,
) -> list[dict[str, Any]]:
    """Read closing-24h threshold curves from read-only history.sqlite3 if present."""
    db_path = root / server / "history.sqlite3"
    if not db_path.is_file():
        return []
    uri = f"file:{db_path}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=2.0)
    except sqlite3.Error:
        return []
    results: list[dict[str, Any]] = []
    try:
        cur = conn.cursor()
        musics = [
            row[0]
            for row in cur.execute(
                "SELECT DISTINCT music FROM observations WHERE event = ? AND music != '' ORDER BY music",
                (event_id,),
            ).fetchall()
        ]
        for music in musics:
            obs_rows = cur.execute(
                "SELECT id, observed, end, final FROM observations WHERE event = ? AND music = ? ORDER BY observed ASC",
                (event_id, music),
            ).fetchall()
            if not obs_rows:
                continue
            final_rows = [r for r in obs_rows if r[3] == 1]

            if final_rows:
                is_final_curve = True
                end_ts = next((r[2] for r in reversed(obs_rows) if r[2] is not None), None)
                if end_ts is None:
                    continue
                final_scores = dict(
                    cur.execute(
                        "SELECT rank, score FROM scores WHERE observation = ? AND rank IN (10, 50, 100)",
                        (final_rows[-1][0],),
                    ).fetchall()
                )
            elif final_board_scores and music in final_board_scores:
                is_final_curve = True
                end_ts = next((r[2] for r in reversed(obs_rows) if r[2] is not None), None)
                if end_ts is None:
                    continue
                final_scores = final_board_scores[music]
            else:
                is_final_curve = False
                latest = obs_rows[-1]
                end_ts = latest[1]
                final_scores = dict(
                    cur.execute(
                        "SELECT rank, score FROM scores WHERE observation = ? AND rank IN (10, 50, 100)",
                        (latest[0],),
                    ).fetchall()
                )
            if not all(r in final_scores for r in TRACKED_RANKS):
                continue

            pre_rows = [
                r for r in obs_rows
                if r[3] == 0 and (r[1] <= end_ts if is_final_curve else r[1] < end_ts)
            ]
            if not pre_rows:
                continue

            checkpoints: list[dict[str, Any]] = []
            for hours in CHECKPOINT_HOURS:
                target_ts = end_ts - hours * 3600
                nearest = min(pre_rows, key=lambda r: abs(r[1] - target_ts))
                tol_seconds = CHECKPOINT_TOLERANCE_HOURS[hours] * 3600.0
                if abs(nearest[1] - target_ts) > tol_seconds:
                    continue
                scores = dict(
                    cur.execute(
                        "SELECT rank, score FROM scores WHERE observation = ? AND rank IN (10, 50, 100)",
                        (nearest[0],),
                    ).fetchall()
                )
                if not all(r in scores for r in TRACKED_RANKS):
                    continue
                checkpoints.append({
                    "hoursBeforeEnd": hours,
                    "observed": nearest[1],
                    "scores": {str(r): int(scores[r]) for r in TRACKED_RANKS},
                })

            base = next((cp for cp in checkpoints if cp["hoursBeforeEnd"] == 24), None)
            if base is None:
                continue
            window_hours = (end_ts - base["observed"]) / 3600.0
            if window_hours <= 0:
                continue
            changes = []
            for r in TRACKED_RANKS:
                before = int(base["scores"][str(r)])
                final_val = int(final_scores[r])
                inc = final_val - before
                pct_val = round(100.0 * inc / before, 4) if before > 0 else 0.0
                changes.append({
                    "rank": r,
                    "before": before,
                    "final": final_val,
                    "increase": inc,
                    "pct": pct_val,
                })
            results.append({
                "event": event_id,
                "music": music,
                "name": song_names.get(music, music),
                "isFinal": is_final_curve,
                "end": end_ts,
                "windowHours": round(window_hours, 2),
                "within10MinutesOf24h": abs(window_hours - 24.0) <= (10.0 / 60.0),
                "checkpoints": checkpoints,
                "changes": changes,
            })
    except sqlite3.Error:
        return []
    finally:
        conn.close()
    return results


def _load_event_snapshot(
    root: Path, server: str, event_id: str | None
) -> tuple[str | None, dict[str, Any] | None, str, bool]:
    archives = list_final_archives(root, server)
    current_path = root / server / "current.json"
    current_data = None
    current_digest = _file_digest(current_path)
    if current_path.is_file():
        try:
            current_data = validate_player_observation(json.loads(current_path.read_bytes()), server)
        except (OSError, ValueError, TypeError, KeyError):
            current_data = None

    current_event_ids = (
        list(dict.fromkeys(b["eventId"] for b in current_data["boards"])) if current_data else []
    )
    resolved = event_id or (current_event_ids[0] if current_event_ids else (sorted(archives, key=int, reverse=True)[0] if archives else None))
    if resolved is None:
        return None, None, "missing", False

    if resolved in current_event_ids and resolved not in archives:
        return resolved, current_data, current_digest, False
    if resolved in archives:
        archive_path, _ = final_archive_paths(root, server, resolved)
        raw = archive_path.read_bytes()
        data = validate_player_observation(json.loads(raw), server)
        return resolved, data, hashlib.sha256(raw).hexdigest(), True
    return resolved, None, "missing", False


def _project_teaser(result: dict[str, Any]) -> dict[str, Any]:
    """Return a minimal teaser payload (~1-3 KB) for leaderboard highlight strips."""
    if result.get("status") != "available":
        return result
    st = result.get("stats") or {}
    top_members = (st.get("members") or {}).get("top") or []
    base_stats: dict[str, Any] = {
        "n": st.get("n", 0),
        "members": {
            "unique": (st.get("members") or {}).get("unique", 0),
            "top": top_members[:1],
        },
    }
    if result.get("mode") == "arena":
        if "headCardRanks" in st:
            # Teaser only needs the best rank per card to find the top R/SR spotlight.
            hcr = st["headCardRanks"]
            base_stats["headCardRanks"] = {
                kind: {cid: ranks[:1] for cid, ranks in (hcr.get(kind) or {}).items() if ranks}
                for kind in ("member", "support")
            }
        return {
            "schemaVersion": result["schemaVersion"],
            "mode": "arena",
            "serverId": result["serverId"],
            "seasonId": result["seasonId"],
            "bandId": result["bandId"],
            "status": "available",
            "observedAt": result.get("observedAt"),
            "stats": base_stats,
            "crossBand": result.get("crossBand") or [],
        }

    # mode == "activity"
    music_id = str(result.get("musicId", ""))
    closing_teaser: list[dict[str, Any]] = []
    for item in result.get("closingHistory") or []:
        if str(item.get("music", "")) == music_id:
            c100 = [c for c in (item.get("changes") or []) if c.get("rank") == 100]
            if c100:
                closing_teaser.append({
                    "music": item["music"],
                    "isFinal": bool(item.get("isFinal", result.get("isFinal", False))),
                    "changes": c100,
                })
            break
    return {
        "schemaVersion": result["schemaVersion"],
        "mode": "activity",
        "serverId": result["serverId"],
        "eventId": result.get("eventId"),
        "musicId": music_id,
        "isFinal": result.get("isFinal", False),
        "status": "available",
        "observedAt": result.get("observedAt"),
        "songs": [{"id": s["id"]} for s in (result.get("songs") or [])],
        "stats": base_stats,
        "sameTeamSongsHistogram": result.get("sameTeamSongsHistogram") or {},
        "closingHistory": closing_teaser,
    }


def query_ranking_insights(
    root: Path,
    *,
    mode: str,
    server: str,
    event: str | None = None,
    music: str = "",
    season: str = "1",
    band: str = "1",
    view: str = "full",
    now: datetime | None = None,
) -> dict[str, Any]:
    """Return anonymous aggregate ranking insights for either 'activity' or 'arena' mode."""
    if server not in SERVERS or mode not in ("activity", "arena") or view not in ("full", "teaser"):
        raise ValueError("invalid_ranking_insights_scope")

    if view == "teaser":
        full = query_ranking_insights(
            root,
            mode=mode,
            server=server,
            event=event,
            music=music,
            season=season,
            band=band,
            view="full",
            now=now,
        )
        return _project_teaser(full)

    if mode == "arena":
        if not ARENA_ID.fullmatch(season) or not ARENA_ID.fullmatch(band):
            raise ValueError("invalid_arena_insights_scope")

        band_paths = {b: arena_observation_path(root, server, season, b) for b in ARENA_BANDS}
        pop_path = root / server / "arena" / f"season-{season}" / f"population-band-{band}.json"
        digest = "|".join([_file_digest(p) for p in band_paths.values()] + [_file_digest(pop_path)])
        cache_key = ("arena", str(root), server, season, band)
        cached = _CACHE.get(cache_key)
        if cached and cached[0] == digest:
            return cached[1]

        selected_path = band_paths.get(band) or arena_observation_path(root, server, season, band)
        if not selected_path.is_file():
            return {
                "schemaVersion": SCHEMA_VERSION,
                "mode": "arena",
                "serverId": server,
                "seasonId": season,
                "bandId": band,
                "status": "unavailable",
            }

        loaded_bands: dict[str, dict[str, Any]] = {}
        for bid, bpath in band_paths.items():
            if not bpath.is_file():
                continue
            try:
                loaded_bands[bid] = validate_arena_observation(
                    json.loads(bpath.read_bytes()), server, season, bid
                )
            except (OSError, ValueError, TypeError, KeyError):
                continue

        selected = loaded_bands.get(band)
        if selected is None:
            return {
                "schemaVersion": SCHEMA_VERSION,
                "mode": "arena",
                "serverId": server,
                "seasonId": season,
                "bandId": band,
                "status": "unavailable",
            }

        stats = aggregate_entries(selected["entries"], is_arena=True, head_end=100)
        tiers = _build_tiers(selected["entries"], [(1, 100), (101, 500), (501, 1000)], is_arena=True)

        # Cross-band support matrix & per-band card usage for reverse lookup
        support_by_band: dict[int, list[dict[str, Any]]] = defaultdict(list)
        all_bands_usage: dict[str, dict[str, Any]] = {}
        for bid, bdata in loaded_bands.items():
            bagg = (
                stats
                if bid == band
                else aggregate_entries(bdata["entries"], is_arena=True, head_end=100, include_head_ranks=False)
            )
            all_bands_usage[bid] = {
                "n": bagg["n"],
                "maxRank": bdata["maxRank"],
                "memberUsage": bagg["memberUsage"],
                "supportUsage": bagg["supportUsage"],
            }
            for item in bagg["supportUsage"]:
                pct_val = round(100.0 * item["count"] / bagg["n"], 2) if bagg["n"] else 0.0
                support_by_band[item["key"]].append({
                    "band": bid,
                    "count": item["count"],
                    "pct": pct_val,
                })

        cross_band = [
            {"support": sid, "boards": sorted(blist, key=lambda x: int(x["band"]))}
            for sid, blist in support_by_band.items()
        ]
        population = query_population(root, server=server, season=season, band=band, now=now)

        result: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "mode": "arena",
            "serverId": server,
            "seasonId": season,
            "bandId": band,
            "status": "available",
            "observedAt": selected["observedAt"],
            "coverage": {
                "rankRange": [selected["coverage"]["startRank"], selected["coverage"]["endRank"]],
                "maxRank": selected["maxRank"],
            },
            "stats": stats,
            "tiers": tiers,
            "crossBand": cross_band,
            "allBandsUsage": all_bands_usage,
            "population": population.get("observation") if population.get("status") != "unavailable" else None,
        }
        if len(_CACHE) >= _CACHE_MAX:
            _CACHE.clear()
        _CACHE[cache_key] = (digest, result)
        return result

    # mode == "activity"
    if event is not None and not FINAL_EVENT_ID.fullmatch(event):
        raise ValueError("invalid_activity_insights_event")
    if music and not MUSIC_ID.fullmatch(music):
        raise ValueError("invalid_activity_insights_music")

    resolved_event, data, snap_digest, is_final = _load_event_snapshot(root, server, event)
    if resolved_event is None or data is None:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "mode": "activity",
            "serverId": server,
            "eventId": resolved_event,
            "musicId": music,
            "status": "unavailable",
        }

    hist_digest = _file_digest(root / server / "history.sqlite3")
    digest = f"{snap_digest}|{hist_digest}"
    cache_key = ("activity", str(root), server, resolved_event, music)
    cached = _CACHE.get(cache_key)
    if cached and cached[0] == digest:
        return cached[1]

    music_boards = [b for b in data["boards"] if b["eventId"] == resolved_event and b["type"] == "music"]
    if not music_boards:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "mode": "activity",
            "serverId": server,
            "eventId": resolved_event,
            "musicId": music,
            "status": "unavailable",
        }

    selected_board = next((b for b in music_boards if str(b.get("musicId", "")) == music), None) if music else music_boards[0]
    if selected_board is None:
        selected_board = music_boards[0]
    selected_music = str(selected_board.get("musicId", ""))

    stats = aggregate_entries(selected_board["entries"], is_arena=False, head_end=20)
    tiers = _build_tiers(selected_board["entries"], [(1, 20), (21, 50), (51, 100)], is_arena=False)
    cross_song_bundle = _compute_cross_song(music_boards)

    all_songs_usage: dict[str, dict[str, Any]] = {}
    song_names: dict[str, str] = {}
    for mb in music_boards:
        mid = str(mb.get("musicId", ""))
        song_names[mid] = str(mb.get("musicName", mid))
        magg = (
            stats
            if mid == selected_music
            else aggregate_entries(mb["entries"], is_arena=False, head_end=20, include_head_ranks=False)
        )
        all_songs_usage[mid] = {
            "name": song_names[mid],
            "n": magg["n"],
            "memberUsage": magg["memberUsage"],
            "supportUsage": magg["supportUsage"],
        }

    final_board_scores: dict[str, dict[int, int]] = {}
    if is_final:
        for mb in music_boards:
            mid = str(mb.get("musicId", ""))
            rank_map = {int(e["rank"]): int(e["score"]) for e in mb.get("entries", []) if int(e.get("rank", 0)) in TRACKED_RANKS}
            if all(r in rank_map for r in TRACKED_RANKS):
                final_board_scores[mid] = rank_map
    closing_history = _query_closing_history(root, server, resolved_event, song_names, final_board_scores)

    result = {
        "schemaVersion": SCHEMA_VERSION,
        "mode": "activity",
        "serverId": server,
        "eventId": resolved_event,
        "eventName": selected_board.get("eventName", ""),
        "musicId": selected_music,
        "musicName": selected_board.get("musicName", selected_music),
        "isFinal": is_final,
        "status": "available",
        "observedAt": data["observedAt"],
        "songs": [{"id": str(b.get("musicId", "")), "name": str(b.get("musicName", b.get("musicId", "")))} for b in music_boards],
        "stats": stats,
        "tiers": tiers,
        "crossSong": cross_song_bundle["crossSong"],
        "sameTeamSongsHistogram": cross_song_bundle["sameTeamSongsHistogram"],
        "repeatExample": cross_song_bundle["repeatExample"],
        "allSongsUsage": all_songs_usage,
        "closingHistory": closing_history,
    }
    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.clear()
    _CACHE[cache_key] = (digest, result)
    return result


def generate_all_insights(observations_root: Path, out_root: Path, servers: tuple[str, ...] = ("global-hmt", "global-en", "global-kr", "jp")) -> dict[str, int]:
    """Pre-generate anonymous insights JSON files for all available arena & event observations."""
    written = {"arena": 0, "activity": 0}
    for srv in servers:
        srv_dir = observations_root / srv
        if not srv_dir.is_dir():
            continue
        # Arena seasons
        arena_dir = srv_dir / "arena"
        if arena_dir.is_dir():
            for season_dir in sorted(arena_dir.glob("season-*")):
                season_id = season_dir.name.removeprefix("season-")
                if not ARENA_ID.fullmatch(season_id):
                    continue
                for bid in ARENA_BANDS:
                    res = query_ranking_insights(observations_root, mode="arena", server=srv, season=season_id, band=bid)
                    if res.get("status") == "available":
                        target = out_root / srv / "arena" / f"season-{season_id}" / f"insights-band-{bid}.json"
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
                        written["arena"] += 1
        # Activity events (current + archived)
        archives = list_final_archives(observations_root, srv)
        event_ids = set(archives.keys())
        cur_path = srv_dir / "current.json"
        if cur_path.is_file():
            try:
                cur = validate_player_observation(json.loads(cur_path.read_bytes()), srv)
                event_ids.update(b["eventId"] for b in cur["boards"] if b["type"] == "music")
            except (OSError, ValueError, TypeError, KeyError):
                pass
        for eid in sorted(event_ids, key=int):
            probe = query_ranking_insights(observations_root, mode="activity", server=srv, event=eid)
            if probe.get("status") != "available":
                continue
            for s in probe.get("songs", []):
                res = query_ranking_insights(observations_root, mode="activity", server=srv, event=eid, music=s["id"])
                if res.get("status") == "available":
                    target = out_root / srv / "events" / f"event-{eid}" / f"insights-music-{s['id']}.json"
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
                    written["activity"] += 1
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate anonymous ranking insights from observation files.")
    parser.add_argument("--observations", required=True, type=Path, help="Path to observations root directory")
    parser.add_argument("--out", required=True, type=Path, help="Output directory for generated insights JSONs")
    args = parser.parse_args()
    counts = generate_all_insights(args.observations, args.out)
    print(f"Generated insights: arena={counts['arena']}, activity={counts['activity']} -> {args.out}")


if __name__ == "__main__":
    main()
