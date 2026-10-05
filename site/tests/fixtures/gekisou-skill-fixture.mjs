import { readFileSync } from 'node:fs';
import { createTeamDraft } from '../../src/lib/team-draft.mjs';
import { createGekisouSongCalculator } from '../../../packages/scoring/scoring-rules/gekisou-song-score.mjs';
import { createPerformanceTemplate } from '../../../packages/scoring/scoring-rules/formal-performance-replay.mjs';
import { compileGekisouEffects } from '../../../packages/scoring/scoring-rules/gekisou-skill-runtime.mjs';

const baseline = JSON.parse(readFileSync(new URL('../../../packages/scoring/data/formal-scoring-rules.json', import.meta.url)));

// Authored fixture for the newly published LUCK skill's two effects. Keep the
// regression offline: the tracked rules predate member 64 / Gekisou skill 22.
export function fixture({ missions = [2, 2, 2], duration = 3, reduction = 2000, copies = 1 } = {}) {
  const rules = structuredClone(baseline), skillId = 900004;
  rules.tables.MemberCard = rules.tables.MemberCard.filter(row => row._id >= 1 && row._id <= 5);
  rules.tables.SupportCard = rules.tables.SupportCard.filter(row => row._id >= 1 && row._id <= 5);
  for (const [i, member] of rules.tables.MemberCard.entries()) member._gekisouSkillID = i < copies ? skillId : 0;
  for (const support of rules.tables.SupportCard) {
    support._supportSkillId01 = support._supportSkillId02 = 0;
    support._gekisouSupportSkillId01 = support._gekisouSupportSkillId02 = 0;
  }
  for (const effect of rules.tables.LiveSkillEffect) effect._effectValue = 0;
  const music = rules.tables.LiveMusic.find(row => row._id === 100001);
  missions.forEach((mission, i) => { music[`_gekisouMission${i + 1}`] = mission; });
  rules.tables.GekisouSkill.push({ _id: skillId, _gekisouMissionType: 2 });
  rules.tables.SkillCondition.push({ _id: skillId, _conditionType: duration ? 7010 : 7020,
    _conditionValues: [], _isPositive: true, _conditionTargetIDs: [] });
  rules.tables.SkillConditionSet.push({ _id: skillId, _group: skillId, _conditionIds: [skillId] });
  for (const [i, type] of [11001, 3004].entries()) rules.tables.GekisouSkillEffect.push({
    _id: skillId + i, _gekisouSkillID: skillId, _level: 1, _skillEffectType: type,
    _skillTriggerConditionGroup: skillId, _skillTriggerType: duration ? 1 : 2,
    _skillConditionGroup: 0, _skillReleaseConditionGroup: 0, _skillTargetIDs: [],
    _activationTimeSecond: duration, _effectValue: type === 3004 ? reduction : 20000,
    _maxEffectValue: 0, _effectLimitCount: 0, _skillCumulativeConditionID: 0,
    _effectExecuteLimitCount: 0, _effectExecuteLimitResetConditionGroup: 0,
  });
  const chart = { id: 'music-chart-10000103', trackId: 'music-100001', difficulty: 'expert',
    sourceReleaseId: rules.sourceReleaseId, bpmEvents: [{ tick: 0, bpm: 125 }],
    skillTimings: [1, 3, 5, 7, 9], feverRanges: [{ start: 1, end: 6 }, { start: 8, end: 9 }, { start: 10, end: 11 }],
    notes: [900, 1000, 1100, 3900, 4200, 5900, 6900, 8100, 9900, 10100, 11900]
      .map((tick, i) => ({ id: `reduction-${i}`, type: 'tap', tick, position: 0, size: 1 })) };
  const draft = createTeamDraft({ selectedSongId: chart.trackId, selectedDifficulty: chart.difficulty,
    slots: [1, 2, 3, 4, 5].map(id => ({ memberCardId: `member-card-${id}`, supportCardId: `support-card-${id}` })) });
  return { rules, chart, draft };
}
export function withoutReduction(rules) {
  const copy = structuredClone(rules);
  copy.tables.GekisouSkillEffect = copy.tables.GekisouSkillEffect.filter(row => row._skillEffectType !== 3004);
  return copy;
}
export function replay(context, damagedIndices, judgement = 1) {
  const { rules, chart, draft } = context;
  const performance = createPerformanceTemplate(rules, chart);
  for (const index of damagedIndices) performance.judgements[index].judgement = judgement;
  return createGekisouSongCalculator(rules, chart, { performance }).calculate(draft, { includeTrace: true });
}

// New combinations use real Master rows and the public compilation path.
// Tests must not fabricate private replay state to bypass validation.
export function compileTestEffect(rules, { type, missionType = 3, key = 'support:0:test', targets = [],
  definition = {}, trigger = [[{ type: 7010 }]], condition = [], release = [], reset = [], cumulative = null } = {}) {
  const r = structuredClone(rules), id = 900010;
  r.tables.MemberCard.find(c => c._id === 1)._gekisouSkillID = id;
  const support = r.tables.SupportCard.find(c => c._id === 1);
  support._gekisouSupportSkillId01 = support._gekisouSupportSkillId02 = 0;
  r.tables.GekisouSkill.push({ _id: id, _gekisouMissionType: missionType });
  const row = { _id: id, _gekisouSkillID: id, _level: 1, _skillEffectType: type,
    _skillTriggerType: 1, _activationTimeSecond: 1, _effectValue: 10000, _effectLimitCount: 0,
    _effectExecuteLimitCount: 0, _maxEffectValue: 0, _skillCumulativeConditionID: 0,
    _skillTargetIDs: targets.map(j => r.tables.SkillTarget.find(t => t._skillTargetType === 4 && t._judgement === j)._id), ...definition };
  let nextId = id;
  if (cumulative) {
    row._skillCumulativeConditionID = ++nextId;
    r.tables.SkillCumulativeCondition.push({ _id: row._skillCumulativeConditionID, ...cumulative });
  }
  for (const [field, sets] of Object.entries({ _skillTriggerConditionGroup: trigger, _skillConditionGroup: condition,
    _skillReleaseConditionGroup: release, _effectExecuteLimitResetConditionGroup: reset })) {
    row[field] = sets.length ? ++nextId : 0;
    for (const conditions of sets) {
      const rows = conditions.map(c => ({ _id: ++nextId, _conditionType: c.type, _conditionValues: c.value == null ? [] : [c.value],
        _isPositive: c.positive ?? true, _conditionTargetIDs: c.targetIds ?? [] }));
      r.tables.SkillCondition.push(...rows);
      r.tables.SkillConditionSet.push({ _id: ++nextId, _group: row[field], _conditionIds: rows.map(c => c._id) });
    }
  }
  r.tables.GekisouSkillEffect.push(row);
  const [compiled] = compileGekisouEffects(r, { slots: [{ memberCardId: 'member-card-1', supportCardId: 'support-card-1' }] }, true);
  return { ...compiled, key };
}
