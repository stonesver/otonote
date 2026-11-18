import test from 'node:test';
import assert from 'node:assert/strict';
import { arenaLuckScoreDistribution, arenaSongPreview } from '../src/lib/arena-team-preview.mjs';
import { sampleArenaLuckSong } from '../src/lib/arena-luck-distribution.mjs';
import { createLuckEvaluator, luckSamplePlan, unpackLuckSamples } from '../src/lib/arena-luck-evaluator.mjs';
import { applyArenaContext } from '../../packages/scoring/scoring-rules/arena-context.mjs';
import { normalizePerformanceScenario } from '../../packages/scoring/scoring-rules/performance-scenarios.mjs';
import { createInventoryManager } from '../src/lib/inventory-manager.mjs';
import { fixture } from './fixtures/gekisou-skill-fixture.mjs';

test('single-song quantiles preserve joint section outcomes and support different ranks per section', () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({ noteScore: 100,
    sections: [10 * i, 200 - 10 * i, 0].map(bonus => ({ bonuses: [bonus, 0], missionType: 2, luckPoints: i })) }));
  const before = structuredClone(samples);
  // Opposite outcomes in the two sections always sum to 200, even though
  // independently adding their 90th percentiles would suggest a higher score.
  assert.deepEqual(arenaLuckScoreDistribution(samples, [1, 1, 1]),
    { count: 20, mean: 300, p10: 300, p90: 300, minimum: 300, maximum: 300 });
  assert.deepEqual(arenaLuckScoreDistribution(samples, [2, 1, 2]),
    { count: 20, mean: 205, p10: 120, p90: 280, minimum: 110, maximum: 300 });
  for (const rank of [1, 2]) assert.equal(arenaLuckScoreDistribution(samples, [rank, rank, rank]).mean, arenaSongPreview({ samples }, { rank }).score);
  assert.deepEqual(samples, before);
});

test('distribution reports sampled extrema without rounding away individual bonus settlement', () => {
  const samples = [0, 1, 2].map(n => ({ noteScore: 100 + n, sections: [{ bonuses: [3, 2] }, { bonuses: [7, 4] }, { bonuses: [11, 6] }] }));
  assert.deepEqual(arenaLuckScoreDistribution(samples, [2, 1, 2]),
    { count: 3, mean: 116, p10: 115, p90: 117, minimum: 115, maximum: 117 });
});

test('on-demand replay uses actual growth, a separate sample domain, and exactly the requested song', async () => {
  const { rules: sourceRules, chart, draft } = fixture({ missions: [2, 2, 2] });
  const manager = createInventoryManager(sourceRules);
  draft.modifiers.growth = Object.fromEntries(draft.slots.flatMap(slot => ['member', 'support'].map(kind => {
    const id = slot[`${kind}CardId`], growth = manager.preset(id, kind, 'minimum');
    growth.level = 10; return [id, growth];
  })));
  const stage = { bandId: 1, musicType: 5, missions: [2, 2, 2], participantCount: 4 };
  const performanceScenario = { profile: 'steady', samples: 3, timingSpreadMs: 10, seed: 924 };
  const song = { trackId: chart.trackId, difficulty: chart.difficulty, chart, weight: 1 }, songIndex = 3;
  const input = { rules: sourceRules, stage, song, songIndex, performanceScenario, candidate: { id: 'actual', draft } };
  const before = structuredClone(input), progress = [];
  const result = await sampleArenaLuckSong(input, { onProgress: p => progress.push(p) });
  assert.equal(result.samples.length, 576);
  assert.deepEqual(progress.at(-1), { completed: 576, total: 576 });
  const { rules, context } = applyArenaContext(sourceRules, stage), performance = normalizePerformanceScenario(performanceScenario);
  const evaluate = createLuckEvaluator({ rules, context, songs: [song], performance });
  const first = await evaluate({ candidate: input.candidate, start: 0, end: 24, phase: 103, songIndex: 0 });
  assert.deepEqual(result.samples.slice(0, 24), unpackLuckSamples(rules, first.rows[0].packed, 4));
  const plan = phase => luckSamplePlan({ seed: 924, songIndex: 0, playerCount: 3, player: 0, start: 0, end: 24, phase });
  assert.notDeepEqual(plan(103), plan(0)); assert.notDeepEqual(plan(103), plan(1));
  assert.deepEqual(input, before);
  assert.ok(result.samples.every(sample => sample.sections.length === 3 && sample.sections.every(section => section.bonuses.length === 4)));
});
