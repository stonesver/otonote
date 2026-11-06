import { cardSkillRows } from './calculator-card-model.mjs';
import { resolveGekisouSkills } from './scoring-rules/gekisou-rules.mjs';
import { compileGekisouEffects } from '../../../packages/scoring/scoring-rules/gekisou-skill-runtime.mjs';

export const arenaMissionNames = { 1: 'COMBO', 2: 'LUCK', 3: 'JUST' };
const roles = { 13000: '计数', 13002: '计数', 12000: '计数', 13005: '转换', 12006: '转换',
  4004: '扩窗', 2000: '得分', 2001: '得分', 12004: '连击保护', 3004: '减伤',
  11001: '抽选条', 11003: '抽选条', 11002: '点数', 11005: '抽选保底' };
const judgementNames = { 1: 'MISS', 2: 'BAD', 3: 'GOOD', 4: 'GREAT', 5: 'PERFECT', 6: 'JUST' };
const conditions = sets => sets.flatMap(set => set.conditions);
const conditionShape = sets => sets.map(set => set.conditions.filter(c => c._conditionType !== 5000)
  .map(c => [c._conditionType, c._conditionValues, c._isPositive, c._conditionTargetIDs]));

function effectCopy(effect, rules) {
  const d = effect.definition, trigger = conditions(effect.conditions._skillTriggerConditionGroup);
  const gates = conditions(effect.conditions._skillConditionGroup).filter(c => c._conditionType !== 5000);
  const release = conditions(effect.conditions._skillReleaseConditionGroup);
  const resets = conditions(effect.conditions._effectExecuteLimitResetConditionGroup);
  // Keep the original text when the short template cannot express the whole contract.
  if (Object.values(effect.conditions).some(sets => sets.length > 1)
    || gates.some(c => c._conditionType !== 2001)
    || trigger.some(c => ![7010, 7020, 1030].includes(c._conditionType) || !c._isPositive)
    || release.some(c => c._conditionType !== 7013 || !c._isPositive)
    || resets.some(c => ![7010, 7013].includes(c._conditionType) || !c._isPositive)) return null;
  const targetNames = ids => {
    const targets = ids.map(id => rules.tables.SkillTarget.find(t => t._id === id)._judgement);
    return targets.length === 5 && [1, 2, 3, 4, 5].every(v => targets.includes(v))
      ? 'PERFECT～MISS' : targets.map(v => judgementNames[v]).join('／');
  };
  const entry = trigger.some(c => c._conditionType === 7010);
  const gate = gates.map(c => `${entry ? '入段 ' : ''}LIFE ${c._isPositive ? '≥' : '<'} ${c._conditionValues[0]}`).join('，');
  const duration = d._activationTimeSecond > 0 && d._activationTimeSecond < 9999
    ? `开段 ${d._activationTimeSecond} 秒` : '全段';
  const prefix = [duration, gate].filter(Boolean).join('，');
  const type = d._skillEffectType, interval = trigger.find(c => c._conditionType === 1030);
  if (interval && type !== 13005) return null;
  if ([13000, 12000].includes(type)) return `${prefix}：每次${type === 13000 ? ' JUST' : ' COMBO'} 额外 +${d._effectValue}`;
  if (type === 4004) return `${prefix}：判定窗 +${d._effectValue / 100}%`;
  if (type === 2000) return `${prefix}：得分 +${d._effectValue / 100}%`;
  if (type === 13005 && interval) {
    const limit = d._effectExecuteLimitCount ? `；${resets.length ? '每段' : '整曲'}最多 ${d._effectExecuteLimitCount} 轮` : '';
    const window = duration === '全段' ? '' : `（${d._activationTimeSecond} 秒内）`;
    const eligibility = gate ? `${gate}：` : '';
    const amount = d._effectLimitCount ? `下 ${d._effectLimitCount} 次` : '后续';
    return `${eligibility}每 ${interval._conditionValues[0]} 次 ${targetNames(interval._conditionTargetIDs)}，${amount} ${targetNames(d._skillTargetIDs)} → JUST${window}${limit}`;
  }
  if ([13002, 2001].includes(type) && effect.cumulative?._skillCumulativeConditionType === 1000) {
    const c = effect.cumulative;
    const cap = Math.min(d._maxEffectValue || Infinity, c._maxCumulativeCount * d._effectValue);
    const percent = type === 2001, unit = percent ? '%' : '', divisor = percent ? 100 : 1;
    const when = duration === '全段' && !gate ? '' : `${prefix}：`;
    return `${when}每 ${c._conditionValues[0]} 次 ${targetNames(c._conditionTargetIDs)}，${percent ? '得分' : '额外计数'} +${d._effectValue / divisor}${unit}（最多 +${cap / divisor}${unit}）`;
  }
  return null;
}

/** Use the same level/rank resolver and conditional skill compiler as scoring.
 * Only additive effects with identical activation/lifetime rules are summed. */
export function buildArenaTeamSkills(rules, draft, cards, missions) {
  const resolved = resolveGekisouSkills(rules, draft), byCard = new Map(), publicRows = new Map();
  const effects = compileGekisouEffects(rules, draft, true, missions).filter(e => e.active);
  for (const slot of draft.slots) for (const kind of ['member', 'support']) {
    const id = slot[`${kind}CardId`], card = cards.get(id);
    const native = rules.tables[kind === 'member' ? 'MemberCard' : 'SupportCard'].find(c => c._id === card.masterId);
    const rows = cardSkillRows(card, rules, draft.modifiers.growth[id]).filter(s => s.kind.startsWith('gekisou')).map(row => {
      const skillId = kind === 'member' ? native._gekisouSkillID : native[`_gekisouSupportSkillId0${row.slot.at(-1)}`];
      const skill = resolved.find(s => s.sourceCardId === id && s.id === skillId);
      const types = [...new Set(skill.effects.map(e => roles[e.definition._skillEffectType] ?? '其他'))];
      const active = missions.includes(row.mission);
      const selected = effects.filter(e => e.sourceCardId === id && skill.effects.some(s => s.definition._id === e.definition._id));
      const copies = selected.map(effect => effectCopy(effect, rules));
      const compactSummary = !active ? '' : !selected.length ? '当前配对不触发'
        : copies.every(Boolean) ? [...new Set(copies)].join('；') : row.summary;
      const value = { ...row, types, active, compactSummary };
      for (const e of skill.effects) publicRows.set(`${id}:${e.definition._id}`, value);
      return value;
    });
    byCard.set(id, rows);
  }
  const grouped = new Map();
  for (const effect of effects) {
    const d = effect.definition, row = publicRows.get(`${effect.sourceCardId}:${d._id}`);
    const copy = effectCopy(effect, rules), additive = copy && [13000, 12000, 4004, 2000].includes(d._skillEffectType);
    const { _id, _gekisouSkillID, _gekisouSupportSkillID, _level, _effectValue, ...definition } = d;
    const key = additive ? JSON.stringify([effect.missionType, definition, Object.values(effect.conditions).map(conditionShape)])
      : `${effect.sourceCardId}:${d._skillEffectType}:${copy ?? row.summary}`;
    if (!grouped.has(key)) grouped.set(key, { effect, value: 0, sources: new Set(), row, copy, additive });
    const group = grouped.get(key); group.value += d._effectValue; group.sources.add(effect.sourceCardId);
  }
  const groups = new Map();
  for (const group of grouped.values()) {
    const { effect, sources, row } = group, role = roles[effect.definition._skillEffectType] ?? '其他';
    const key = `${effect.missionType}:${role}`;
    if (!groups.has(key)) groups.set(key, { mission: effect.missionType, role, sources: new Set(), entries: [] });
    const target = groups.get(key); sources.forEach(id => target.sources.add(id));
    target.entries.push({ text: group.additive ? effectCopy({ ...effect, definition: { ...effect.definition, _effectValue: group.value } }, rules) : group.copy ?? row.summary,
      sources: [...sources] });
  }
  return { byCard, groups: [...groups.values()].map(g => ({ ...g, sources: [...g.sources] })) };
}
