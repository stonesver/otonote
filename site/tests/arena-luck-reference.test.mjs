import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareLuckReferenceSection, prepareLuckReferenceScenarios, createLuckReferenceRanker, luckReferenceLeaders } from '../../packages/scoring/scoring-rules/arena-luck-reference.mjs';
import { rankGekisouSection } from '../../packages/scoring/scoring-rules/gekisou-ranking.mjs';
import { createLuckReferenceTeams } from '../src/lib/arena-luck-reference-teams.mjs';
import { createLuckCandidateSource, luckSkillTradeoffs, selectLuckSeeds } from '../src/lib/arena-luck-candidates.mjs';
import { createFormationCalculator } from '../../packages/scoring/scoring-rules/formation-power.mjs';
import { fixture } from './fixtures/gekisou-skill-fixture.mjs';

const section = (luckPoints, noteScore = 100, perfectCount = 10) => ({ missionType: 2, luckPoints, noteScore, perfectCount, bonuses: [300, 220, 160, 100, 100] });
const team = (id, points, noteScore = 1000) => ({ id, songs: [{ samples: points.map(points => ({ noteScore, sections: [section(points), section(points), section(points)] })) }] });

test('lower-power cards with stronger applicable RUSH scoring survive the ordinary power shortlist', () => {
  const rows = [
    { id: 'power', family: 'rush', power: 142, effects: [600, 90, 460] },
    { id: 'band-branch', family: 'rush', power: 140, effects: [600, 90, 500] },
    { id: 'weak', family: 'rush', power: 139, effects: [600, 90, 450] },
    { id: 'gauge', family: 'gauge', power: 120, effects: [700, 90, 460] }
  ];
  assert.ok(!selectLuckSeeds(rows, 1).some(row => row.id === 'band-branch'));
  assert.deepEqual(luckSkillTradeoffs(rows, row => row.effects).map(row => row.id), ['power', 'band-branch', 'gauge']);
});

test('reference lookup exactly matches room-by-room ranking including duplicate opponents and ties', () => {
  const rooms = [[], [section(10), section(10), section(20), section(30)],
    [section(10, 101), section(10, 100, 11), section(10), section(0)],
    [section(10), section(10), section(10), section(10)]];
  const lookup = prepareLuckReferenceSection(rooms, 5);
  for (const points of [0, 1, 9, 10, 11, 20, 21, 30, 100]) for (const score of [99, 100, 101]) for (const perfect of [9, 10, 11]) {
    const own = section(points, score, perfect), expected = Array(5).fill(0);
    for (const room of rooms) expected[rankGekisouSection(own, room, 2) - 1] += 1 / rooms.length;
    assert.deepEqual([...lookup(own)], expected);
  }
});

test('joint point/score outcomes are settled before averaging, with exact reward rounding retained', () => {
  const lookup = prepareLuckReferenceSection([[section(15)]], 5);
  const scenarios = [{ id: 'one', label: 'one', sections: [[lookup, lookup, lookup]] }];
  const a = team('A', [10, 20]), b = team('B', [10, 20]);
  a.songs[0].samples[0].sections.forEach(s => s.bonuses = [30, 10, 5, 3, 3]);
  a.songs[0].samples[1].sections.forEach(s => s.bonuses = [300, 100, 50, 30, 30]);
  b.songs[0].samples[0].sections.forEach(s => s.bonuses = [300, 100, 50, 30, 30]);
  b.songs[0].samples[1].sections.forEach(s => s.bonuses = [30, 10, 5, 3, 3]);
  const rows = createLuckReferenceRanker([{ weight: 1 }], scenarios)([a, b]);
  assert.equal(rows[0].id, 'A');
  assert.equal(rows[0].referenceScenarios[0].score, 1465);
  assert.equal(rows[1].referenceScenarios[0].score, 1195);
  assert.deepEqual(rows[0].referenceScenarios[0].firstRates, [0.5, 0.5, 0.5]);
});

test('reference regret retains one whole-pool alternative and preserves scoring/scenario search leaders', () => {
  const make = (id, values) => ({ id, songs: values.map(noteScore => ({ samples: [{ noteScore, sections: [section(10), section(10), section(10)] }] })) });
  const scenarios = [{ id: 'test', label: 'test', sections: Array.from({ length: 2 }, () => [0, 1, 2].map(() => prepareLuckReferenceSection([[]], 5))) }];
  const teams = [make('A', [120, 60]), make('B', [100, 100]), make('C', [60, 120])];
  assert.equal(createLuckReferenceRanker([{ weight: 1 }, { weight: 1 }], scenarios)(teams)[0].id, 'B');
  assert.equal(createLuckReferenceRanker([{ weight: 3 }, { weight: 1 }], scenarios)(teams)[0].id, 'A');
  const low = prepareLuckReferenceSection([[section(5)]], 5), high = prepareLuckReferenceSection([[section(50)]], 5);
  const rank = createLuckReferenceRanker([{ weight: 1 }], [{ id: 'low', label: 'low', sections: [[low, low, low]] }, { id: 'high', label: 'high', sections: [[high, high, high]] }]);
  const rows = rank([team('score', [10], 1500), team('points', [100], 1000), team('balance', [60], 1300)], { limit: 1, includeScoreLeaders: true });
  assert.ok(luckReferenceLeaders(rows).some(row => row.id === 'score'));
  assert.ok(luckReferenceLeaders(rows).some(row => row.id === 'balance'));
});

test('reference bank uses actual legal growth, immutable seeds and independently sampled rooms', async () => {
  const { rules, chart } = fixture({ missions: [2, 2, 2], copies: 0 });
  const context = { bandId: 1, musicType: 99, missions: [2, 2, 2], participantCount: 5 };
  const songs = [{ trackId: chart.trackId, difficulty: chart.difficulty, weight: 1, chart }];
  const source = await createLuckCandidateSource(rules, null, context, songs, { cardScope: 'reference', limit: 6 });
  const before = structuredClone(source.candidates), scenarios = createLuckReferenceTeams(rules, source.candidates);
  const power = createFormationCalculator(rules);
  for (const scenario of scenarios) for (const opponent of scenario.teams) {
    assert.ok(power.calculate(opponent.draft).total.total > 0);
    for (const slot of opponent.draft.slots) {
      assert.equal(opponent.draft.modifiers.growth[slot.memberCardId].gekisouSkillLevel, scenario.level);
      assert.equal(opponent.draft.modifiers.growth[slot.supportCardId].rank, scenario.level);
    }
  }
  assert.deepEqual(source.candidates, before);
  const bank = [{ id: 'test', label: 'test', teams: [team('x', [0, 100])] }];
  const prepared = prepareLuckReferenceScenarios(bank, { participants: 5, rooms: 4096, seed: 123 });
  const probability = prepared[0].sections[0][0](section(50));
  // Four opponents sampled independently: all below with probability 1/16,
  // even though the room deliberately repeats one legal formation.
  assert.ok(Math.abs(probability[0] - 1 / 16) < 0.02);
});

test('cached reference ranking agrees after appends, reordering and removals', () => {
  const scenarios = prepareLuckReferenceScenarios([{ id: 'test', label: 'test', teams: [team('x', [0, 10, 20])] }], { participants: 5, rooms: 64 });
  const songs = [{ weight: 1 }], teams = [team('A', [0, 20]), team('B', [10, 15])], rank = createLuckReferenceRanker(songs, scenarios);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(rank(teams), createLuckReferenceRanker(songs, scenarios)(teams));
    teams.reverse(); teams[0].songs[0].samples.push(...team('append', [i * 7]).songs[0].samples);
  }
  assert.deepEqual(rank(teams.slice(1)), createLuckReferenceRanker(songs, scenarios)(teams.slice(1)));
});
