import {
  createCardPowerBP, createCardPowerInt, addCardPower,
  multiplyCardPower, floorCardPower, cardPowerPoints
} from "./card-power.mjs";
import { createEventPipeline } from "./event-rules.mjs";
import { scoringRulesAvailable, referenceScoringRules } from '../scoring-release-gate.mjs';

import {bandItemEffects} from './band-item-totals.mjs';

export const POWER_COMPONENTS = ["performance", "technic", "visual"];
const masterComponents = ["performance", "technic", "visual"];
const zero = () => createCardPowerInt(0, 0, 0);
const uniform = (n) => createCardPowerInt(n, n, n);
const rate = (values) => createCardPowerBP(...values);
const sum = (values) => values.reduce(addCardPower, zero());
const bonus = (base, values) => floorCardPower(multiplyCardPower(base, rate(values)));
const f32 = Math.fround;

export function requireInteger(value, name, min = 0, max = 2147483647) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name}: expected integer ${min}–${max}`);
  }
  return value;
}

function required(rows, predicate, name) {
  const row = rows.find(predicate);
  if (!row) throw new RangeError(`Master input not found: ${name}`);
  return row;
}

export function createFormationCalculator(rules, { eventAdapters = [] } = {}) {
  if (rules?.schemaVersion !== 1 || !scoringRulesAvailable(rules, rules.sourceReleaseId)) {
    throw new Error("Unsupported production rule profile");
  }
  const t = rules.tables;
  const index = (name) => new Map(t[name].map((r) => [r._id, r]));
  const members = index("MemberCard"), supports = index("SupportCard");
  const characters = index("Character"), targets = index("SkillTarget");
  const liveSkills = index("LiveSkill");
  const gekisouSkills = index("GekisouSkill");
  const parameters = new Map(t.Parameter.map((r) => [r._id, Number(r._value)]));
  const param = (name) => requireInteger(parameters.get(name), name);
  const id = (value, kind) => {
    const match = new RegExp(`^(?:${kind}-(?:card-)?)?([0-9]+)$`).exec(String(value));
    if (!match) throw new RangeError(`Invalid ${kind} id: ${value}`);
    return Number(match[1]);
  };
  const card = (value, kind) => {
    const row = (kind === "member" ? members : supports).get(id(value, kind));
    if (!row) throw new RangeError(`Unknown ${kind}: ${value}`);
    return row;
  };
  const getRank = (row, kind, rank) => required(t[`${kind}CardRank`],
    (r) => r._group === row[`_${kind.toLowerCase()}CardRankGroup`] && r._rank === rank,
    `${kind} rank ${rank}`);

  function resolveGrowth(row, kind, input = {}) {
    const rank = requireInteger(input.rank ?? 1, "rank", 1, 5);
    const rankRow = getRank(row, kind, rank);
    const awake = kind === "Member" ? requireInteger(input.awake ?? 1, "awake", 1, 5) : 1;
    const maxLevel = kind === "Member"
      ? required(t.MemberCardLevelLimit, (r) => r._rarity === row._rarity && r._awakeCount === awake,
        "member level limit")._limitLevel
      : rankRow._limitLevel;
    const level = requireInteger(input.level ?? maxLevel, "level", 1, maxLevel);
    const levelRow = required(t[`${kind}CardLevel`], (r) =>
      r._group === row[`_${kind.toLowerCase()}CardLevelGroup`] && r._level === level,
    `${kind} level ${level}`);
    const awakeRow = kind === "Member" ? required(t.MemberCardAwake, (r) =>
      r._group === row._memberCardAwakeGroup && r._awakeCount === awake, "awake") : null;
    const values = masterComponents.map((key) => {
      const max = row[`_${key}PowerMax`];
      // Level: integer product -> float32 -> /10000 -> floor. Rank uses
      // the same order. Awake instead divides the rate before multiplying.
      const leveled = Math.floor(f32(f32(max * levelRow[`_${key}Rate`]) / 10000));
      if (kind === "Support") return leveled; // BP, never absolute points.
      const ranked = Math.floor(f32(f32(max * rankRow[`_${key}Rate`]) / 10000));
      const awakened = Math.floor(f32(f32(f32(awakeRow[`_${key}Rate`]) / 10000) * f32(max)));
      return leveled + ranked + awakened;
    });
    return { rank, awake, level, rankRow, values };
  }

  function matchesTarget(member, targetId) {
    const target = targets.get(targetId);
    if (!target || target._skillTargetType !== 3) throw new Error(`Unsupported power target ${targetId}`);
    const character = characters.get(member._characterID);
    if (!character) throw new Error(`Unknown character ${member._characterID}`);
    if (target._characterID && target._characterID !== member._characterID) return false;
    if (target._bandID && target._bandID !== character._bandID) return false;
    if (target._cardType && target._cardType !== member._cardType) return false;
    if (target._tagID && !member._bestMusicTagIDs.includes(target._tagID)) return false;
    const categories = target._liveSkillCategories ?? [];
    // Display categories group multiple mechanics under one UI label. Leader
    // targets match the actual category (e.g. simple vs combo/accuracy), not it.
    if (categories.length && !categories.some((c) =>
      liveSkills.get(member._liveSkillID)?._skillCategories?.includes(c))) return false;
    if (target._gekisouMissionType) {
      if (![1,2,3].includes(target._gekisouMissionType)) throw new Error(`Unsupported power mission target ${targetId}`);
      const skill = gekisouSkills.get(member._gekisouSkillID);
      if (!skill) throw new Error(`Unknown Gekisou skill ${member._gekisouSkillID}`);
      if (skill._gekisouMissionType !== target._gekisouMissionType) return false;
    }
    if (target._gekisouSkillCategories?.length) {
      throw new Error(`Unsupported power target mechanism ${targetId}`);
    }
    return true;
  }

  function effectRates(member, effects) {
    const values = [0, 0, 0];
    for (const effect of effects) {
      if (effect._skillConditionGroup || effect._skillCumulativeConditionID) {
        throw new Error(`Unsupported conditional power effect ${effect._id}`);
      }
      if (effect._skillTargetIDs.length && !effect._skillTargetIDs.some((n) => matchesTarget(member, n))) continue;
      const component = { 1001: 1, 1002: 2, 1003: 0 }[effect._skillEffectType];
      if (effect._skillEffectType === 1000) values.forEach((_, i) => { values[i] += effect._effectValue; });
      else if (component !== undefined) values[component] += effect._effectValue;
      else throw new Error(`Unsupported power effect ${effect._skillEffectType}`);
    }
    return values;
  }

  function calculate(draft, { sourceReleaseId = rules.sourceReleaseId } = {}) {
    if (sourceReleaseId !== rules.sourceReleaseId) throw new Error("release_mismatch");
    if (!Array.isArray(draft?.slots) || draft.slots.length !== 5) throw new Error("Exactly five slots required");
    const modifiers = draft.modifiers ?? {};
    const event = createEventPipeline(rules, modifiers.event, eventAdapters);
    for (const name of ["growth", "characterRanks", "memoryPoints", "bandItems", "bandItemTotals"]) {
      const value = modifiers[name];
      if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
        throw new TypeError(`Invalid settings: ${name}`);
      }
    }
    const resolved = draft.slots.map((slot, slotIndex) => {
      if (!slot.memberCardId) {
        if (slot.supportCardId) throw new Error(`Slot ${slotIndex + 1}: support needs a member`);
        return null;
      }
      const member = card(slot.memberCardId, "member");
      const support = slot.supportCardId ? card(slot.supportCardId, "support") : null;
      const memberGrowth = resolveGrowth(member, "Member", modifiers.growth?.[slot.memberCardId]);
      const supportGrowth = support ? resolveGrowth(support, "Support", modifiers.growth?.[slot.supportCardId]) : null;
      return { slotIndex, member, support, memberGrowth, supportGrowth };
    });
    for (const kind of ["member", "support"]) {
      const ids = resolved.filter((r) => r?.[kind]).map((r) => r[kind]._id);
      if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${kind} card in formation`);
    }
    const characterIds = resolved.filter(Boolean).map((r) => r.member._characterID);
    if (new Set(characterIds).size !== characterIds.length) throw new Error("Duplicate character: 同名角色不能同时上阵");
    const song = event.apply("song_context", draft.selectedSongId ? required(t.LiveMusic,
      (r) => r._id === id(draft.selectedSongId, "music"), "song") : null, { draft });
    const leader = resolved[2]; // SingletonCardParameterCalculator 0x6084f2c
    const leaderEffects = leader ? t.LeaderSkillEffect.filter((r) =>
      r._leaderSkillID === leader.member._leaderSkillID && r._level === leader.memberGrowth.rankRow._leaderSkillLevel) : [];
    if (leader && !leaderEffects.length) throw new Error("Missing leader effects");
    const bandEffects = bandItemEffects(rules,modifiers);
    const rankValues = t.Character.map((c) => requireInteger(modifiers.characterRanks?.[c._id] ?? 1,
      "character rank", 1, 50));
    const totalRank = rankValues.reduce((a, b) => a + b, 0);
    const totalRankBonus = [...t.CharacterTotalRank].filter((r) => r._totalRank <= totalRank)
      .sort((a, b) => b._totalRank - a._totalRank)[0]?._bonus ?? 0;
    const vipRank = requireInteger(modifiers.tgwCardRank ?? 1, "T.G.W rank", 1, 21);
    const vip = t.VipRankBonus.find((r) => r._vipRank === vipRank && r._vipBonusType === 7);
    const vipValue = vip?._value ?? vip?._bonusValue;
    if (vipRank !== 1 && !Number.isSafeInteger(vipValue)) throw new Error(`Missing T.G.W bonus ${vipRank}`);

    const slots = resolved.map((entry) => {
      if (!entry) return null;
      const { member, support, memberGrowth, supportGrowth, slotIndex } = entry;
      const memberValues = event.apply("member_power", memberGrowth.values, { draft, member, support, slotIndex });
      if (!Array.isArray(memberValues) || memberValues.length !== 3) throw new Error("Invalid event member power");
      memberValues.forEach(v => requireInteger(v, "event member power"));
      const memberBase = createCardPowerInt(...memberValues);
      const rank = modifiers.characterRanks?.[member._characterID] ?? 1;
      const rankBonus = required(t.CharacterRank, (r) => r._rank === rank, "character rank")._bonus;
      const memoryPoints = requireInteger(modifiers.memoryPoints?.[member._characterID] ?? 0, "memory points");
      const memory = uniform(memoryPoints);
      const characterRank = uniform(rankBonus), characterTotalRank = uniform(totalRankBonus);
      // CalculateSlotPower sp+0x958: member + both rank bonuses + memory.
      // Each percentage below independently uses this base, before other bonuses.
      const base = sum([memberBase, characterRank, characterTotalRank, memory]);
      const supportRates = event.apply("support_power", supportGrowth?.values ?? [0, 0, 0], { draft, member, support, slotIndex });
      if (!Array.isArray(supportRates) || supportRates.length !== 3) throw new Error("Invalid event support power");
      supportRates.forEach(v => requireInteger(v, "event support power"));
      const linkRate = support && support._cardType === member._cardType
        ? param("type_link_base_bonus_rate") + supportGrowth.rankRow._cardTypeLinkBonusRate : 0;
      // CustomMemberCard.get_MusicType returns MasterMemberCard._cardType,
      // not the character's band (0x62f6b90 / 0x58f0860).
      const musicType = member._cardType;
      const musicRate = song && (musicType === 99 || song._musicType === 99 || song._musicType === musicType)
        ? param("music_type_base_bonus_rate") + memberGrowth.rankRow._musicTypeBonusRate : 0;
      const tagRate = song && member._bestMusicTagIDs.some((tag) => song._bestMusicTagIDs.includes(tag))
        ? param("music_tag_base_bonus_rate") + memberGrowth.rankRow._musicTagBonusRate : 0;
      const rates = {
        support: supportRates,
        typeLink: [linkRate, linkRate, linkRate],
        bandItems: effectRates(member, bandEffects),
        leader: effectRates(member, leaderEffects),
        musicType: [musicRate, musicRate, musicRate],
        musicTag: [tagRate, tagRate, tagRate],
        tgw: [vipValue ?? 0, vipValue ?? 0, vipValue ?? 0]
      };
      const breakdown = { member: memberBase, characterRank, characterTotalRank, memory,
        ...Object.fromEntries(Object.entries(rates).map(([name, values]) => [name, bonus(base, values)])) };
      return {
        slotIndex, memberCardId: draft.slots[slotIndex].memberCardId, supportCardId: draft.slots[slotIndex].supportCardId ?? null,
        growth: { member: { level: memberGrowth.level, rank: memberGrowth.rank, awake: memberGrowth.awake },
          support: supportGrowth ? { level: supportGrowth.level, rank: supportGrowth.rank } : null },
        bonusBase: cardPowerPoints(base), ratesBP: rates,
        breakdown: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, cardPowerPoints(v)])),
        total: cardPowerPoints(sum(Object.values(breakdown)))
      };
    });
    const breakdown = {};
    for (const slot of slots.filter(Boolean)) {
      for (const [name, value] of Object.entries(slot.breakdown)) {
        const total = breakdown[name] ??= { performance: 0, technic: 0, visual: 0, total: 0 };
        for (const key of [...POWER_COMPONENTS, "total"]) total[key] += value[key];
      }
    }
    const total = { performance: 0, technic: 0, visual: 0, total: 0 };
    for (const value of Object.values(breakdown)) for (const key of Object.keys(total)) total[key] += value[key];
    return { status: referenceScoringRules(rules) ? 'estimated' : 'code_calculated', verificationStatus: rules.verificationStatus, sourceReleaseId,
      ruleSetVersion: rules.ruleSetVersion, leaderSlotIndex: 2, total, breakdown, slots, event: event.context,
      assumptions: ["Unspecified growth: rank 1, awake 1, maximum level at that awake/rank",
        "Unspecified character ranks: 1; T.G.W: 1; instruments and memory: 0", event.context.id == null ? "No event power bonus" : `Event ${event.context.id} applied by version-bound adapter`] };
  }
  return { calculate, resolveGrowth, card, matchesTarget, effectRates };
}
