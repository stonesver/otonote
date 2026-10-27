"""Project the current production Master inputs for the browser's code audit calculator.

No player data and no empirical replay are required. A release mismatch must be
rejected by consumers, rather than silently using rules from another package.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUDITED_RELEASE_ID = "global-prod-20260924-v1-0-1-25-39b5d81f"
TABLES = (
    "MemberCard", "SupportCard", "Character", "MemberCardLevel",
    "MemberCardLevelLimit", "MemberCardAwake", "MemberCardRank",
    "SupportCardLevel", "SupportCardRank", "CharacterRank", "CharacterTotalRank",
    "LeaderSkillEffect", "LiveSkill", "LiveSkillEffect", "SupportSkillEffect",
    "SkillTarget", "SkillCondition", "SkillConditionSet", "BandItem",
    "BandItemLevel", "BandItemSkillEffect", "VipRankBonus", "LiveMusic", "LiveMusicScore",
    "LiveSettings", "LiveNoteParameter", "LiveJudgementParameter", "LiveJudgementTiming",
    "LiveComboScoreBonus", "Parameter",
    "GekisouSkill", "GekisouSkillEffect", "GekisouSupportSkill", "GekisouSupportSkillEffect",
    "LiveGekisouRankingScoreBonus", "LiveGekisouLuckBasePoint", "LiveGekisouLuckBonusLot",
    "SkillCumulativeCondition", "SkillEffectSetting", "Event", "EventEffect", "EventPickUpCard", "ArenaEventBonus",
)


def project_tables(root: Path, *, optional_tables=()):
    tables, digests = {}, {}
    for name in TABLES:
        path = root / f"Master{name}.json"
        if name in optional_tables and not path.exists():
            continue
        content = path.read_bytes()
        rows = json.loads(content)["_allData"]
        if not isinstance(rows, list):
            raise ValueError(f"invalid Master{name}")
        tables[name] = rows
        digests[f"Master{name}"] = hashlib.sha256(content).hexdigest()
    # Keep source hashes for the complete tables, but ship only the effects
    # referenced by this release's cards. Unreleased definitions aren't inputs.
    for effect_table, card_table, card_fields, effect_field in (
        ("LeaderSkillEffect", "MemberCard", ("_leaderSkillID",), "_leaderSkillID"),
        ("LiveSkillEffect", "MemberCard", ("_liveSkillID",), "_liveSkillID"),
        ("SupportSkillEffect", "SupportCard", ("_supportSkillId01", "_supportSkillId02"), "_supportSkillID"),
    ):
        ids = {r.get(field) for r in tables[card_table] for field in card_fields} - {0, None}
        tables[effect_table] = [r for r in tables[effect_table] if r[effect_field] in ids]
    for name, fields in {
        "Character": ("_id", "_bandID"),
        "LiveMusic": ("_id", "_musicType", "_bestMusicTagIDs", "_gekisouMission1", "_gekisouMission2", "_gekisouMission3"),
    }.items():
        tables[name] = [{k: r[k] for k in fields} for r in tables[name]]
    return tables, digests


def build_rules(root: Path, release_id: str) -> dict:
    if release_id != AUDITED_RELEASE_ID:
        raise ValueError("This code profile has not been audited for the requested release")
    tables, digests = project_tables(root)
    return {
        "schemaVersion": 1,
        "sourceReleaseId": release_id,
        "ruleSetVersion": "global-1.0.1-25-code-v6",
        "capabilities": {"formationPower": "code_audited", "ordinarySong": "ideal_input_estimate",
                         "gekisouScore": "state_machine_incomplete",
                         "gekisouSimulation": "conditional_ap_frame_replay", "event": "no_current_events"},
        "verificationStatus": "code_audited",
        "packageVersion": "1.0.1 (25)",
        "nativeSha256": "514a5b73d038c264b60cc91fd4a747cf178190c6b2096e6d7007c2020e2b1bca",
        "masterSha256": digests,
        "native": json.loads((ROOT / "packages/scoring/data/formal-scoring-native.json").read_text()),
        "tables": tables,
    }


def main() -> None:
    config = json.loads((ROOT / "config/release-inputs.json").read_text())
    source = next(x for x in config["environments"] if x["id"] == "global-production")
    rules = build_rules(ROOT / source["masterRoot"], source["contentReleaseId"])
    output = ROOT / "packages/scoring/data/formal-scoring-rules.json"
    serialized = json.dumps(rules, ensure_ascii=False, separators=(",", ":")) + "\n"
    output.write_text(serialized)
    # Keep the legacy website projection in sync with the canonical baseline.
    (ROOT / "site/src/data/formal-scoring-rules.json").write_text(serialized)
    print(f"{output}: {sum(map(len, rules['tables'].values()))} rows")


if __name__ == "__main__":
    main()
