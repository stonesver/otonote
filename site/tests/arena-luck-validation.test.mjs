import test from 'node:test';
import assert from 'node:assert/strict';
import { assessLuckCrossValidation } from '../../packages/scoring/scoring-rules/arena-luck-validation.mjs';
import { createLuckReferenceRanker, prepareLuckReferenceSection } from '../../packages/scoring/scoring-rules/arena-luck-reference.mjs';

const team = (id, points, noteScore) => ({ id, songs: [{ samples: Array.from({ length: 6 }, () => ({ noteScore,
  sections: [1, 2, 3].map(index => ({ index, luckPoints: points, noteScore: 0, perfectCount: 0, bonuses: [300, 0] }))
})) }] });
const ranker = strong => createLuckReferenceRanker([{ weight: 1 }], [{ id: 'reference', label: 'reference',
  sections: [[0, 1, 2].map(() => prepareLuckReferenceSection([strong ? [{ luckPoints: 5, noteScore: 0, perfectCount: 0 }] : []], 2))]
}]);
const assess = (discovery, validation, rankers, tolerance = 10) => assessLuckCrossValidation(discovery, validation, rankers,
  { playerCount: 1, tolerance, winnerId: rankers[0](discovery)[0].id });

test('cross-validation isolates opponent uncertainty without asking for more own replays', () => {
  const rows = [team('A', 0, 200), team('B', 10, 100)];
  const result = assess(rows, structuredClone(rows), [ranker(false), ranker(true)]);
  assert.equal(result.status, 'unresolved');
  assert.deepEqual(result.needs, { candidate: false, opponent: true });
});

test('cross-validation isolates candidate uncertainty with unchanged opponents', () => {
  const result = assess([team('A', 0, 200), team('B', 0, 100)], [team('A', 0, 100), team('B', 0, 200)], [ranker(false), ranker(false)]);
  assert.equal(result.status, 'unresolved');
  assert.deepEqual(result.needs, { candidate: true, opponent: false });
});

test('diagonal agreement does not hide opposite winners after crossing the sample banks', () => {
  const result = assess([team('A', 10, 100), team('B', 0, 200)], [team('A', 0, 200), team('B', 10, 100)], [ranker(true), ranker(false)]);
  const winner = (bank, batch) => result.cells.find(cell => cell.opponentBank === bank && cell.candidateBatch === batch).winnerId;
  assert.equal(winner(0, 0), 'A'); assert.equal(winner(1, 1), 'A');
  assert.equal(winner(0, 1), 'B'); assert.equal(winner(1, 0), 'B');
  assert.equal(result.status, 'unresolved');
  assert.deepEqual(result.needs, { candidate: true, opponent: true });
});

test('practically close alternatives finish without trying to distinguish an immaterial gap', () => {
  const result = assess([team('A', 0, 101), team('B', 0, 100)], [team('A', 0, 100), team('B', 0, 101)], [ranker(false), ranker(false)]);
  assert.equal(result.status, 'close');
  assert.deepEqual(result.candidateIds, ['A', 'B']);
  assert.deepEqual(result.needs, { candidate: false, opponent: false });
});
