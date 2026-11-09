import { compileGekisouEffects } from '../../../packages/scoring/scoring-rules/gekisou-skill-runtime.mjs';
import { maximumPairing } from './scoring-rules/maximum-pairing.mjs';
import { SearchQueue } from './scoring-rules/search-queue.mjs';

export const arenaSkillRoles = { count: '计数', window: '扩窗', conversion: '转换', score: '得分' };
const effectRoles = { 13000: 'count', 13002: 'count', 4004: 'window', 13005: 'conversion', 2000: 'score', 2001: 'score' };
const kinds = ['member', 'support'];

export function normalizeArenaSkillPreferences(value = {}) {
  const preference = value.preference ?? 'none', limits = {};
  if (preference !== 'none' && !Object.hasOwn(arenaSkillRoles, preference)) throw Error('未知的技能偏好');
  for (const kind of kinds) {
    limits[kind] = {};
    for (const role of Object.keys(arenaSkillRoles)) {
      const { min = 0, max = 5 } = value.limits?.[kind]?.[role] ?? {};
      if (![min, max].every(n => Number.isInteger(n) && n >= 0 && n <= 5) || min > max)
        throw Error(`${kind === 'member' ? '成员' : '留影'}${arenaSkillRoles[role]}数量须为 0–5，且最少不能超过最多`);
      limits[kind][role] = { min, max };
    }
  }
  return { preference, limits };
}

/** All arena members belong to the selected band. The scoring compiler's
 * static eligibility depends on that paired band and the card's actual level;
 * LIFE/interval conditions remain conditional, not promised activations. */
export function createArenaSkillPolicy(rules, input, settings) {
  const limits = kinds.flatMap(kind => Object.entries(settings.limits[kind])
    .filter(([, range]) => range.min > 0 || range.max < 5).map(([role, range]) => ({ kind, role, ...range })));
  if (!limits.length && settings.preference === 'none') return null;
  const roles = new Map(), firstMember = input.inventory.memberCardIds[0], firstSupport = input.inventory.supportCardIds[0];
  for (const kind of kinds) for (const id of input.inventory[`${kind}CardIds`]) {
    const slot = { memberCardId: kind === 'member' ? id : firstMember, supportCardId: kind === 'support' ? id : firstSupport };
    const effects = compileGekisouEffects(rules, { ...input.draft, slots: [slot] }, true, [3]);
    roles.set(id, new Set(effects.filter(e => e.sourceCardId === id && e.active)
      .map(e => effectRoles[e.definition._skillEffectType]).filter(Boolean)));
  }
  const has = (id, role) => roles.get(id).has(role);
  const counts = edges => Object.fromEntries(kinds.map(kind => [kind, Object.fromEntries(Object.keys(arenaSkillRoles)
    .map(role => [role, edges.filter(edge => has(edge[kind], role)).length]))]));
  return { limits, has, counts, preference: settings.preference };
}

/** Partition card choices only when a count bound is violated. Every valid
 * team omits at least one offending card; required prefixes make branches
 * disjoint. Matching remains the existing exact character/pairing solver. */
export async function matchArenaSkills(options, policy, yieldControl) {
  if (!policy?.limits.length) return maximumPairing(options);
  const { limits, has } = policy;
  const edges = options.edges.filter(edge => limits.every(({ kind, role, min, max }) =>
    (max !== 0 || !has(edge[kind], role)) && (min !== 5 || has(edge[kind], role))));
  const queue = new SearchQueue([], (a, b) => b.match.weight - a.match.weight);
  const visit = state => {
    const available = edges.filter(edge => !state.banned.member.has(edge.member) && !state.banned.support.has(edge.support));
    for (const { kind, role, min, max } of limits) {
      const required = state[kind === 'member' ? 'requiredMembers' : 'requiredSupports'];
      const eligible = new Set(available.filter(edge => has(edge[kind], role)).map(edge => edge[kind]));
      if (required.filter(id => has(id, role)).length > max || eligible.size < min
        || required.filter(id => !has(id, role)).length > 5 - min) return;
    }
    const match = maximumPairing({ ...options, ...state, edges: available });
    if (match) queue.push({ state, match });
  };
  visit({ requiredMembers: options.requiredMembers ?? [], requiredSupports: options.requiredSupports ?? [],
    banned: { member: new Set(), support: new Set() } });
  while (queue.length) {
    const { state, match } = queue.pop(), counts = policy.counts(match.edges);
    const violation = limits.find(({ kind, role, min, max }) => counts[kind][role] < min || counts[kind][role] > max);
    if (!violation) return match;
    const { kind, role, max } = violation, tooMany = counts[kind][role] > max;
    const key = kind === 'member' ? 'requiredMembers' : 'requiredSupports';
    const offenders = match.edges.map(edge => edge[kind]).filter(id => has(id, role) === tooMany && !state[key].includes(id));
    for (const [i, id] of offenders.entries()) {
      visit({ ...state, [key]: [...state[key], ...offenders.slice(0, i)],
        banned: { ...state.banned, [kind]: new Set([...state.banned[kind], id]) } });
      await yieldControl();
    }
  }
  return null;
}

export function arenaPreferredCandidate(candidates, preference) {
  if (preference === 'none') return null;
  const count = candidate => candidate.skillCounts.member[preference] + candidate.skillCounts.support[preference];
  // Candidates already have comprehensive order, which breaks equal counts.
  const best = candidates.reduce((best, candidate) => !best || count(candidate) > count(best) ? candidate : best, null);
  return best && count(best) > 0 ? best.id : null;
}
