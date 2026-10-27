import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/gekisou-skill-fixture.mjs';
import { optimizePractical } from '../src/lib/practical-optimizer.mjs';
import { optimizeTeamPlanning } from '../src/lib/team-planning-optimizer.mjs';
import { compilePairingModels } from '../src/lib/inventory-optimizer.mjs';
import { resolveSearchInput } from '../src/lib/scoring-rules/formation-input.mjs';

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

function conditionalLeader() {
  const args = setup([3, 3, 3]);
  args.constraints = {};
  const card = args.rules.tables.MemberCard.find(c => c._id === 1);
  const effect = args.rules.tables.LeaderSkillEffect.find(e => e._leaderSkillID === card._leaderSkillID && e._level === 1);
  card._leaderSkillID = 900100;
  args.rules.tables.LeaderSkillEffect.push({ ...effect, _id: 900100, _leaderSkillID: 900100,
    _skillConditionGroup: 415, _skillCumulativeConditionID: 70 });
  return args;
}
test('unsupported leader power does not abort supported reference-pool recommendations', async () => {
  const args = conditionalLeader();
  const before = structuredClone({ draft: args.draft, inventory: args.inventory });
  const report = await optimizeTeamPlanning({ ...args, planningScenario: { scope: 'owned' } });
  assert.equal(report.status, 'completed');
  assert.equal(report.scoringCoverage.complete, false);
  assert.ok(report.scoringCoverage.unsupportedLeaders.some(i => i.sourceCardId === 'member-card-1' && i.effectId === 900100));
  assert.ok(report.results.length);
  assert.ok(report.results.every(r => r.draft.slots[2].memberCardId !== 'member-card-1'));
  assert.equal(report.optimality, 'incomplete');
  assert.deepEqual({ draft: args.draft, inventory: args.inventory }, before);
});
test('required unsupported leader is reported without substituting another leader', async () => {
  const args = conditionalLeader(); args.constraints.leaderId = 'member-card-1';
  const report = await optimizePractical(args);
  assert.equal(report.status, 'completed');
  assert.equal(report.scoringCoverage.complete, false);
  assert.deepEqual(report.results, []);
  assert.equal(report.scoringCoverage.unsupportedLeaders[0].sourceCardId, 'member-card-1');
});
test('missing leader data still fails instead of dropping a card', async () => {
  const args = conditionalLeader(); args.rules.tables.LeaderSkillEffect = args.rules.tables.LeaderSkillEffect.filter(e => e._id !== 900100);
  await assert.rejects(optimizePractical(args), /Missing leader effects/);
});

test('candidate-cache hits retain unsupported leader coverage', async () => {
  const args = conditionalLeader(), candidateCache = new Map();
  const first = await optimizePractical({ ...args, candidateCache, candidateCacheKey: 'same-rules-and-input' });
  const second = await optimizePractical({ ...args, candidateCache, candidateCacheKey: 'same-rules-and-input' });
  assert.equal(second.practical.candidateCacheHit, true);
  assert.deepEqual(second.scoringCoverage, first.scoringCoverage);
  assert.deepEqual(second.results.map(r => r.id), first.results.map(r => r.id));
});

test('restricted leader models cannot satisfy an unrestricted cache lookup', async () => {
  const args = conditionalLeader(), pairCache = new Map(), modelCache = {};
  const input = resolveSearchInput(args.rules, args.draft, args);
  const options = { pairCache, pairCacheKey: 'same-input', modelCache, yieldControl: args.yieldControl };
  const models = await compilePairingModels(args.rules, input, { ...options, leaderIds: ['member-card-3'] });
  assert.deepEqual(models.map(m => m.leader), ['member-card-3']);
  await assert.rejects(compilePairingModels(args.rules, input, options), /Unsupported conditional power effect/);
});
