import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/gekisou-skill-fixture.mjs';
import { optimizePractical } from '../src/lib/practical-optimizer.mjs';
import { optimizeTeamPlanning } from '../src/lib/team-planning-optimizer.mjs';

function setup(missions = [2, 2, 2]) {
  const context = fixture({ missions }), { rules, draft } = context;
  const reserve = { ...rules.tables.MemberCard[0], _id: 900006, _gekisouSkillID: 0 };
  rules.tables.MemberCard.push(reserve);
  rules.tables.GekisouSkillEffect.find(e => e._skillEffectType === 3004)._skillEffectType = 98765;
  const memberCardIds = rules.tables.MemberCard.map(m => `member-card-${m._id}`);
  const supportCardIds = draft.slots.map(s => s.supportCardId);
  const growth = Object.fromEntries([...memberCardIds, ...supportCardIds].map(id => [id,
    id.startsWith('member') ? { level: 1, rank: 1, awake: 1, skillLevel: 1, gekisouSkillLevel: 1 } : { level: 1, rank: 1 }]));
  draft.modifiers.growth = growth;
  return { ...context, inventory: { schemaVersion: 1, sourceReleaseId: rules.sourceReleaseId, memberCardIds, supportCardIds, growth },
    scope: 'owned', mode: 'gekisou', performanceScenario: { profile: 'ideal', samples: 1 },
    constraints: { leaderId: 'member-card-3', lockedPairs: draft.slots.slice(1) }, yieldControl: async () => {} };
}
test('unsupported pairs are removed before seeds; supported alternatives still complete', async () => {
  const args = setup(), before = structuredClone({ draft: args.draft, inventory: args.inventory });
  const report = await optimizePractical(args);
  assert.equal(report.status, 'completed');
  assert.equal(report.scoringCoverage.complete, false);
  assert.equal(report.scoringCoverage.unsupportedPairs.length, 5);
  assert.ok(report.scoringCoverage.unsupportedPairs.every(i => i.sourceCardId === 'member-card-1' && i.value === 98765));
  assert.ok(report.results.length);
  assert.ok(report.results.every(r => r.draft.slots.some(s => s.memberCardId === 'member-card-900006')));
  assert.equal(report.baseline, null);
  assert.ok(report.results.every(r => r.delta === null));
  assert.equal(report.optimality, 'incomplete');
  assert.deepEqual({ draft: args.draft, inventory: args.inventory }, before);
});
test('required unsupported cards produce empty partial coverage without relaxing constraints', async () => {
  const args = setup(); args.constraints.requiredMemberIds = ['member-card-1'];
  const report = await optimizeTeamPlanning({ ...args, planningScenario: { scope: 'owned' } });
  assert.equal(report.status, 'completed');
  assert.equal(report.scoringCoverage.complete, false);
  assert.deepEqual(report.results, []);
  assert.equal(report.baseline, null);
  assert.match(report.warnings.join(' '), /尚未实现/);
});
test('irrelevant skills do not reduce coverage, including when the card is required', async () => {
  const args = setup([3, 3, 3]); args.constraints.requiredMemberIds = ['member-card-1'];
  const report = await optimizeTeamPlanning({ ...args, planningScenario: { scope: 'owned' } });
  assert.equal(report.scoringCoverage.complete, true);
  assert.ok(report.results.length);
  assert.ok(report.results.every(r => r.draft.slots.some(s => s.memberCardId === 'member-card-1')));
});
test('malformed relevant data still fails, rather than being mistaken for a capability gap', async () => {
  const args = setup();
  const effect = args.rules.tables.GekisouSkillEffect.find(e => e._skillEffectType === 98765);
  effect._skillEffectType = 3004; effect._skillConditionGroup = 98765;
  await assert.rejects(optimizePractical(args), /Missing condition group 98765/);
});
test('formation power does not require execution support for unrelated skills', async () => {
  const args = setup(); args.constraints.requiredMemberIds = ['member-card-1'];
  const report = await optimizePractical({ ...args, objective: 'formation_power' });
  assert.equal(report.scoringCoverage.complete, true);
  assert.ok(report.results.length);
});
