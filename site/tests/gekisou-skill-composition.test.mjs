import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileTestEffect, fixture } from './fixtures/gekisou-skill-fixture.mjs';
import { replayGekisouFrames } from '../../packages/scoring/scoring-rules/gekisou-frame-replay.mjs';
import { createGekisouSongCalculator } from '../../packages/scoring/scoring-rules/gekisou-song-score.mjs';
import { createGekisouEffectState, advanceGekisouEffect } from '../../packages/scoring/scoring-rules/gekisou-skill-runtime.mjs';
import { UnsupportedSkillMechanismError } from '../../packages/scoring/scoring-rules/skill-mechanism-error.mjs';

const rules = JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json', import.meta.url)));
const frames = Array.from({ length: 4000 }, (_, timeMs) => ({ timeMs, deltaSeconds: .001 }));
function run(effects, times, grades = times.map(() => 5), missionType = 1, data = rules) {
  const events = times.map((timeMs, i) => ({ id: String(i), type: 1, scoreIndex: i, timeMs, inputFrame: timeMs, originalJudgement: grades[i] }));
  return replayGekisouFrames(data, { events, skillTimes: [] }, [{ index: 1, missionType, startMs: 1000, endMs: 2000 }], effects,
    { ranks: [1], frameRate: 60, frames, timingOffsetMs: 0 }, 1, { trace: true, performanceInput: { judgements: events } });
}

test('damage reduction composes with a combo threshold and keeps its native timestamp and expiry', () => {
  const effect = compileTestEffect(rules, { type: 3004, missionType: 1,
    trigger: [[{ type: 7005, value: 2 }]], definition: { _skillTriggerType: 2, _effectValue: 2000, _activationTimeSecond: .3 } });
  const result = run([effect], [1000, 1100, 1200, 1300, 1450, 1600], [5, 5, 1, 1, 1, 1]);
  assert.deepEqual(result.events.map(n => n.lifeAtInput), [1000, 1000, 920, 840, 740, 640]);
  const start = result.transitions.find(t => t.action === 'start');
  assert.equal(start.frame, 1101); assert.equal(start.timeMs, 1100);
});

test('constant score increase can start at section entry without requiring RUSH', () => {
  const effect = compileTestEffect(rules, { type: 2000, missionType: 1, definition: { _effectValue: 5000, _activationTimeSecond: .3 } });
  const result = run([effect], [1000, 1100, 1500]);
  assert.deepEqual(result.commands.filter(c => c.source === effect.key).map(c => [c.timeMs, c.value]), [[1000, .5], [1300, -.5]]);
});

test('damage reduction can start on the declared lottery result, alongside an entry gauge grant', () => {
  const data = structuredClone(rules);
  data.tables.LiveGekisouLuckBonusLot = data.tables.LiveGekisouLuckBonusLot.filter(r => r._lotResult === 1);
  const gauge = compileTestEffect(data, { type: 11003, missionType: 2, key: 'gauge' });
  const reduction = compileTestEffect(data, { type: 3004, missionType: 2, trigger: [[{ type: 7000, value: 1 }]],
    definition: { _effectValue: 2000, _activationTimeSecond: .1 } });
  const result = run([gauge, reduction], [1000, 1100, 1200], [1, 1, 1], 2, data);
  assert.deepEqual(result.events.map(n => n.lifeAtInput), [900, 820, 720]);
  assert.equal(result.transitions.find(t => t.source === reduction.key && t.action === 'start').frame, result.luckEvents[0].inputFrame + 1);
});

test('judgement intervals drive ordinary count operators and execution limits', () => {
  const effect = compileTestEffect(rules, { type: 12000, missionType: 1,
    trigger: [[{ type: 7020 }, { type: 1030, value: 2, targetIds: [41] }]],
    definition: { _effectValue: 1, _activationTimeSecond: .05, _effectExecuteLimitCount: 2 } });
  const result = run([effect], [1000, 1100, 1200, 1300, 1400, 1500]);
  assert.deepEqual(result.transitions.filter(t => t.action === 'start').map(t => t.timeMs), [1100, 1300]);
  assert.equal(result.states[0].effects[0].uses, 2);
});

test('OR branches retain AND gates and negative life conditions', () => {
  const otherBand = rules.tables.SkillTarget.find(t => t._skillTargetType === 3 && t._bandID !==
    rules.tables.Character.find(c => c._id === rules.tables.MemberCard.find(m => m._id === 1)._characterID)._bandID)._id;
  const effect = compileTestEffect(rules, { type: 3004, missionType: 1,
    condition: [[{ type: 2001, value: 1 }, { type: 5000, targetIds: [otherBand] }], [{ type: 2001, value: 950, positive: false }]],
    definition: { _effectValue: 2000 } });
  assert.deepEqual(run([effect], [1000, 1100], [1, 1]).events.map(n => n.lifeAtInput), [900, 820]);
  assert.equal(run([effect], [1000, 1100], [5, 1]).states[0].effects[0].triggered, false);
});

test('release conditions remove a live handle once without waiting for section end', () => {
  const effect = compileTestEffect(rules, { type: 3004, missionType: 1,
    release: [[{ type: 2001, value: 900, positive: false }]], definition: { _effectValue: 2000, _activationTimeSecond: 0 } });
  const result = run([effect], [1000, 1100, 1200, 1300], [5, 1, 1, 1]);
  assert.deepEqual(result.events.map(n => n.lifeAtInput), [1000, 920, 840, 740]);
  assert.equal(result.transitions.filter(t => t.action === 'end').length, 1);
});

test('lottery reset restores the execution limit and failed conditions do not draw probability', () => {
  const compiled = compileTestEffect(rules, { type: 11003, missionType: 2,
    trigger: [[{ type: 7000, value: 0 }]], condition: [[{ type: 4011, value: 50 }, { type: 2001, value: 500 }]],
    reset: [[{ type: 7000, value: 3 }]], definition: { _effectExecuteLimitCount: 1 } });
  const e = createGekisouEffectState(compiled), section = { previousLots: [], settleFrame: 100, luck: { state: {}, addGaugePercent: () => grants++ } };
  let grants = 0, draws = 0;
  for (const [frame, [result, life]] of [[0, 100], [0, 1000], [0, 1000], [3, 1000], [0, 1000]].entries()) {
    section.previousLots = [{ result }];
    advanceGekisouEffect(e, { section, frame, timeMs: frame, life, notes: [], entering: false, closing: false,
      clock: { at: i => ({ timeMs: i }), indexAt: i => i }, random: () => { draws++; return .2; },
      dirty() {}, factor() {}, trace() {} });
  }
  assert.equal(grants, 2); assert.equal(draws, 2);
});

test('an irrelevant mission is excluded before resolving even unknown conditions and effects', () => {
  const { rules, chart, draft } = fixture({ missions: [3, 3, 3] });
  const effect = rules.tables.GekisouSkillEffect.find(r => r._skillEffectType === 3004);
  effect._skillEffectType = 98765; effect._skillConditionGroup = 98765;
  assert.doesNotThrow(() => createGekisouSongCalculator(rules, chart, { scorePrecision: 'screen' }).calculate(draft));
  effect._skillConditionGroup = 0;
  rules.tables.LiveMusic.find(r => r._id === 100001)._gekisouMission1 = 2;
  assert.throws(() => createGekisouSongCalculator(rules, chart).calculate(draft), error =>
    error instanceof UnsupportedSkillMechanismError && error.detail.sourceCardId === 'member-card-1');
});

test('execution limits span sections unless the data explicitly resets them', () => {
  const frames = Array.from({ length: 6000 }, (_, timeMs) => ({ timeMs, deltaSeconds: .001 }));
  const events = [1000, 1100, 3000, 3100].map((timeMs, i) => ({ id: String(i), type: 1, scoreIndex: i, timeMs, inputFrame: timeMs, originalJudgement: i % 2 ? 1 : 5 }));
  const play = reset => replayGekisouFrames(rules, { events, skillTimes: [] },
    [{ index: 1, missionType: 1, startMs: 1000, endMs: 2000 }, { index: 2, missionType: 1, startMs: 3000, endMs: 4000 }],
    [compileTestEffect(rules, { type: 3004, missionType: 1, reset, release: [[{ type: 7013 }]],
      definition: { _effectValue: 2000, _activationTimeSecond: 0, _effectExecuteLimitCount: 1 } })],
    { ranks: [1, 1], frameRate: 60, frames, timingOffsetMs: 0 }, 1, { trace: true, performanceInput: { judgements: events } });
  assert.deepEqual(play([]).events.map(n => n.lifeAtInput), [1000, 920, 920, 820]);
  assert.deepEqual(play([[{ type: 7013 }]]).events.map(n => n.lifeAtInput), [1000, 920, 920, 840]);
});

test('reactivated combo protection retains previous activations during historical recount', () => {
  const effect = compileTestEffect(rules, { type: 12004, missionType: 1, targets: [1],
    trigger: [[{ type: 1030, value: 1, targetIds: [41] }]],
    definition: { _activationTimeSecond: .15, _effectLimitCount: 1, _effectExecuteLimitCount: 2 } });
  const result = run([effect], [1000, 1100, 1200, 1300, 1400], [5, 1, 5, 1, 1]);
  assert.deepEqual(result.events.map(n => Boolean(n.gekisouComboProtected)), [false, true, false, true, false]);
  assert.equal(result.states[0].maxCombo, 2);
  assert.equal(result.states[0].combo, 0);
});

test('an alternative RUSH trigger cannot shorten a section-entry activation', () => {
  const effect = compileTestEffect(rules, { type: 2000, missionType: 1,
    trigger: [[{ type: 7010 }], [{ type: 7021 }]], definition: { _skillTriggerType: 2, _effectValue: 5000, _activationTimeSecond: .3 } });
  const result = run([effect], [1000, 1100, 1500]);
  assert.deepEqual(result.commands.filter(c => c.source === effect.key).map(c => [c.timeMs, c.value]), [[1000, .5], [1300, -.5]]);
});

test('release intervals observe the requested judgement while the effect is executing', () => {
  const effect = compileTestEffect(rules, { type: 3004, missionType: 1,
    release: [[{ type: 1030, value: 2, targetIds: [41] }]], definition: { _effectValue: 2000, _activationTimeSecond: 0 } });
  const result = run([effect], [1000, 1100, 1200, 1300, 1400], [5, 5, 1, 5, 1]);
  assert.deepEqual(result.events.map(n => n.lifeAtInput), [1000, 1000, 920, 920, 820]);
  assert.equal(result.transitions.find(t => t.action === 'end').timeMs, 1300);
});

test('cumulative JUST bonus reads its data-declared judgement target', () => {
  const effect = compileTestEffect(rules, { type: 13002, missionType: 3,
    definition: { _effectValue: 1, _activationTimeSecond: 0 },
    cumulative: { _skillCumulativeConditionType: 1000, _conditionValues: [1], _conditionTargetIDs: [41], _maxCumulativeCount: 4 } });
  const result = run([effect], [1000, 1100, 1200, 1300], [5, 5, 6, 6], 3);
  assert.equal(result.states[0].just, 6); // two base JUST, each with +2 from the two PERFECTs
});

test('zero-probability release never silently removes an active effect', () => {
  const effect = compileTestEffect(rules, { type: 3004, missionType: 1,
    release: [[{ type: 4011, value: 0 }]], definition: { _effectValue: 2000, _activationTimeSecond: 0 } });
  const result = run([effect], [1000, 1100, 1200], [5, 1, 1]);
  assert.deepEqual(result.events.map(n => n.lifeAtInput), [1000, 920, 840]);
});
