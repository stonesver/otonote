import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectPublishedSkillsCompatibility } from '../../packages/scoring/scoring-rules/scoring-compatibility.mjs';

const baseline = JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json', import.meta.url)));
const catalog = { memberCards: baseline.tables.MemberCard.map(row => ({ id: `member-card-${row._id}` })),
  supportCards: baseline.tables.SupportCard.map(row => ({ id: `support-card-${row._id}` })) };
const memberEffect = rules => rules.tables.GekisouSkillEffect.find(row => row._gekisouSkillID === rules.tables.MemberCard[0]._gekisouSkillID && row._level === 5);

test('all public levels report compatibility without coupling content publication to scoring', () => {
  const result = inspectPublishedSkillsCompatibility(baseline, catalog);
  assert.equal(result.checks, (catalog.memberCards.length + catalog.supportCards.length - 1) * 5);
  assert.equal(result.status, 'compatible');
  assert.deepEqual(result.issues, []);
});
test('a new level-five mechanism is reported with its public card and level', () => {
  const rules = structuredClone(baseline);
  memberEffect(rules)._skillEffectType = 98765;
  const result = inspectPublishedSkillsCompatibility(rules, catalog);
  assert.equal(result.status, 'partial');
  assert.ok(result.issues.some(i => i.memberCardId === 'member-card-1' && i.level === 5 &&
    i.code === 'unsupported_skill_mechanism' && /effect 98765/.test(i.message)));
  assert.equal(result.checks, inspectPublishedSkillsCompatibility(baseline, catalog).checks);
});
test('conditions, cumulative rules and missing level data are distinguished in diagnostics', () => {
  for (const change of ['condition', 'cumulative', 'missing']) {
    const rules = structuredClone(baseline), effect = memberEffect(rules);
    if (change === 'condition') {
      effect._skillConditionGroup = 98765;
      rules.tables.SkillConditionSet.push({ _id: 98765, _group: 98765, _conditionIds: [98765] });
      rules.tables.SkillCondition.push({ _id: 98765, _conditionType: 98765 });
    } else if (change === 'cumulative') {
      effect._skillCumulativeConditionID = 98765;
      rules.tables.SkillCumulativeCondition.push({ _id: 98765, _skillCumulativeConditionType: 98765 });
    } else rules.tables.GekisouSkillEffect = rules.tables.GekisouSkillEffect.filter(row => row !== effect);
    const result = inspectPublishedSkillsCompatibility(rules, catalog);
    assert.equal(result.status, 'partial');
    assert.ok(result.issues.some(i => i.code === (change === 'missing' ? 'invalid_skill_data' : 'unsupported_skill_mechanism')));
  }
});
test('support ranks and ordinary effects use the same diagnostic path', () => {
  const rules = structuredClone(baseline), support = rules.tables.SupportCard.find(row => row._gekisouSupportSkillId01);
  rules.tables.GekisouSupportSkillEffect.filter(row => row._gekisouSupportSkillID === support._gekisouSupportSkillId01 && row._level === 5)
    .forEach(row => { row._skillEffectType = 98765; });
  assert.ok(inspectPublishedSkillsCompatibility(rules, catalog).issues.some(i => i.level === 5 && /effect 98765/.test(i.message)));
  const ordinary = structuredClone(baseline);
  ordinary.tables.LiveSkillEffect.find(row => row._liveSkillID === ordinary.tables.MemberCard[0]._liveSkillID && row._level === 5)._skillEffectType = 98765;
  assert.ok(inspectPublishedSkillsCompatibility(ordinary, catalog).issues.some(i => /Unsupported live effect/.test(i.message)));
});
test('unreferenced future rows do not misreport coverage of public cards', () => {
  const rules = structuredClone(baseline);
  rules.tables.GekisouSkillEffect.push({ ...memberEffect(rules), _id: 98765, _gekisouSkillID: 98765, _skillEffectType: 98765 });
  assert.equal(inspectPublishedSkillsCompatibility(rules, catalog).status, 'compatible');
});
test('missing public cards report unavailable or invalid data, not empty successful coverage', () => {
  assert.equal(inspectPublishedSkillsCompatibility(baseline, {}).status, 'unavailable');
  assert.equal(inspectPublishedSkillsCompatibility(baseline, { memberCards: [], supportCards: [] }).status, 'unavailable');
  assert.equal(inspectPublishedSkillsCompatibility(baseline, { ...catalog, memberCards: [{ id: 'member-card-99999' }] }).status, 'partial');
});
