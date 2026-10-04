import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPlanningDirections } from '../src/lib/team-planning-directions.mjs';
const row = (id, score, low, task) => ({ value: score, expectedScore: score, minimumScore: low,
  draft: { slots: [{ memberCardId: id, supportCardId: 's' }], modifiers: {} },
  scoreDistribution: { p10: low }, sections: [{ index: 1, missionType: 3, just: task, rank: 1 }] });

test('retains measured tradeoffs instead of three copies of score ranking', () => {
  const result = selectPlanningDirections([row('score', 100, 60, 10), row('steady', 90, 85, 20), row('task', 80, 70, 40)]);
  assert.deepEqual(result.map(r => r.direction.id), ['score', 'stable', 'missions']);
  assert.match(result[2].direction.tradeoff, /不等于/);
  assert.equal(result[2].directionMetrics.taskComparison, 1);
});
test('one team winning all directions is merged and does not invent alternatives', () => {
  const result = selectPlanningDirections([row('best', 100, 90, 40), row('worse', 80, 70, 20)]);
  assert.equal(result.length, 1); assert.equal(result[0].direction.alsoSuitable.length, 2);
});
test('personal goal changes presentation order and does not change scores', () => {
  const result = selectPlanningDirections([row('score', 100, 60, 10), row('steady', 90, 85, 20)], { goal: 'stable' });
  assert.equal(result[0].direction.id, 'stable'); assert.equal(result[0].value, 90);
});
test('ranking comparison requires opponent assumptions on every team', () => {
  const a = row('a', 100, 60, 10), b = row('b', 90, 85, 20);
  a.scenario = b.scenario = { opponents: [{ id: 'rival' }] };
  a.sections[0].rank = 1; b.sections[0].rank = 3;
  const result = selectPlanningDirections([a, b], { goal: 'missions' });
  assert.equal(result[0].draft.slots[0].memberCardId, 'a'); assert.equal(result[0].directionMetrics.hasOpponents, true);
});


test('a tied mean never retains a dominated low-score and task alternative', () => {
  const result = selectPlanningDirections([row('a',100,60,5),row('b',100,80,10)]);
  assert.equal(result.length,1);assert.equal(result[0].draft.slots[0].memberCardId,'b');
});

test('explicit highest and lowest sample objectives survive direction pruning', () => {
  const a = { ...row('a', 90, 60, 10), maximumScore: 150, minimumScore: 55 };
  const b = { ...row('b', 100, 80, 10), maximumScore: 120, minimumScore: 40 };
  for (const objective of ['maximum_song_score', 'minimum_song_score']) {
    const result = selectPlanningDirections([a,b], { objective });
    assert.equal(result[0].draft.slots[0].memberCardId,'a');
    assert.match(result[0].direction.reason, /样本/);
  }
});
