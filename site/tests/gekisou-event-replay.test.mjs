import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, compileTestEffect } from './fixtures/gekisou-skill-fixture.mjs';
import { replayGekisouFrames } from '../../packages/scoring/scoring-rules/gekisou-frame-replay.mjs';
import { createGekisouSongCalculator } from '../../packages/scoring/scoring-rules/gekisou-song-score.mjs';
import { createPerformanceTemplate } from '../../packages/scoring/scoring-rules/formal-performance-replay.mjs';

const { rules } = fixture();
const effect = options => compileTestEffect(rules, { missionType: 2, ...options });
const plain = value => JSON.parse(JSON.stringify(value));
const ranges = [0, 1, 2].map(i => ({ index: i + 1, missionType: 2, startMs: 1000 + i * 4000, endMs: 3000 + i * 4000 }));
const timeline = { events: [], skillTimes: [1200, 2100, 5100, 6100, 9100] };
const skills = Array.from({ length: 5 }, () => ({ liveEffects: [], supportEffects: [] }));
skills[0].liveEffects.push({ id: 1, type: 2000, condition: { kind: 'life_at_least', threshold: 700, positive: true },
  rate: .5, durationRawMs: 1000, targets: [] });
skills[0].supportEffects.push({ id: 2, type: 3001, condition: { kind: 'always', active: true }, value: 200 });
skills[1].supportEffects.push({ id: 3, type: 12006, condition: { kind: 'always', active: true },
  durationRawMs: 100, targets: [1, 2, 4], value: 5, limitCount: 2 });
skills[2].supportEffects.push({ id: 4, type: 12006, condition: { kind: 'always', active: true },
  startup: true, durationRawMs: 50, targets: [1], value: 3, limitCount: 1 });

function compare(effects, { seed = 1, frameRate = 60, explicit = false, grades = [5], missions = [2, 2, 2], offsets = [-30, 0, 50] } = {}) {
  const times = [0, 20, 60, 990, 1000, 1001, 1050, 1199, 1200, 1250, 1999, 2100, 2200, 2300, 2999,
    3000, 3001, 5000, 5010, 5100, 6100, 7000, 9000, 9010, 9100, 11000, 11001];
  const events = times.map((timeMs, i) => ({ scoreIndex: i, timeMs, type: i % 4 === 0 ? 21 : 1,
    inputFrame: Math.max(0, Math.ceil((timeMs + offsets[i % offsets.length]) * frameRate / 1000)),
    originalJudgement: grades[i % grades.length] }));
  const t = { ...timeline, events };
  const scenario = { ranks: [1, 3, 5], frameRate, timingOffsetMs: 0,
    ...(explicit ? { frames: Array.from({ length: frameRate * 15 }, (_, i) => ({ timeMs: Math.floor(i * 1000 / frameRate), deltaSeconds: 1 / frameRate })) } : {}) };
  const args = [rules, t, ranges.map((range, i) => ({ ...range, missionType: missions[i] })), effects, scenario, seed];
  const options = { trace: true, performanceInput: { judgements: events }, ordinarySkills: skills, skillOrder: [0, 1, 2, 3, 4] };
  const dense = replayGekisouFrames(...args, options);
  const sparse = replayGekisouFrames(...args, { ...options, eventDriven: true });
  assert.deepEqual(plain(sparse), plain(dense), `seed ${seed}, FPS ${frameRate}`);
}

test('event replay preserves lottery order, RUSH changes, guarantees, expiry and delayed life commands', () => {
  const effects = [
    effect({ type: 11001, definition: { _effectValue: 10000, _activationTimeSecond: .05 } }),
    effect({ type: 11003, key: 'fill', definition: { _effectValue: 100000, _activationTimeSecond: 0 } }),
    effect({ type: 11005, key: 'guarantee', definition: { _effectValue: 4, _effectLimitCount: 2, _activationTimeSecond: .1 } }),
    effect({ type: 2000, key: 'rush', trigger: [[{ type: 7021 }]], definition: { _skillTriggerType: 2, _activationTimeSecond: 0 } }),
    effect({ type: 11002, key: 'lot', trigger: [[{ type: 7000, value: 3 }, { type: 4011, value: 50 }]],
      definition: { _effectValue: 5, _activationTimeSecond: 0 } }),
    effect({ type: 3004, key: 'life', definition: { _effectValue: 2000, _activationTimeSecond: .05 } }),
    effect({ type: 2000, key: 'lot-release-reset', trigger: [[{ type: 7021 }]],
      release: [[{ type: 7000, value: 3 }, { type: 4011, value: 50 }]],
      reset: [[{ type: 7000, value: 2 }, { type: 4011, value: 50 }]],
      definition: { _effectValue: 2000, _effectExecuteLimitCount: 1 } })
  ];
  assert.ok(effects.every(e => e.eventDriven));
  for (const frameRate of [30, 60, 120]) for (const seed of [0, 1, 29, 12345, 0xffffffff]) {
    compare(effects, { seed, frameRate });
    compare(effects, { seed, frameRate, grades: [1, 2, 3, 4, 5, 6] });
  }
});

test('frame-driven predicates and unaudited operators keep the complete frame traversal', () => {
  const effects = [
    effect({ type: 11002, trigger: [[{ type: 7010, positive: false }]], definition: { _effectValue: 1 } }),
    effect({ type: 11002, trigger: [[{ type: 1030, value: 2 }]], definition: { _effectValue: 1 } }),
    effect({ type: 2000, release: [[{ type: 4011, value: 50 }]] }),
    effect({ type: 11002, reset: [[{ type: 4011, value: 50 }]], definition: { _effectValue: 1 } }),
    effect({ type: 4004 })
  ];
  for (const e of effects) { assert.equal(e.eventDriven, false); compare([e], { seed: 41 }); }
});

test('explicit clocks and mixed missions preserve the existing dense path', () => {
  const effects = [effect({ type: 11003, definition: { _effectValue: 100000, _activationTimeSecond: 0 } })];
  compare(effects, { explicit: true });
  compare(effects, { missions: [1, 2, 3] });
});

test('sparse empty intervals preserve native life-prefix queries after early and delayed inputs', () => {
  const effects = [effect({ type: 3004, definition: { _effectValue: 6500, _activationTimeSecond: .2 } }),
    effect({ type: 2000, key: 'life-score', trigger: [[{ type: 2001, value: 700 }]], definition: { _activationTimeSecond: .1 } })];
  for (let seed = 0; seed < 40; seed++) compare(effects, { seed, frameRate: [30, 60, 120][seed % 3],
    grades: [1, 1, 2, 3, 4, 5], offsets: [-333, 1300, 50, -30, -1500, seed * 13] });
});

test('ranking reuses fixed PERFECT inputs without changing full replay scores or delayed combo queries', () => {
  const context = fixture();
  for (const row of context.rules.tables.LiveSkillEffect) row._effectValue = row._id % 3 * 1000 + 12000;
  for (const frameRate of [30, 60, 120]) for (const seed of [1, 29, 12345]) {
    const performance = createPerformanceTemplate(context.rules, context.chart, { frameRate });
    for (const [i, note] of performance.judgements.entries()) note.inputFrame = Math.max(0,
      Math.ceil((note.timeMs + [-50, 300, -333, 800][i % 4]) * frameRate / 1000));
    performance.skillOrder = [4, 1, 2, 3, 0];
    const calculator = createGekisouSongCalculator(context.rules, context.chart, { performance, scenario: { seed } });
    const full = calculator.calculate(context.draft, { includeRankingSamples: true });
    const ranking = calculator.calculateRankingSamples(context.draft, { samplePlan: [{ order: performance.skillOrder,
      seed: (seed + 2654435761) >>> 0 }] });
    assert.deepEqual(ranking.rankingSamples, full.rankingSamples);
  }
});

test('fixed-input ranking preserves recovery, harmless conversion and reachable life-threshold branches', () => {
  for (const threshold of [0, 700, 1500]) for (const damaged of [false, true]) {
    const { rules, chart, draft } = fixture({ duration: 0 });
    const recovery = rules.tables.SupportSkillEffect.find(e => e._skillEffectType === 3001 && e._level === 1);
    const converter = rules.tables.SupportSkillEffect.find(e => e._skillEffectType === 12006 && e._level === 1 && e._effectValue === 5);
    rules.tables.SupportCard[0]._supportSkillId01 = recovery._supportSkillID;
    rules.tables.SupportCard[1]._supportSkillId01 = converter._supportSkillID;
    for (const row of rules.tables.SupportSkillEffect.filter(e => e._supportSkillID === recovery._supportSkillID)) {
      row._effectValue = 1000; row._skillConditionGroup = 0;
    }
    for (const row of rules.tables.LiveSkillEffect) row._effectValue = 13000;
    if (threshold) {
      const id = 900030;
      rules.tables.SkillCondition.push({ _id: id, _conditionType: 2001, _conditionValues: [threshold], _isPositive: true, _conditionTargetIDs: [] });
      rules.tables.SkillConditionSet.push({ _id: id, _group: id, _conditionIds: [id] });
      for (const row of rules.tables.LiveSkillEffect) row._skillConditionGroup = id;
      for (const row of rules.tables.GekisouSkillEffect.filter(e => e._gekisouSkillID === 900004)) row._skillConditionGroup = id;
    }
    const performance = createPerformanceTemplate(rules, chart);
    if (damaged) performance.judgements[0].judgement = 1;
    const calculator = createGekisouSongCalculator(rules, chart, { performance, scenario: { seed: 7 } });
    const full = calculator.calculate(draft, { includeRankingSamples: true, includeTrace: true });
    assert.ok(full.bestSample.performance.life > 1500, 'the recovery must cross the tested threshold');
    const ranking = calculator.calculateRankingSamples(draft, { samplePlan: [{ order: performance.skillOrder, seed: (7 + 2654435761) >>> 0 }] });
    assert.deepEqual(ranking.rankingSamples, full.rankingSamples, `threshold ${threshold}, damaged ${damaged}`);
  }
});
