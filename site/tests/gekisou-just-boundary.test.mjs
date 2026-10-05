import { compileTestEffect } from './fixtures/gekisou-skill-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replayGekisouFrames } from '../src/lib/scoring-rules/gekisou-frame-replay.mjs';

const rules = JSON.parse(readFileSync(new URL('../src/data/formal-scoring-rules.json', import.meta.url)));
const native = JSON.parse(readFileSync(new URL('./fixtures/gekisou-just-native.json', import.meta.url)));
const frames = Array.from({ length: 4000 }, (_, timeMs) => ({ timeMs, deltaSeconds: 0.001 }));
function replay(times, offset = 0, effects = [], overrides = {}) {
  return replayGekisouFrames(rules, { events: times.map((timeMs, i) => ({ id: String(i), type: 1, timeMs })) },
    [{ index: 1, missionType: 3, startMs: 1000, endMs: 2000, ...overrides }], effects,
    { ranks: [1], frameRate: 60, frames, timingOffsetMs: offset }, 1);
}
test('native fever enters at start and ends at end, at most once per frame', () => {
  for (const row of native.fever) {
    const expected = row.initial === 1 && row.timeMs >= 1000 ? 2
      : row.initial === 2 && row.timeMs >= 2000 ? 3 : row.initial;
    assert.equal(row.state, expected, JSON.stringify(row));
  }
  for (const row of native.toggles) {
    const expected = row.mission === 3 && [3, 5].includes(row.state)
      ? [{ grade: 6, enabled: row.state === 3 || row.force }] : [];
    assert.deepEqual(row.calls, expected, JSON.stringify(row));
  }
});
test('JUST base window closes before the exact end-frame input', () => {
  const result = replay([999, 1000, 1999, 2000, 2001]);
  assert.deepEqual(result.events.map(n => n.judgement), [5, 6, 6, 5, 5]);
  assert.equal(result.states[0].rawJust, 2);
});
test('global JUST window follows input frame independently of authored section', () => {
  const late = replay([999, 1999], 1);
  assert.deepEqual(late.events.map(n => n.sectionIndex), [0, 1]);
  assert.deepEqual(late.events.map(n => n.judgement), [6, 5]);
  const early = replay([1000, 2001], -2);
  assert.deepEqual(early.events.map(n => n.sectionIndex), [1, 0]);
  assert.deepEqual(early.events.map(n => n.judgement), [5, 6]);
});
test('same-frame start/end opens JUST for the one native transition', () => {
  assert.deepEqual(replay([1000, 1001], 0, [], { endMs: 1000 }).events.map(n => n.judgement), [6, 5]);
});
test('registered conversion survives raw JUST window closure and consumes one charge', () => {
  const converter = compileTestEffect(rules, { type: 13005, targets: [5],
    trigger: [[{ type: 7020 }, { type: 1030, value: 1, targetIds: [41] }]],
    definition: { _activationTimeSecond: 0, _effectLimitCount: 1, _effectExecuteLimitCount: 1 } });
  // First PERFECT arms the converter after inputs. Its next charge remains
  // usable at End; exhausting it prevents a second conversion on that frame.
  const result = replay([1900, 1970, 1970], 30, [converter]);
  assert.deepEqual(result.events.map(n => n.judgement), [5, 6, 5]);
  assert.equal(result.states[0].effects[0].pending, 0);
});
