import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/gekisou-skill-fixture.mjs';
import { calculateArenaTeamReplay } from '../src/lib/arena-team-replay.mjs';
import { applyArenaContext } from '../../packages/scoring/scoring-rules/arena-context.mjs';
import { normalizePerformanceScenario } from '../../packages/scoring/scoring-rules/performance-scenarios.mjs';
import { createLuckEvaluator, unpackLuckSamples } from '../src/lib/arena-luck-evaluator.mjs';

function input(mission) {
  const { rules, chart, draft } = fixture();
  return { rules, draft, song: { chart, trackId: chart.trackId, difficulty: chart.difficulty },
    stage: { bandId: 1, missions: Array(3).fill(mission), musicType: 99, participantCount: 2 },
    ranks: [1, 1, 1], performanceScenario: { profile: 'ideal', samples: 3 }, songIndex: 0 };
}

test('a JUST count skill earns rank rewards with unchanged note score and formation', () => {
  const data = input(3);
  data.rules.tables.MemberCard[0]._gekisouSkillID = 16;
  const fixed = calculateArenaTeamReplay(data);
  const sections = fixed.replay.skillPlayback.variants[0].sections;
  const opponents = sections.map(({ just, noteScore, perfectCount }) => [{ just, noteScore, perfectCount }]);
  const result = calculateArenaTeamReplay({ ...data, ranks: undefined, opponents });
  const member = result.contributions.find(row => row.cardId === 'member-card-1');
  assert.equal(fixed.contributions[0].scoreDelta, 0);
  assert.equal(member.noteScoreDelta, 0);
  assert.ok(member.rankingBonusDelta > 0);
  assert.equal(member.scoreDelta, member.rankingBonusDelta);
  assert.equal(result.replay.power, result.replay.slots.reduce((sum, slot) => sum + slot.total.total, 0));
  assert.equal(result.contributions.length, 10);
  assert.deepEqual(structuredClone(result), result);
});

test('muting a snap removes its extension while preserving the paired member skill', () => {
  const data = input(3);
  const tables = data.rules.tables;
  tables.MemberCard[0]._liveSkillID = 1;
  tables.SupportCard[0]._supportSkillId01 = 1;
  for (const effect of tables.LiveSkillEffect.filter(row => row._liveSkillID === 1)) {
    effect._effectValue = 5000;
    effect._activationTimeSecond = 1;
  }
  for (const effect of tables.SupportSkillEffect.filter(row => row._supportSkillID === 1)) {
    effect._effectValue = 4000;
  }
  const result = calculateArenaTeamReplay(data);
  const snapDelta = result.contributions.find(row => row.cardId === 'support-card-1');
  tables.SupportCard[0]._supportSkillId01 = 0;
  const control = calculateArenaTeamReplay(data);
  assert.equal(result.replay.power, control.replay.power);
  assert.ok(snapDelta.noteScoreDelta > 0);
  assert.equal(snapDelta.scoreDelta, result.replay.score - control.replay.score);
});

test('a LUCK detail replay reproduces the discovery draw before worker packing', async () => {
  const data = input(2), sampleIndex = 5;
  const { rules, context } = applyArenaContext(data.rules, data.stage);
  const evaluate = createLuckEvaluator({ rules, context, songs: [data.song], performance: normalizePerformanceScenario(data.performanceScenario) });
  const { rows } = await evaluate({ candidate: { id: 'team', draft: data.draft }, start: sampleIndex, end: sampleIndex + 1, phase: 0, songIndex: 0 });
  const [sample] = unpackLuckSamples(rules, rows[0].packed, 2);
  const result = calculateArenaTeamReplay({ ...data, sampleIndex });
  const variant = result.replay.skillPlayback.variants[0];
  assert.equal(result.sample.playerIndex, 2);
  assert.equal(result.replay.noteScore, sample.noteScore);
  assert.equal(result.replay.score, sample.noteScore + sample.sections.reduce((sum, s) => sum + s.bonuses[0], 0));
  assert.deepEqual(variant.sections.map(s => s.luckPoints), sample.sections.map(s => s.luckPoints));
  assert.ok(variant.notes.length);
  assert.deepEqual(calculateArenaTeamReplay({ ...data, sampleIndex }), result);
});
