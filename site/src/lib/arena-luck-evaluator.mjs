import { createGekisouSongCalculator } from '../../../packages/scoring/scoring-rules/gekisou-song-score.mjs';
import { createPerformanceScenario } from '../../../packages/scoring/scoring-rules/performance-scenarios.mjs';
import { createScoringRandom } from '../../../packages/scoring/scoring-rules/gekisou-luck.mjs';
import { skillOrdersFor } from '../../../packages/scoring/scoring-rules/skill-order-sampling.mjs';
import { UnsupportedSkillMechanismError } from '../../../packages/scoring/scoring-rules/skill-mechanism-error.mjs';
import { arenaRankingSample } from '../../../packages/scoring/scoring-rules/arena-comparison.mjs';
const orders = skillOrdersFor('full');

/** Player strata are balanced in complete blocks. Order and lottery randomness
 * are sampled jointly. Discovery and validation use separate seed domains.
 * Seeds identify experiments, not equal lottery outcomes between teams. */
export function luckSamplePlan({ seed, songIndex, playerCount, player, start, end, phase }) {
  const plan = [];
  for (let index = start; index < end; index++) if (index % playerCount === player) {
    const random = createScoringRandom((seed ^ Math.imul(songIndex + 1, 9176) ^
      Math.imul(index + 1, 2654435761) ^ Math.imul(phase + 1, 17312345)) >>> 0);
    plan.push({ order: orders[Math.floor(random() * orders.length)], seed: Math.floor(random() * 4294967296) });
  }
  return plan;
}

// Ten numbers per complete-song sample: total note score, then three ranking
// tuples. Transfer arrays instead of cloning thousands of small worker objects.
export function unpackLuckSamples(rules, packed, participants) {
  const samples = [];
  for (let i = 0; i < packed.length; i += 10) {
    const sections = [0, 1, 2].map(j => ({ index: j + 1, missionType: 2, just: 0, combo: 0,
      luckPoints: packed[i + 1 + j * 3], noteScore: packed[i + 2 + j * 3], perfectCount: packed[i + 3 + j * 3] }));
    samples.push(arenaRankingSample(rules, { noteScore: packed[i], sections }, [2, 2, 2], participants));
  }
  return samples;
}

export function createLuckEvaluator({ rules, context, songs, performance }) {
  const calculators = new Map();
  const forSong = index => {
    const song = songs[index];
    if (!calculators.has(index)) calculators.set(index, Array.from({ length: performance.samples }, (_, sample) =>
    createGekisouSongCalculator(rules, song.chart, {
      performance: createPerformanceScenario(rules, song.chart, performance, sample), performanceOrder: 'sampled',
      scenario: { ranks: Array(3).fill(context.participantCount), frameRate: performance.frameRate }
    })));
    return calculators.get(index);
  };
  return async ({ candidate, start, end, phase, songIndex }, { yieldControl = async () => {} } = {}) => {
    const rows = [];
    try {
      for (const s of songIndex === undefined ? songs.keys() : [songIndex]) {
        const song = songs[s];
        const packed = new Float64Array((end - start) * 10); let position = 0, power;
        for (const [player, calculator] of forSong(s).entries()) {
          const samplePlan = luckSamplePlan({ seed: performance.seed, songIndex: s, playerCount: performance.samples, player, start, end, phase });
          if (performance.profile === 'explicit') for (const sample of samplePlan) sample.order = performance.performance.skillOrder;
          if (!samplePlan.length) continue;
          const result = calculator.calculateRankingSamples({ ...candidate.draft, selectedSongId: song.trackId, selectedDifficulty: song.difficulty }, { samplePlan });
          power = result.power;
          for (const sample of result.rankingSamples) {
            packed[position++] = sample.noteScore;
            for (const section of sample.sections) { packed[position++] = section.luckPoints; packed[position++] = section.noteScore; packed[position++] = section.perfectCount; }
          }
          await yieldControl();
        }
        rows.push({ power, packed });
      }
      return { id: candidate.id, rows, ...(songIndex === undefined ? {} : { songIndex }) };
    } catch (error) {
      if (!(error instanceof UnsupportedSkillMechanismError)) throw error;
      return { id: candidate.id, omitted: { id: candidate.id, reason: error.message, ...error.detail } };
    }
  };
}
