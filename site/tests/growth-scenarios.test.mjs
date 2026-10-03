import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGrowthScenario, prepareGrowthCandidate, createGrowthSearchVariants } from '../src/lib/scoring-rules/growth-scenarios.mjs';
import { resolveSearchInput } from '../src/lib/scoring-rules/formation-input.mjs';

function fixture() {
  const rates = { _performanceRate: 10000, _technicRate: 10000, _visualRate: 10000 };
  const rules = { schemaVersion: 1, sourceReleaseId: 'synthetic-growth-v1', verificationStatus: 'code_audited', tables: {
    MemberCard: [], SupportCard: [], Character: [], SkillTarget: [], LiveSkill: [], GekisouSkill: [], Parameter: [],
    MemberCardRank: [1,2,3].map(_rank => ({ _group: 1, _rank, ...rates })),
    SupportCardRank: [1,2,3].map(_rank => ({ _group: 1, _rank, _limitLevel: _rank * 5, ...rates })),
    MemberCardAwake: [1,2].map(_awakeCount => ({ _group: 1, _awakeCount, ...rates })),
    MemberCardLevelLimit: [1,2].map(_awakeCount => ({ _rarity: 4, _awakeCount, _limitLevel: _awakeCount * 10 })),
    MemberCardLevel: Array.from({ length: 20 }, (_,i) => ({ _group: 1, _level: i + 1, ...rates })),
    SupportCardLevel: Array.from({ length: 15 }, (_,i) => ({ _group: 1, _level: i + 1, ...rates }))
  } };
  const draft = { slots: [], modifiers: { growth: {}, characterRanks: { 1: 4 }, customAccountValue: 72 } };
  const inventory = { schemaVersion: 1, sourceReleaseId: rules.sourceReleaseId, memberCardIds: [], supportCardIds: [], growth: {} };
  for (let i = 1; i <= 6; i++) {
    rules.tables.Character.push({ _id: i, _bandID: 1 });
    rules.tables.MemberCard.push({ _id: i, _characterID: i, _rarity: 4, _cardType: 1,
      _memberCardRankGroup: 1, _memberCardLevelGroup: 1, _memberCardAwakeGroup: 1,
      _performancePowerMax: 100, _technicPowerMax: 100, _visualPowerMax: 100 });
    rules.tables.SupportCard.push({ _id: i, _cardType: 1, _supportCardRankGroup: 1, _supportCardLevelGroup: 1,
      _performancePowerMax: 100, _technicPowerMax: 100, _visualPowerMax: 100 });
    const memberCardId = `member-card-${i}`, supportCardId = `support-card-${i}`;
    inventory.memberCardIds.push(memberCardId); inventory.supportCardIds.push(supportCardId);
    inventory.growth[memberCardId] = { level: 1, rank: 1, awake: 1, skillLevel: 1, gekisouSkillLevel: 2 };
    inventory.growth[supportCardId] = { level: 1, rank: 1 };
    if (i <= 5) draft.slots.push({ memberCardId, supportCardId });
  }
  draft.modifiers.growth = structuredClone(inventory.growth);
  return { rules, draft, inventory };
}

test('current-cap plan preserves breakthroughs, awakening and independent skill levels without mutation', () => {
  const { rules, draft, inventory } = fixture(), before = structuredClone({ draft, inventory });
  const scenario = resolveGrowthScenario(rules, draft, { scope: 'owned', inventory,
    plan: { allowedCardIds: ['member-card-6', 'support-card-6'], maxTrainedCards: 1, skillLevel: 4 } });
  assert.deepEqual(scenario.cards['member-card-6'].targetGrowth,
    { level: 10, rank: 1, awake: 1, skillLevel: 4, gekisouSkillLevel: 2 });
  assert.deepEqual(scenario.cards['support-card-6'].targetGrowth, { level: 5, rank: 1 });
  assert.equal(scenario.cards['member-card-1'].targetGrowth.level, 1);
  assert.deepEqual(scenario.targetDraft.modifiers.characterRanks, { 1: 4 });
  assert.equal(scenario.targetDraft.modifiers.customAccountValue, 72);
  assert.deepEqual({ draft, inventory }, before);
});

test('missing actual growth is excluded unless reference is explicitly requested', () => {
  const { rules, draft, inventory } = fixture();
  delete inventory.growth['member-card-6'].gekisouSkillLevel;
  const excluded = resolveGrowthScenario(rules, draft, { scope: 'owned', inventory });
  assert.deepEqual(excluded.excludedCardIds, ['member-card-6']);
  assert.equal(excluded.inventory.memberCardIds.includes('member-card-6'), false);
  const reference = resolveGrowthScenario(rules, draft, { scope: 'owned', inventory, unknownGrowth: 'reference' });
  assert.equal(reference.cards['member-card-6'].actualKnown, false);
  assert.equal(reference.cards['member-card-6'].reference, true);
  const candidate = structuredClone(draft); candidate.slots[0].memberCardId = 'member-card-6';
  const result = prepareGrowthCandidate(rules, reference, candidate);
  assert.equal(result.actualDraft, null);
  assert.equal(result.comparison.trainingCountComplete, false);
  assert.deepEqual(result.comparison.referenceCardIds, ['member-card-6']);
});

test('reference pool and explicit trial work without an imported inventory', () => {
  const { rules, draft } = fixture(); draft.modifiers.growth = {};
  const reference = resolveGrowthScenario(rules, draft, { scope: 'reference' });
  assert.equal(reference.inventory.memberCardIds.length, 6);
  assert.deepEqual(reference.cards['member-card-6'].targetGrowth,
    { level: 20, rank: 3, awake: 2, skillLevel: 5, gekisouSkillLevel: 5 });
  assert.equal(prepareGrowthCandidate(rules, reference, draft).actualDraft, null);
  const trial = resolveGrowthScenario(rules, draft, { scope: 'trial', unknownGrowth: 'reference',
    trialCardIds: { memberCardIds: [6], supportCardIds: [6] } });
  assert.equal(trial.cards['member-card-6'].ownership, 'unknown');
  assert.equal(trial.cards['member-card-6'].actualKnown, false);
  assert.equal(draft.modifiers.growth['member-card-6'], undefined);
});

test('budget counts distinct changed cards across both kinds, not growth fields', () => {
  const { rules, draft, inventory } = fixture();
  const scenario = resolveGrowthScenario(rules, draft, { scope: 'owned', inventory,
    plan: { maxTrainedCards: 1, skillLevel: 5, gekisouSkillLevel: 5 } });
  const one = prepareGrowthCandidate(rules, scenario, draft, { trainedCardIds: ['member-card-1'] });
  assert.equal(one.comparison.trainedCardCount, 1);
  assert.equal(one.comparison.changedCards[0].changes.length, 3);
  assert.equal(one.actualDraft.modifiers.growth['member-card-1'].level, 1);
  assert.equal(one.targetDraft.modifiers.growth['member-card-1'].level, 10);
  assert.throws(() => prepareGrowthCandidate(rules, scenario, draft,
    { trainedCardIds: ['member-card-1', 'support-card-1'] }), /超过限制/);
});

test('feasible growth variants expose untrained reserve cards before candidate pruning', () => {
  const { rules, draft, inventory } = fixture();
  const scenario = resolveGrowthScenario(rules, draft, { scope: 'owned', inventory,
    plan: { allowedCardIds: ['member-card-6', 'support-card-6'], maxTrainedCards: 1 } });
  const variants = createGrowthSearchVariants(scenario);
  assert.equal(variants.totalCount, 3); assert.equal(variants.truncated, false);
  const rows = [...variants];
  assert.deepEqual(rows.map(row => row.trainedCardIds), [[], ['member-card-6'], ['support-card-6']]);
  assert.equal(rows[1].draft.modifiers.growth['member-card-6'].level, 10);
  assert.ok(rows.every(row => row.inventory.memberCardIds.includes('member-card-6')));
  const page = createGrowthSearchVariants(scenario, { offset: 1, limit: 1 });
  assert.equal(page.truncated, true); assert.equal([...page][0].index, 1);
  const reserve = structuredClone(draft); reserve.slots[0].memberCardId = 'member-card-6';
  assert.equal(prepareGrowthCandidate(rules, scenario, reserve, rows[1]).comparison.trainedCardCount, 1);
});

test('disabled and zero-budget plans produce current-only search variants', () => {
  const { rules, draft, inventory } = fixture();
  for (const plan of [{ enabled: false }, { enabled: true, maxTrainedCards: 0 }]) {
    const scenario = resolveGrowthScenario(rules, draft, { scope: 'owned', inventory, plan });
    const variants = [...createGrowthSearchVariants(scenario)];
    assert.equal(variants.length, 1); assert.deepEqual(variants[0].trainedCardIds, []);
    assert.equal(variants[0].draft.modifiers.growth['member-card-1'].level, 1);
  }
});

test('explicit target upgrades rank/awakening, maximum is opt-in, and fulfilled targets survive import', () => {
  const { rules, draft, inventory } = fixture();
  const scenario = resolveGrowthScenario(rules, draft, { scope: 'owned', inventory,
    plan: { mode: 'target', allowedCardIds: ['member-card-1'], targets: {
      'member-card-1': { rank: 2, awake: 2, level: 20, gekisouSkillLevel: 5 } } } });
  const saved = prepareGrowthCandidate(rules, scenario, draft).targetDraft;
  const reloaded = resolveGrowthScenario(rules, saved, { ...saved.modifiers.planningScenario, scope: 'selected' });
  assert.equal(reloaded.cards['member-card-1'].actualGrowth.level, 1);
  inventory.growth['member-card-1'] = { level: 20, rank: 3, awake: 2, skillLevel: 4, gekisouSkillLevel: 5 };
  const refreshed = resolveGrowthScenario(rules, saved, { ...saved.modifiers.planningScenario, inventory });
  assert.equal(refreshed.cards['member-card-1'].needsTraining, false);
  assert.equal(refreshed.cards['member-card-1'].targetGrowth.rank, 3);
  assert.equal(prepareGrowthCandidate(rules, refreshed, draft).comparison.trainedCardCount, 0);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(saved.modifiers.planningScenario)));
});

test('reopening saved reference target never invents an actual baseline', () => {
  const { rules, draft } = fixture(); draft.modifiers.growth = {};
  const scenario = resolveGrowthScenario(rules, draft, { scope: 'selected', unknownGrowth: 'reference' });
  const saved = prepareGrowthCandidate(rules, scenario, draft).targetDraft;
  const reloaded = resolveGrowthScenario(rules, saved, saved.modifiers.planningScenario);
  assert.equal(reloaded.cards['member-card-1'].actualKnown, false);
  assert.equal(prepareGrowthCandidate(rules, reloaded, saved).actualDraft, null);
});

test('rejects incompatible versions, malformed policies and impossible target growth', () => {
  const { rules, draft, inventory } = fixture();
  for (const options of [
    { schemaVersion: 2 }, { sourceReleaseId: 'old' }, { unknownGrowth: 'actual' },
    { plan: { schemaVersion: 9 } }, { plan: { sourceReleaseId: 'old' } },
    { plan: { mode: 'automatic' } }, { plan: { maxTrainedCards: -1 } },
    { plan: { skillLevel: 6 } }, { plan: { targets: { 'member-card-1': { level: 11 } } } },
    { plan: { targets: { 'support-card-1': { skillLevel: 2 } } } },
    { plan: { targets: { 'member-card-1': { rank: 5 } } } },
    { plan: { enabled: false, targets: { 'member-card-1': { level: 999 } } } },
    { plan: { allowedCardIds: [], targets: { 'support-card-1': { rank: 5 } } } }
  ]) assert.throws(() => resolveGrowthScenario(rules, draft, { scope: 'owned', inventory, ...options }));
});

test('new formation-input scope forwards labelled scenario while enforcing pool constraints', () => {
  const { rules, draft, inventory } = fixture();
  const input = resolveSearchInput(rules, draft, { scope: 'reference', constraints: { requiredMemberIds: [6] } });
  assert.equal(input.scope, 'reference'); assert.ok(input.growthScenario);
  assert.ok(input.assumptions.some(text => text.includes('参考队伍')));
  const selected = resolveSearchInput(rules, draft, { planningScenario: {
    scope: 'selected', selectedCardIds: { memberCardIds: [1,2,3,4,5,6], supportCardIds: [1,2,3,4,5,6] } }, inventory });
  assert.equal(selected.inventory.memberCardIds.length, 6);
  delete inventory.growth['member-card-1'].skillLevel;
  assert.throws(() => resolveSearchInput(rules, draft, { inventory, planningScenario: { scope: 'owned' },
    constraints: { requiredMemberIds: [1] } }), /必选/);
});


test('finite training count requires actual baselines, unlimited search retains current too', () => {
  const { rules, draft, inventory } = fixture();
  const complete = resolveGrowthScenario(rules, draft, { scope: 'owned', inventory, plan: {} });
  const variants = [...createGrowthSearchVariants(complete)];
  assert.equal(variants.length, 2); assert.deepEqual(variants[0].trainedCardIds, []);
  assert.equal(variants[1].trainedCardIds.length, 12);
  delete inventory.growth['member-card-1'].skillLevel;
  assert.throws(() => resolveGrowthScenario(rules, draft, { scope: 'owned', inventory,
    unknownGrowth: 'reference', plan: { maxTrainedCards: 1 } }), /实际养成/);
});
