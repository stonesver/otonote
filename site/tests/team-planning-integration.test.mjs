import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { optimizeTeamPlanning } from '../src/lib/team-planning-optimizer.mjs';
import { refreshPlanningPreset, evaluatePresetPool } from '../src/lib/preset-portfolio.mjs';
import { generatePresetCandidates } from '../src/lib/preset-candidates.mjs';
import { createTeamDraft } from '../src/lib/team-draft.mjs';
import { createFormationCalculator } from '../src/lib/scoring-rules/formation-power.mjs';

// Tracked rules provide complete skill/account tables. Card strengths and a
// tiny authored chart below are synthetic; no private charts or imports needed.
const baselineRules = JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json', import.meta.url)));
const reserveId = 'member-card-900001';
const yieldControl = async () => {};
function fixture() {
  const rules = structuredClone(baselineRules);
  rules.tables.MemberCard = rules.tables.MemberCard.filter(row => row._id >= 1 && row._id <= 5);
  rules.tables.SupportCard = rules.tables.SupportCard.filter(row => row._id >= 1 && row._id <= 5);
  for (const member of rules.tables.MemberCard) {
    member._cardType = 1; member._gekisouSkillID = 0;
    for (const component of ['performance', 'technic', 'visual']) member[`_${component}PowerMax`] = 10000;
  }
  const reserve = structuredClone(rules.tables.MemberCard[0]);
  reserve._id = 900001;
  for (const component of ['performance', 'technic', 'visual']) reserve[`_${component}PowerMax`] = 15000;
  rules.tables.MemberCard.push(reserve);
  for (const support of rules.tables.SupportCard) {
    support._cardType = 1;
    support._supportSkillId01 = support._supportSkillId02 = 0;
    support._gekisouSupportSkillId01 = support._gekisouSupportSkillId02 = 0;
    for (const component of ['performance', 'technic', 'visual']) support[`_${component}PowerMax`] = 0;
  }
  for (const effect of rules.tables.LiveSkillEffect) effect._effectValue = 0;
  const calculator = createFormationCalculator(rules);
  const inventory = { schemaVersion: 1, sourceReleaseId: rules.sourceReleaseId,
    memberCardIds: rules.tables.MemberCard.map(row => `member-card-${row._id}`),
    supportCardIds: rules.tables.SupportCard.map(row => `support-card-${row._id}`), growth: {} };
  for (const id of inventory.memberCardIds) {
    const atCap = calculator.resolveGrowth(calculator.card(id, 'member'), 'Member', { rank: 1, awake: 1 });
    inventory.growth[id] = { level: id === reserveId ? 1 : atCap.level, rank: 1, awake: 1, skillLevel: 1, gekisouSkillLevel: 1 };
  }
  for (const id of inventory.supportCardIds) inventory.growth[id] = { level: 1, rank: 1 };
  const draft = createTeamDraft({ selectedSongId: 'music-100001', selectedDifficulty: 'expert',
    slots: [1,2,3,4,5].map(id => ({ memberCardId: `member-card-${id}`, supportCardId: `support-card-${id}` })),
    modifiers: { growth: structuredClone(inventory.growth), tgwCardRank: 1, characterRanks: { 1: 2 } } });
  const constraints = { leaderId: 'member-card-3', lockedPairs: draft.slots.slice(1) };
  const planningScenario = { schemaVersion: 1, sourceReleaseId: rules.sourceReleaseId, scope: 'owned',
    plan: { enabled: true, mode: 'current-cap', maxTrainedCards: 1, allowedCardIds: [reserveId] } };
  const chart = { id: 'music-chart-10000103', trackId: draft.selectedSongId, sourceReleaseId: rules.sourceReleaseId,
    difficulty: 'expert', bpmEvents: [{ tick: 0, bpm: 125 }], skillTimings: [1,2,3,4,5],
    feverRanges: [{ start: 1, end: 2 }, { start: 3, end: 4 }, { start: 5, end: 7 }],
    notes: [100,200,300,1000,1100,2100,3100,4100,5100,6100,7100]
      .map((tick, index) => ({ id: `planning-tap-${index}`, type: 'tap', tick, position: 0, size: 1 })) };
  return { rules, draft, inventory, constraints, planningScenario, chart, calculator };
}
const containsReserve = draft => draft.slots.some(slot => slot.memberCardId === reserveId);
const run = (context, options = {}) => optimizeTeamPlanning({ ...context, objective: 'formation_power', yieldControl,
  planningScenario: { scope: 'owned' }, ...options });

test('reference recommendation works with empty slots and no inventory, without inventing an actual delta', async () => {
  const context = fixture();
  const draft = createTeamDraft({ selectedSongId: context.draft.selectedSongId, selectedDifficulty: 'expert' });
  const before = structuredClone(draft);
  const report = await run({ ...context, draft, inventory: undefined }, { planningScenario: { scope: 'reference' } });
  assert.equal(report.status, 'completed'); assert.ok(report.results.length > 0);
  assert.equal(report.baseline, null);
  for (const row of report.results) {
    assert.equal(row.planning.kind, 'reference'); assert.equal(row.planning.missingActual, true);
    assert.equal(row.planning.plannedTeamCurrentValue, null); assert.equal(row.delta, null);
    assert.equal(row.growthComparison.actualAvailable, false);
    assert.ok(row.planning.ownershipUnknown.length > 0);
    assert.equal(row.value, context.calculator.calculate(row.draft).total.total);
  }
  assert.deepEqual(draft, before);
});

test('reference mode stays reference with a partial actual inventory and never claims a complete training count', async () => {
  const context = fixture();
  context.inventory.memberCardIds = ['member-card-2'];
  context.inventory.supportCardIds = ['support-card-2'];
  context.inventory.growth = Object.fromEntries(['member-card-2', 'support-card-2']
    .map(id => [id, structuredClone(context.inventory.growth[id])]));
  context.draft.modifiers.growth = structuredClone(context.inventory.growth);
  const before = structuredClone({ draft: context.draft, inventory: context.inventory });
  const report = await run(context, { planningScenario: { scope: 'reference' } });
  assert.equal(report.status, 'completed'); assert.ok(report.results.length > 0);
  assert.equal(report.baseline, null);
  for (const row of report.results) {
    assert.equal(row.planning.kind, 'reference');
    assert.equal(row.planning.trainingCountComplete, false);
    assert.doesNotMatch(row.planning.label, /需要培养\s*\d/);
    assert.equal(row.planning.missingActual, true);
    assert.equal(row.planning.plannedTeamCurrentValue, null);
    assert.equal(row.delta, null);
    assert.ok(row.growthComparison.pendingTrainingUnknownIds.length > 0);
    const saved = JSON.parse(JSON.stringify(row.draft));
    const refreshed = refreshPlanningPreset(context.rules, saved, context.inventory);
    assert.equal(refreshed.planning.kind, 'reference');
    assert.equal(refreshed.planning.trainingCountComplete, false);
    assert.equal(refreshed.planning.actualTeamAvailable, false);
  }
  assert.deepEqual({ draft: context.draft, inventory: context.inventory }, before);
});

test('the current best baseline obeys the same mandatory-card constraints as recommendations', async () => {
  const context = fixture();
  const unconstrainedCurrentPower = context.calculator.calculate(context.draft).total.total;
  const report = await run(context, { constraints: { ...context.constraints, requiredMemberIds: [reserveId] } });
  assert.equal(report.status, 'completed'); assert.ok(report.results.length > 0);
  assert.ok(report.results.every(row => containsReserve(row.draft)));
  // Reserve is weaker until trained: keeping the old, now-forbidden lineup as
  // baseline would fabricate a regression even for the best permitted team.
  assert.ok(report.results[0].value < unconstrainedCurrentPower);
  assert.ok(containsReserve(report.baselineResult.draft));
  assert.equal(report.baseline, report.results[0].value);
  assert.equal(report.results[0].delta, 0);
});

test('current-owned search preserves actual growth and excludes a weaker untrained reserve', async () => {
  const context = fixture(), before = structuredClone({ draft: context.draft, inventory: context.inventory });
  const report = await run(context);
  assert.equal(report.status, 'completed'); assert.ok(report.results.length > 0);
  assert.equal(report.results[0].planning.kind, 'current');
  assert.equal(containsReserve(report.results[0].draft), false);
  for (const row of report.results) {
    assert.equal(row.planning.missingActual, false); assert.equal(row.growthComparison.trainedCardCount, 0);
    assert.equal(row.planning.plannedTeamCurrentValue, row.value);
    for (const slot of row.draft.slots) for (const id of [slot.memberCardId, slot.supportCardId])
      assert.deepEqual(row.draft.modifiers.growth[id], context.inventory.growth[id]);
  }
  assert.deepEqual({ draft: context.draft, inventory: context.inventory }, before);
});

test('one-card cultivation lets an initially weaker reserve enter search and separates pairing from training gain', async () => {
  const context = fixture(), before = structuredClone({ draft: context.draft, inventory: context.inventory });
  const report = await run(context, { planningScenario: context.planningScenario });
  assert.equal(report.status, 'completed'); assert.equal(report.planning.completedVariants, 2);
  const winner = report.results[0];
  assert.equal(containsReserve(winner.draft), true);
  assert.equal(winner.growthComparison.trainedCardCount, 1);
  assert.deepEqual(winner.planning.trainingChanges.map(card => card.id), [reserveId]);
  assert.deepEqual(winner.planning.trainingChanges[0].fields.map(change => change.field), ['level']);
  assert.ok(winner.planning.plannedTeamCurrentValue < winner.planning.currentValue);
  assert.ok(winner.planning.targetValue > winner.planning.currentValue);
  assert.equal(winner.planning.targetValue, context.calculator.calculate(winner.draft).total.total);
  assert.equal(winner.delta, winner.planning.targetValue - winner.planning.currentValue);
  assert.equal(winner.draft.modifiers.growth[reserveId].rank, 1);
  assert.equal(winner.draft.modifiers.growth[reserveId].awake, 1);
  assert.deepEqual(winner.draft.modifiers.characterRanks, context.draft.modifiers.characterRanks);
  assert.equal(winner.planning.materialEstimateAvailable, false);
  assert.deepEqual({ draft: context.draft, inventory: context.inventory }, before);
});

test('cancellation during candidate screening never reports a completed cultivation search', async () => {
  const context = fixture(), controller = new AbortController(); let cancelledDuringScreen = false;
  const report = await run(context, { planningScenario: context.planningScenario, signal: controller.signal,
    onProgress(progress) {
      if (progress.stage === '快速模拟候选') { cancelledDuringScreen = true; controller.abort(); }
    } });
  assert.equal(cancelledDuringScreen, true);
  assert.equal(report.status, 'cancelled'); assert.equal(report.optimality, 'incomplete');
  assert.equal(report.planning.completedVariants, 0); assert.deepEqual(report.results, []);
});

test('variant budget exhaustion remains explicit and cannot masquerade as a full training comparison', async () => {
  const context = fixture();
  const report = await run(context, { planningScenario: context.planningScenario, variantLimit: 1 });
  assert.equal(report.status, 'budget_exhausted'); assert.equal(report.optimality, 'incomplete');
  assert.equal(report.planning.totalVariants, '2'); assert.equal(report.planning.completedVariants, 1);
  assert.equal(report.planning.truncated, true);
  assert.equal(containsReserve(report.results[0].draft), false);
  assert.ok(report.warnings.some(text => text.includes('培养组合')));
});

test('saved cultivation targets survive JSON storage and a new actual inventory import', async () => {
  const context = fixture();
  const recommendation = (await run(context, { planningScenario: context.planningScenario })).results[0];
  const saved = JSON.parse(JSON.stringify(recommendation.draft));
  const savedBefore = structuredClone(saved), oldInventory = structuredClone(context.inventory);
  const offline = refreshPlanningPreset(context.rules, saved);
  assert.equal(offline.planning.trainedCardCount, 1);
  assert.equal(offline.draft.modifiers.planningResult.actualGrowth[reserveId].level, 1);
  const partiallyTrained = structuredClone(context.inventory);
  partiallyTrained.growth[reserveId].level = saved.modifiers.growth[reserveId].level - 1;
  const partial = refreshPlanningPreset(context.rules, saved, partiallyTrained);
  assert.equal(partial.planning.trainedCardCount, 1);
  assert.equal(partial.draft.modifiers.growth[reserveId].level, saved.modifiers.growth[reserveId].level);
  assert.equal(partial.draft.modifiers.planningResult.actualGrowth[reserveId].level, partiallyTrained.growth[reserveId].level);
  const inventory = structuredClone(context.inventory);
  inventory.growth[reserveId] = structuredClone(saved.modifiers.growth[reserveId]);
  const importedBefore = structuredClone(inventory);
  const refreshed = refreshPlanningPreset(context.rules, saved, inventory);
  assert.equal(refreshed.planning.trainedCardCount, 0);
  assert.equal(refreshed.planning.kind, 'current');
  assert.equal(refreshed.planning.actualTeamAvailable, true);
  assert.deepEqual(refreshed.draft.modifiers.planningScenario.plan.targets[reserveId], saved.modifiers.planningScenario.plan.targets[reserveId]);
  assert.deepEqual(saved, savedBefore); assert.deepEqual(context.inventory, oldInventory);
  assert.deepEqual(inventory, importedBefore);
  assert.throws(() => refreshPlanningPreset(context.rules, saved,
    { ...inventory, sourceReleaseId: 'incompatible-import' }), /release_mismatch/);
});

test('preset pool reuses the saved cultivation goal and clears pending training only after actual import', async () => {
  const context = fixture();
  const recommendation = (await run(context, { planningScenario: context.planningScenario })).results[0];
  const saved = JSON.parse(JSON.stringify(recommendation.draft));
  const savedBefore = structuredClone(saved);
  const candidates = [{ id: 'saved-training', name: '练好候补后', sourceReleaseId: context.rules.sourceReleaseId, draft: saved }];
  const request = { rules: context.rules, candidates, songs: [{ trackId: context.chart.trackId, chart: context.chart }],
    mode: 'ordinary', maximizeTrainable: false, performanceScenario: { profile: 'ideal', samples: 1 } };
  const before = await evaluatePresetPool({ ...request, inventory: context.inventory });
  assert.equal(before.matrix.candidates[0].planning.trainedCardCount, 1);
  const inventory = structuredClone(context.inventory);
  inventory.growth[reserveId] = structuredClone(saved.modifiers.growth[reserveId]);
  const after = await evaluatePresetPool({ ...request, inventory });
  assert.equal(after.matrix.candidates[0].planning.trainedCardCount, 0);
  assert.equal(before.matrix.scores[0][0].expectedScore, after.matrix.scores[0][0].expectedScore);
  assert.equal(before.portfolio.rows[0].candidateId, 'saved-training');
  assert.deepEqual(candidates[0].draft, savedBefore);
});

test('legacy presets with missing growth stay explicit references through pool scoring', async () => {
  const context = fixture();
  const incomplete = structuredClone(context.draft);
  // A single missing skill is enough to make the actual baseline unknown;
  // this also covers older saves that have levels but predate Gekisou growth.
  delete incomplete.modifiers.growth['member-card-1'].gekisouSkillLevel;
  const before = structuredClone(incomplete);
  const refreshed = refreshPlanningPreset(context.rules, incomplete);
  assert.equal(refreshed.planning.kind, 'reference');
  assert.equal(refreshed.planning.legacyReference, true);
  const resaved = refreshPlanningPreset(context.rules, JSON.parse(JSON.stringify(refreshed.draft)));
  assert.equal(resaved.planning.legacyReference, true);
  assert.equal(resaved.draft.modifiers.growth['member-card-1'].gekisouSkillLevel, undefined);
  assert.equal(refreshed.planning.missingActual, true);
  assert.equal(refreshed.planning.actualTeamAvailable, false);
  assert.equal(refreshed.planning.trainingCountComplete, false);
  assert.equal(refreshed.planning.trainedCardCount, 0);
  // Calculation defaults may make a score possible but cannot certify actual growth.
  assert.ok(Number.isFinite(context.calculator.calculate(refreshed.draft).total.total));
  const result = await evaluatePresetPool({ rules: context.rules,
    candidates: [{ id: 'legacy-partial', name: '旧队伍', sourceReleaseId: context.rules.sourceReleaseId, draft: incomplete }],
    songs: [{ trackId: context.chart.trackId, chart: context.chart }], mode: 'ordinary',
    maximizeTrainable: false, performanceScenario: { profile: 'ideal', samples: 1 } });
  assert.equal(result.matrix.candidates[0].planning.kind, 'reference');
  assert.equal(result.matrix.candidates[0].planning.actualTeamAvailable, false);
  assert.ok(result.warnings.some(message => message.includes('旧预设') && message.includes('参考值')));
  assert.deepEqual(incomplete, before);
  assert.equal(refreshPlanningPreset(context.rules, context.draft).planning, null);
});

test('new selected preset generation uses hand-selected actual growth without an inventory import', async () => {
  const context = fixture(), before = structuredClone(context.draft);
  const result = await generatePresetCandidates({ rules: context.rules, draft: context.draft,
    songs: [{ trackId: context.chart.trackId, difficulty: context.chart.difficulty }], mode: 'ordinary',
    planningScenario: { scope: 'selected' }, constraints: context.constraints }, { yieldControl });
  assert.ok(result.candidates.length > 0); assert.deepEqual(result.skipped, []);
  for (const candidate of result.candidates) {
    assert.equal(candidate.origin, 'planning_power_seed');
    assert.equal(candidate.draft.modifiers.planningScenario.scope, 'selected');
    assert.equal(containsReserve(candidate.draft), false);
    for (const slot of candidate.draft.slots) for (const id of [slot.memberCardId, slot.supportCardId])
      assert.deepEqual(candidate.draft.modifiers.growth[id], context.draft.modifiers.growth[id]);
    const reopened = refreshPlanningPreset(context.rules, candidate.draft);
    assert.equal(reopened.draft.modifiers.planningResult.actualAvailable, true);
    // Hand selection supplies growth, but does not certify account ownership.
    assert.equal(reopened.planning.actualTeamAvailable, false);
    assert.equal(reopened.planning.trainedCardCount, 0);
  }
  assert.deepEqual(context.draft, before);
});

test('new reference preset generation works from empty slots without inventory or invented actual growth', async () => {
  const context = fixture();
  const draft = createTeamDraft({ selectedSongId: context.chart.trackId, selectedDifficulty: context.chart.difficulty });
  const before = structuredClone(draft);
  const result = await generatePresetCandidates({ rules: context.rules, draft,
    songs: [{ trackId: context.chart.trackId, difficulty: context.chart.difficulty }], mode: 'ordinary',
    planningScenario: { scope: 'reference' }, constraints: context.constraints }, { yieldControl });
  assert.ok(result.candidates.length > 0); assert.deepEqual(result.skipped, []);
  for (const candidate of result.candidates) {
    assert.equal(candidate.origin, 'planning_power_seed');
    assert.match(candidate.name, /参考队伍/);
    assert.equal(candidate.draft.modifiers.planningScenario.scope, 'reference');
    const reopened = refreshPlanningPreset(context.rules, JSON.parse(JSON.stringify(candidate.draft)));
    assert.equal(reopened.planning.kind, 'reference');
    assert.equal(reopened.planning.actualTeamAvailable, false);
    assert.equal(reopened.planning.trainingCountComplete, false);
    assert.equal(reopened.planning.trainedCardCount, 0);
  }
  assert.deepEqual(draft, before);
});

test('power-only planning preserves the saved performance scenario', async () => {
  const context = fixture();
  const performance = { profile: 'practice', biasMs: 27 };
  context.draft.modifiers.performanceScenario = performance;
  const report = await run(context, { objective: 'formation_power' });
  assert.ok(report.results.length);
  assert.deepEqual(report.results[0].draft.modifiers.performanceScenario, performance);
});

test('manual actual growth supports same-team comparison without inventing ownership baseline', async () => {
  const context = fixture();
  const report = await run({...context, inventory: undefined}, { planningScenario: { scope: 'selected', plan: {enabled:true,mode:'current-cap',maxTrainedCards:1} } });
  assert.ok(report.results.length);
  assert.equal(report.baseline, null);
  for (const row of report.results) {
    assert.equal(row.growthComparison.actualTeamAvailable, false);
    assert.ok(Number.isFinite(row.planning.plannedTeamCurrentValue));
    assert.equal(row.delta, null);
    assert.equal(row.planning.ownershipUnknown.length,10);
  }
});
