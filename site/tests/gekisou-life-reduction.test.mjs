import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeTeamPlanning } from '../src/lib/team-planning-optimizer.mjs';
import { createGekisouSongCalculator } from '../../packages/scoring/scoring-rules/gekisou-song-score.mjs';
import { fixture, replay, withoutReduction } from './fixtures/gekisou-skill-fixture.mjs';

test('a LUCK damage-reduction member remains eligible for all-JUST team recommendations', async () => {
  const { rules, chart, draft } = fixture({ missions: [3, 3, 3] });
  const inventory = { schemaVersion: 1, sourceReleaseId: rules.sourceReleaseId,
    memberCardIds: draft.slots.map(slot => slot.memberCardId),
    supportCardIds: draft.slots.map(slot => slot.supportCardId), growth: {} };
  for (const id of inventory.memberCardIds) inventory.growth[id] = { level: 1, rank: 1, awake: 1, skillLevel: 1, gekisouSkillLevel: 1 };
  for (const id of inventory.supportCardIds) inventory.growth[id] = { level: 1, rank: 1 };
  const args = { rules, chart, draft, inventory, mode: 'gekisou', planningScenario: { scope: 'owned' },
    performanceScenario: { profile: 'ideal', samples: 1 },
    constraints: { leaderId: 'member-card-3', lockedPairs: draft.slots }, yieldControl: async () => {} };
  const before = structuredClone({ draft, inventory });
  const result = await optimizeTeamPlanning(args);
  const expected = await optimizeTeamPlanning({ ...args, rules: withoutReduction(rules) });
  assert.equal(result.status, 'completed');
  assert.ok(result.results.length > 0);
  assert.ok(result.practical.screened > 0);
  assert.ok(result.practical.finalists > 0);
  assert.equal(result.results[0].value, expected.results[0].value);
  assert.ok(result.results[0].draft.slots.some(slot => slot.memberCardId === 'member-card-1'));
  assert.deepEqual({ draft, inventory }, before);
});

test('AP LUCK scoring retains the gauge bonus and needs no life reduction', () => {
  const { rules, chart, draft } = fixture();
  const calculate = r => createGekisouSongCalculator(r, chart, { scorePrecision: 'screen' }).calculate(draft);
  const result = calculate(rules), expected = calculate(withoutReduction(rules));
  assert.equal(result.expectedScore, expected.expectedScore);
  assert.deepEqual(result.sections, expected.sections);
});

test('3004 reduces MISS damage after activation, then expires without leaking to later notes', () => {
  const context = fixture();
  const result = replay(context, [0, 1, 2, 3, 4, 5, 6]);
  // Entry-frame input precedes the skill phase. Later MISS damage is 80
  // instead of 100, until the three-second effect ends.
  assert.deepEqual(result.bestSample.notes.slice(0, 7).map(note => note.lifeAtInput), [900, 800, 720, 640, 540, 440, 340]);
  assert.equal(result.bestSample.performance.life, 340);
  assert.equal(result.bestSample.performance.fullCombo, false);
  assert.equal(result.bestSample.notes[2].judgement, 1);
});

test('duration-zero reduction is released between LUCK sections and starts again in each section', () => {
  const result = replay(fixture({ duration: 0 }), [2, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(result.bestSample.notes.filter(note => note.judgement === 1).map(note => note.lifeAtInput),
    [920, 840, 740, 660, 560, 480, 380]);
});

test('3004 also reduces BAD damage with integer truncation without changing its judgement', () => {
  const result = replay(fixture({ reduction: 3333 }), [2], 2);
  assert.equal(result.bestSample.notes[2].lifeAtInput, 967); // trunc(50 * 6667 / 10000) = 33
  assert.equal(result.bestSample.notes[2].judgement, 2);
});

test('preserved life participates in subsequent life-conditioned score skills', () => {
  const context = fixture(), { rules, chart } = context;
  chart.skillTimings[0] = 1.5;
  rules.tables.SkillCondition.push({ _id: 900005, _conditionType: 2001,
    _conditionValues: [810], _isPositive: true, _conditionTargetIDs: [] });
  rules.tables.SkillConditionSet.push({ _id: 900005, _group: 900005, _conditionIds: [900005] });
  Object.assign(rules.tables.LiveSkillEffect.find(row => row._liveSkillID === 1 && row._level === 1), {
    _skillConditionGroup: 900005, _skillEffectType: 2004, _skillTargetIDs: [41, 46], _effectValue: 10000,
  });
  const result = replay(context, [1, 2]);
  const unprotected = replay({ ...context, rules: withoutReduction(rules) }, [1, 2]);
  const activation = value => value.bestSample.ordinarySkillTrace.find(row => row.slotIndex === 0 && row.type === 2004);
  assert.equal(activation(result).currentLife, 820);
  assert.equal(activation(result).active, true);
  assert.equal(activation(unprotected).currentLife, 800);
  assert.equal(activation(unprotected).active, false);
  assert.ok(result.expectedScore > unprotected.expectedScore);
});

test('overlapping damage reductions add together, cap at full protection, and are all removed', () => {
  const result = replay(fixture({ reduction: 6000, copies: 2 }), [2, 3, 4]);
  assert.deepEqual(result.bestSample.notes.slice(2, 5).map(note => note.lifeAtInput), [1000, 1000, 900]);
});

test('unknown Gekisou effects still fail closed', () => {
  const { rules, chart, draft } = fixture();
  rules.tables.GekisouSkillEffect.find(row => row._skillEffectType === 3004)._skillEffectType = 99999;
  assert.throws(() => createGekisouSongCalculator(rules, chart).calculate(draft), /Unsupported Gekisou effect 99999/);
});
