import { applyArenaContext } from '../../../packages/scoring/scoring-rules/arena-context.mjs';
import { normalizePerformanceScenario } from '../../../packages/scoring/scoring-rules/performance-scenarios.mjs';
import { createLuckEvaluator, unpackLuckSamples } from './arena-luck-evaluator.mjs';

/** A held-out single-song experiment, independent of recommendation ranking.
 * Keep joint samples so changing assumed ranks requires no new replay. */
export async function sampleArenaLuckSong({ rules: sourceRules, stage, song, songIndex, performanceScenario, candidate },
  { onProgress, yieldControl = async () => {} } = {}) {
  const { rules, context } = applyArenaContext(sourceRules, stage);
  const performance = normalizePerformanceScenario(performanceScenario);
  const evaluate = createLuckEvaluator({ rules, context, songs: [song], performance });
  const count = Math.ceil(576 / performance.samples) * performance.samples;
  const block = Math.ceil(24 / performance.samples) * performance.samples, samples = [];
  for (let start = 0; start < count; start += block) {
    const end = Math.min(count, start + block);
    const result = await evaluate({ candidate, start, end, phase: 100 + songIndex, songIndex: 0 }, { yieldControl });
    if (result.omitted) throw Error(result.omitted.reason);
    samples.push(...unpackLuckSamples(rules, result.rows[0].packed, context.participantCount));
    onProgress?.({ completed: end, total: count });
    await yieldControl();
  }
  return { samples };
}
