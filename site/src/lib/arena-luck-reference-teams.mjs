import { createFormationCalculator } from '../../../packages/scoring/scoring-rules/formation-power.mjs';
import { compileGekisouEffects } from '../../../packages/scoring/scoring-rules/gekisou-skill-runtime.mjs';

export const luckReferenceLevels = Object.freeze([
  { id: 'developing', label: '技能初阶', level: 1 },
  { id: 'intermediate', label: '技能进阶', level: 3 },
  { id: 'maximum', label: '技能满级', level: 5 }
]);

/** Fixed before candidate exploration, independent of the player's inventory.
 * Four legal seed teams cover power, gauge, RUSH points, and RUSH scoring.
 * These are explicit benchmarks, not estimates of matchmaking frequencies. */
export function createLuckReferenceTeams(rules, candidates) {
  const power = createFormationCalculator(rules);
  const values = candidates.map(candidate => {
    const effects = compileGekisouEffects(rules, candidate.draft, false, [2, 2, 2]).filter(effect => effect.active);
    const total = type => effects.filter(effect => effect.definition._skillEffectType === type).reduce((sum, effect) => sum + effect.definition._effectValue, 0);
    return { candidate, values: [candidate.power, total(11001), total(11002), total(2000)] };
  });
  const seeds = [0, 1, 2, 3].map(index => [...values].sort((a, b) => b.values[index] - a.values[index] || b.candidate.power - a.candidate.power || a.candidate.id.localeCompare(b.candidate.id))[0].candidate);
  return luckReferenceLevels.map(scenario => ({ ...scenario, teams: seeds.map((seed, index) => {
    const draft = structuredClone(seed.draft), growth = {};
    for (const slot of draft.slots) {
      growth[slot.memberCardId] = { ...draft.modifiers.growth[slot.memberCardId], skillLevel: scenario.level, gekisouSkillLevel: scenario.level };
      const support = power.card(slot.supportCardId, 'support');
      const resolved = power.resolveGrowth(support, 'Support', { rank: scenario.level });
      growth[slot.supportCardId] = { rank: scenario.level, level: resolved.level };
    }
    draft.modifiers.growth = growth;
    return { id: `reference-${scenario.id}-${index}`, name: `${scenario.label} · ${['综合力', '涨槽', 'RUSH 点数', 'RUSH 得分'][index]}`,
      draft, power: power.calculate(draft).total.total };
  }) }));
}
