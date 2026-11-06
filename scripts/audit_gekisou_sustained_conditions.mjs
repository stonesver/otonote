/** Read-only inventory and current-runtime probes for the sustained COMBO gap.
 * Optional argument: a private directory containing Master<Table>.json files.
 * Expected bonuses below express the proposed contract, not a native oracle.
 * The runtime is imported unchanged; no page or scoring data is rewritten.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { compileGekisouEffects, createGekisouEffectState, advanceGekisouEffect }
  from '../packages/scoring/scoring-rules/gekisou-skill-runtime.mjs';

const rules = JSON.parse(readFileSync(new URL('../packages/scoring/data/formal-scoring-rules.json', import.meta.url)));
const families = ['LeaderSkill', 'LiveSkill', 'SupportSkill', 'GekisouSkill', 'GekisouSupportSkill'];
const roles = ['_skillTriggerConditionGroup', '_skillConditionGroup',
  '_skillReleaseConditionGroup', '_effectExecuteLimitResetConditionGroup'];
const conditions = (tables, row, role) => tables.SkillConditionSet
  .filter(set => row[role] && set._group === row[role])
  .map(set => ({ ...set, conditions: set._conditionIds.map(id => tables.SkillCondition.find(c => c._id === id)) }));
const closure = (tables, row) => ({ row,
  conditions: Object.fromEntries(roles.map(role => [role, conditions(tables, row, role)])) });

function inventory(tables) {
  const hits = [], sustained = [];
  const counts = Object.fromEntries(families.map(family => {
    const rows = tables[`${family}Effect`];
    const idKey = `_${family[0].toLowerCase()}${family.slice(1)}ID`;
    for (const row of rows) {
      const groups = Object.fromEntries(roles.map(role => [role, conditions(tables, row, role)]));
      for (const role of roles) {
        if (groups[role].some(set => set.conditions.some(c => c._conditionType === 7005))) {
          hits.push({ table: `${family}Effect`, skillId: row[idKey], effectId: row._id,
            level: row._level, role, definition: closure(tables, row) });
        }
      }
      if (row._skillTriggerType === 2) sustained.push({ table: `${family}Effect`, effectId: row._id,
        duration: row._activationTimeSecond,
        triggerTypes: [...new Set(groups._skillTriggerConditionGroup.flatMap(s => s.conditions.map(c => c._conditionType)))].sort(),
        eligibilityTypes: [...new Set(groups._skillConditionGroup.flatMap(s => s.conditions.map(c => c._conditionType)))].sort() });
    }
    return [family, { effects: rows.length, definitions: new Set(rows.map(r => r[idKey])).size }];
  }));
  const skillIds = [...new Set(hits.filter(h => h.table === 'GekisouSkillEffect').map(h => h.skillId))];
  const shapes = {};
  for (const row of sustained) {
    const key = `${row.table}: trigger=${row.triggerTypes}, eligibility=${row.eligibilityTypes}, seconds=${row.duration}`;
    shapes[key] = (shapes[key] ?? 0) + 1;
  }
  return { counts, members: tables.MemberCard.length, supports: tables.SupportCard.length,
    comboConditionOccurrences: hits.length, sustainedRows: sustained.length, shapes,
    affected: skillIds.map(skillId => ({ skillId,
      effectIds: hits.filter(h => h.skillId === skillId && h.table === 'GekisouSkillEffect').map(h => h.effectId),
      memberIds: tables.MemberCard.filter(c => c._gekisouSkillID === skillId).map(c => c._id) })), hits };
}

function probe(skillId, level, scenario) {
  const member = rules.tables.MemberCard.find(c => c._gekisouSkillID === skillId);
  // Skill 12 has no card reference. Bind it to a copy solely to exercise its real rows.
  const probeRules = member ? rules : { ...rules, tables: { ...rules.tables,
    MemberCard: rules.tables.MemberCard.map(c => c._id === 53 ? { ...c, _gekisouSkillID: skillId } : c) } };
  const id = `member-card-${member?._id ?? 53}`;
  const effects = compileGekisouEffects(probeRules, { slots: [{ memberCardId: id, supportCardId: 'support-card-1' }],
    modifiers: { growth: { [id]: { gekisouSkillLevel: level } } } }, true)
    .filter(e => e.kind === 'member').map(e => createGekisouEffectState(e));
  const first = conditions(rules.tables, effects[0].definition, '_skillTriggerConditionGroup')[0].conditions;
  const threshold = first.find(c => c._conditionType === 7005)._conditionValues[0];
  const lifeThreshold = first.find(c => c._conditionType === 2001)?._conditionValues[0];
  const high = lifeThreshold ?? 1000, low = high - 1;
  const inputs = scenario === 'combo'
    ? [[threshold - 1, high], [threshold, high], [threshold + 1, high], [0, high], [threshold, high], [0, high]]
    : scenario === 'life-down'
      ? [[1, high], [1, low], [1, high], [0, high], [1, low]]
      : [[1, low], [1, high], [1, low], [0, low], [1, high]];
  let bonus = 0;
  const frames = inputs.map(([combo, life], i) => {
    const timeMs = 1010 + i * 10;
    const commands = [];
    const ctx = { section: { combo, previousLots: [], settleFrame: 3000, startMs: 1000, history: [{ timeMs: timeMs - 1 }] },
      frame: timeMs, timeMs, life, notes: [], entering: false, closing: false,
      clock: { at: frame => ({ timeMs: frame }), indexAt: ms => ms }, random: () => .5,
      dirty() {}, factor() {}, trace() {}, count(effect, at, value) {
        bonus += value;
        commands.push({ effectId: effect.definition._id, timeMs: at, value,
          expectedTimeMs: value < 0 || lifeThreshold !== undefined ? timeMs : timeMs - 1 });
      } };
    for (const effect of effects) advanceGekisouEffect(effect, ctx);
    // Deterministic state target; does not assert native frame/command timing.
    const expectedBonus = effects.filter(e => e.programs._skillTriggerConditionGroup.match(ctx))
      .reduce((sum, e) => sum + e.definition._effectValue, 0);
    return { combo, life, expectedBonus, runtimeBonus: bonus, commands,
      executing: effects.filter(e => e.executing).map(e => e.definition._id) };
  });
  return { skillId, level, scenario, syntheticBinding: !member,
    effectIds: effects.map(e => e.definition._id), mismatches: frames.filter(f => f.expectedBonus !== f.runtimeBonus).length,
    timestampMismatches: frames.flatMap(f => f.commands).filter(c => c.timeMs !== c.expectedTimeMs).length, frames };
}

const formal = inventory(rules.tables);
const cases = formal.affected.flatMap(({ skillId }) => [1, 2, 3, 4, 5].flatMap(level =>
  (skillId === 18 || skillId === 19 ? ['combo', 'life-down', 'life-up'] : ['combo'])
    .map(scenario => probe(skillId, level, scenario))));
const output = { ruleSetVersion: rules.ruleSetVersion, formal,
  replay: { cases: cases.length, casesWithMismatch: cases.filter(c => c.mismatches).length,
    coveredEffectIds: [...new Set(cases.flatMap(c => c.effectIds))].sort((a, b) => a - b),
    expectationSource: 'contract state targets, not independent native execution', results: cases } };
if (process.argv[2]) {
  const names = [...families.map(f => `${f}Effect`), 'SkillConditionSet', 'SkillCondition', 'MemberCard', 'SupportCard'];
  const tables = Object.fromEntries(names.map(name => [name,
    JSON.parse(readFileSync(join(process.argv[2], `Master${name}.json`)))._allData]));
  output.master = inventory(tables);
  output.master.sameAffectedDefinitionsAndConditions = isDeepStrictEqual(formal.hits, output.master.hits);
}
// Keep raw table/condition closures out of the report; used only for equality above.
delete formal.hits;
if (output.master) delete output.master.hits;
console.log(JSON.stringify(output, null, 2));
