import { UnsupportedSkillMechanismError } from './skill-mechanism-error.mjs';
import { createFormationCalculator, requireInteger } from "./formation-power.mjs";

// Ordinary live, All Perfect, full life. Deliberately rejects effects outside
// the audited release instead of silently treating an unknown skill as zero.
export function createFormalSkillResolver(rules, { judgement = 5, dynamic = false } = {}) {
  const t = rules.tables;
  const calculator = createFormationCalculator(rules);
  const byId = (name) => new Map(t[name].map((r) => [r._id, r]));
  const conditions = byId("SkillCondition"), targets = byId("SkillTarget");
  const characters = byId("Character");
  const life = Number(t.LiveSettings.find((r) => r._key === "life_base")._value);
  function conditionFor(group, bandId) {
    // The existing static path validates the release's condition vocabulary.
    const active = matches(group, bandId);
    if (!group) return { kind: 'always', active: true };
    const set = t.SkillConditionSet.find(r => r._group === group);
    const condition = conditions.get(set._conditionIds[0]);
    return condition._conditionType === 2001
      ? { kind: 'life_at_least', threshold: condition._conditionValues[0], positive: condition._isPositive }
      : { kind: 'constant', active };
  }
  function judgementTargets(row) {
    return row._skillTargetIDs.map(id => {
      const target = targets.get(id);
      if (target?._skillTargetType !== 4 || ![1, 2, 3, 4, 5, 6].includes(target._judgement)) throw new UnsupportedSkillMechanismError(`Unsupported judgement target ${id}`);
      return target._judgement;
    });
  }
  function matches(group, bandId) {
    if (!group) return true;
    const sets = t.SkillConditionSet.filter((r) => r._group === group);
    if (!sets.length) throw new Error(`Missing skill condition group ${group}`);
    if (sets.length !== 1 || sets[0]._conditionIds.length !== 1) throw new UnsupportedSkillMechanismError(`Unsupported skill condition group ${group}`);
    const condition = conditions.get(sets[0]._conditionIds[0]);
    if (!condition) throw new Error(`Missing skill condition ${sets[0]._conditionIds[0]}`);
    let positive;
    if (condition?._conditionType === 2001 && condition._conditionValues.length === 1) {
      positive = life >= condition._conditionValues[0];
    } else if (condition?._conditionType === 5000 && condition._conditionTargetIDs.length === 1) {
      const target = targets.get(condition._conditionTargetIDs[0]);
      if (target?._skillTargetType !== 3) throw new UnsupportedSkillMechanismError("Unsupported skill condition target");
      positive = bandId === target._bandID;
    } else throw new UnsupportedSkillMechanismError(`Unsupported skill condition ${condition?._id}`);
    return condition._isPositive ? positive : !positive;
  }
  function effects(table, idField, id, level) {
    if (!id || !level) return [];
    const rows = t[table].filter((r) => r[idField] === id && r._level === level);
    if (!rows.length) throw new Error(`Missing skill ${id} level ${level}`);
    for (const r of rows) {
      for (const field of ["_skillReleaseConditionGroup", "_skillCumulativeConditionID", "_maxEffectValue",
        "_effectExecuteLimitCount", "_effectExecuteLimitResetConditionGroup"]) {
        if (r[field]) throw new UnsupportedSkillMechanismError(`Unsupported skill effect ${r._id}: ${field}`);
      }
    }
    return rows;
  }
  return function resolve(draft) {
    return draft.slots.map((slot, slotIndex) => {
      const member = calculator.card(slot.memberCardId, "member");
      const support = calculator.card(slot.supportCardId, "support");
      const bandId = characters.get(member._characterID)._bandID;
      const growth = draft.modifiers?.growth ?? {};
      const memberLevel = requireInteger(growth[slot.memberCardId]?.skillLevel ?? 1, "member skillLevel", 1, 5);
      const supportRank = requireInteger(growth[slot.supportCardId]?.rank ?? 1, "support rank", 1, 5);
      const rank = t.SupportCardRank.find((r) => r._group === support._supportCardRankGroup && r._rank === supportRank);
      if (!rank) throw new Error("Missing support rank");
      const supportEffects = [1, 2].flatMap((i) => effects("SupportSkillEffect", "_supportSkillID",
        support[`_supportSkillId0${i}`], rank[`_supportSkill0${i}Level`]));
      let extensionMs = 0;
      const supportTrace = supportEffects.map((r) => {
        if (r._skillTriggerConditionGroup !== 53 || r._skillTriggerType !== 1
          || ![15000, 12006, 3001].includes(r._skillEffectType)) throw new UnsupportedSkillMechanismError(`Unsupported support effect ${r._id}`);
        const active = matches(r._skillConditionGroup, bandId);
        if (dynamic && r._skillEffectType !== 12006 && r._effectLimitCount) throw new UnsupportedSkillMechanismError(`Unsupported support limit ${r._id}`);
        // Current ordinary support definitions convert to Perfect only. JUST
        // also needs a note-type window capability gate and remains explicit.
        if (dynamic && r._skillEffectType === 12006 && r._effectValue !== 5) throw new UnsupportedSkillMechanismError(`Unsupported judgement conversion ${r._id}`);
        if (dynamic && r._skillEffectType !== 12006 && (r._skillTargetIDs.length || r._activationTimeSecond !== 0)) throw new UnsupportedSkillMechanismError(`Unsupported support target or duration ${r._id}`);
        if (dynamic && r._skillEffectType === 15000 && conditionFor(r._skillConditionGroup, bandId).kind === 'life_at_least') throw new UnsupportedSkillMechanismError(`Unsupported dynamic duration condition ${r._id}`);
        if (active && r._skillEffectType === 15000) extensionMs = Math.fround(extensionMs + Math.fround(r._effectValue));
        return { id: r._id, type: r._skillEffectType, level: r._level, value: r._effectValue, active,
          ...(dynamic ? { condition: conditionFor(r._skillConditionGroup, bandId), durationRawMs: Math.fround(Math.fround(r._activationTimeSecond) * 1000),
            limitCount: r._effectLimitCount, targets: r._skillEffectType === 12006 ? judgementTargets(r) : [],
            contribution: r._skillEffectType === 15000 ? 'duration_ms' : r._skillEffectType === 3001 ? 'life_recovery' : 'judgement_conversion' } : {
            contribution: r._skillEffectType === 15000 ? "duration_ms" : "no_score_change_at_full_life_all_perfect" }) };
      });
      const liveEffects = effects("LiveSkillEffect", "_liveSkillID", member._liveSkillID, memberLevel).map((r) => {
        if (![2000, 2004].includes(r._skillEffectType) || r._effectLimitCount) throw new UnsupportedSkillMechanismError(`Unsupported live effect ${r._id}`);
        let judgementMatches = true;
        if (r._skillEffectType === 2004) {
          for (const id of r._skillTargetIDs) if (targets.get(id)?._skillTargetType !== 4) throw new UnsupportedSkillMechanismError("Unsupported judgement target");
          judgementMatches = r._skillTargetIDs.some((id) => targets.get(id)._judgement === judgement);
        } else if (r._skillTargetIDs.length) throw new UnsupportedSkillMechanismError("Unsupported score target");
        return { id: r._id, type: r._skillEffectType,
          active: matches(r._skillConditionGroup, bandId) && judgementMatches,
          ...(dynamic ? { condition: conditionFor(r._skillConditionGroup, bandId), targets: r._skillEffectType === 2004 ? judgementTargets(r) : [] } : {}),
          rate: Math.fround(r._effectValue / rules.native.skillValueDivisor),
          // SkillEffectUpdater.UpdateExecuting (0x561f914): float32 duration
          // including extension, then fcvtps when emitting the end timestamp.
          durationRawMs: Math.fround(Math.fround(Math.fround(r._activationTimeSecond) * 1000) + extensionMs),
          durationMs: Math.ceil(Math.fround(Math.fround(Math.fround(r._activationTimeSecond) * 1000) + extensionMs)) };
      });
      return { slotIndex, memberCardId: slot.memberCardId, supportCardId: slot.supportCardId,
        memberLevel, supportLevels: [support._supportSkillId01 ? rank._supportSkill01Level : 0,
          support._supportSkillId02 ? rank._supportSkill02Level : 0],
        extensionMs, liveEffects, supportEffects: supportTrace };
    });
  };
}
