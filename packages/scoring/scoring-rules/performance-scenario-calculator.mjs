import { normalizePerformanceScenario, createPerformanceScenario } from './performance-scenarios.mjs';
import { createPerformanceSongCalculator } from './formal-performance-replay.mjs';
import { createGekisouSongCalculator } from './gekisou-song-score.mjs';
import { skillOrdersFor } from './skill-order-sampling.mjs';
import { summarizeScoreDistribution } from './score-distribution.mjs';
import { stableSnapshotHash } from '../scoring-engine.mjs';

/** Shared adapter for candidate evaluation. Player samples are created once
 * here; identical chart/scenario/seed means identical raw operations for every
 * team. Skill order, game luck and opponent assumptions remain separate. */
export function createScenarioSongCalculator(rules, chart, { mode = 'ordinary', performanceScenario = {}, scenario, scorePrecision = 'full', eventAdapters = [] } = {}) {
  if (!['ordinary', 'gekisou'].includes(mode)) throw new Error('未知演出模式');
  const player = normalizePerformanceScenario(performanceScenario);
  const inputs = Array.from({ length: player.samples }, (_, i) => createPerformanceScenario(rules, chart, player, i));
  const calculators = inputs.flatMap((performance, sampleIndex) => {
    if (mode === 'gekisou') return [{ sampleIndex, calculator: createGekisouSongCalculator(rules, chart, { performance, performanceOrder: player.profile === 'explicit' ? 'fixed' : 'sampled', scenario, scorePrecision, eventAdapters }) }];
    const orders = player.profile === 'explicit' ? [performance.skillOrder] : skillOrdersFor(scorePrecision);
    const calculator = createPerformanceSongCalculator(rules, chart, { performance, eventAdapters });
    return [{ sampleIndex, orders, calculator }];
  });
  function calculate(draft, { includeTrace = false } = {}) {
    const results = calculators.flatMap(entry => mode === 'gekisou'
      ? [{ ...entry, result: entry.calculator.calculate(draft) }]
      : entry.calculator.calculateOrders(draft, { skillOrders: entry.orders })
        .map((result, i) => ({ ...entry, skillOrder: entry.orders[i], result })));
    const scores = results.flatMap(({ result }) => result.scoreDistribution.outcomes.flatMap(row => Array(row.count).fill(row.score)));
    const distribution = summarizeScoreDistribution(scores, { kind: 'seed_samples', complete: false });
    const best = results.reduce((a, b) => a.result.maximumScore >= b.result.maximumScore ? a : b);
    const worst = results.reduce((a, b) => a.result.minimumScore <= b.result.minimumScore ? a : b);
    const trace = includeTrace ? best.calculator.calculate(draft, { includeTrace: true, skillOrder: best.skillOrder }) : best.result;
    const worstTrace = includeTrace ? (best === worst ? trace : worst.calculator.calculate(draft, { includeTrace: true, skillOrder: worst.skillOrder })) : null;
    const mean = field => results.reduce((sum, row) => sum + (row.result[field] ?? 0), 0) / results.length;
    const sections = trace.sections?.map((section, i) => ({ ...section,
      ...Object.fromEntries(['noteScore','rankingBonus','totalScore','ordinaryReferenceScore','combo','currentCombo','maxCombo','just','rawJust','luckPoints','perfectCount','rank','share'].map(key =>
        [key, results.reduce((sum, row) => sum + row.result.sections[i][key], 0) / results.length])),
      rankProbabilities: section.rankProbabilities.map((_, rank) => results.reduce((sum, row) => sum + row.result.sections[i].rankProbabilities[rank], 0) / results.length),
    }));
    const warnings = [...new Set([...results.flatMap(row => row.result.warnings ?? []),
      '发挥样本是公开条件下的参考抽样，不是个人水平测量；最低和最高分只描述本次样本。',
      '同一批原始操作用于所有候选；玩家波动、技能顺序、游戏随机和对手条件分别保存。'])];
    const result = { ...trace, score: distribution.mean, expectedScore: distribution.mean, minimumScore: distribution.minimum, maximumScore: distribution.maximum,
      scorePrecision, scoreDistribution: distribution, sampleCount: scores.length,
      orderCount: mode === 'gekisou' ? best.result.orderCount : results.length / inputs.length,
      randomSources: { player: player.profile !== 'explicit' && (player.timingSpreadMs > 0 || player.missRate > 0),
        skillOrder: mode === 'gekisou' ? best.result.orderCount > 1 : results.length > inputs.length, game: Boolean(trace.randomSampling) },
      scenario: { ...(mode === 'gekisou' ? trace.scenario : {}), performanceScenario: player },
      playerScenario: player, performanceScenario: player, playerSampleCount: inputs.length,
      playerSamples: inputs.map((_, i) => {
        const rows = results.filter(row => row.sampleIndex === i).map(row => row.result);
        return { index: i, inputHash: stableSnapshotHash(inputs[i]), expectedScore: rows.reduce((sum,row)=>sum+row.expectedScore,0)/rows.length,
          minimumScore: Math.min(...rows.map(row=>row.minimumScore)), maximumScore: Math.max(...rows.map(row=>row.maximumScore)) };
      }),
      ...(sections ? { sections, rankingBonus: mean('rankingBonus'), rankingBonusShare: mean('rankingBonus') / distribution.mean } :
        { baseScore: mean('baseScore'), skillScoreGain: mean('skillScoreGain'), eventFixedScoreGain: mean('eventFixedScoreGain') }),
      // LUCK standard error of one player sample cannot describe mixed player
      // variation. Keep that separate rather than reusing a misleading number.
      standardError: null, bestOrder: best.result.bestOrder, worstOrder: worst.result.worstOrder,
      inputHash: stableSnapshotHash({ inputHashes: results.map(row=>row.result.inputHash), player, mode }), warnings,
      ...(includeTrace ? { bestPlayerSampleIndex: best.sampleIndex, worstPlayerSampleIndex: worst.sampleIndex } : {}),
    };
    if (includeTrace && trace.skillPlayback) result.skillPlayback = { ...trace.skillPlayback, randomSampling: Boolean(result.randomSources.player || result.randomSources.game),
      variants: [{ ...(trace.skillPlayback.variants.find(v=>v.kind==='best') ?? trace.skillPlayback.variants[0]), kind: 'best', playerSampleIndex: best.sampleIndex },
        { ...(worstTrace.skillPlayback.variants.find(v=>v.kind==='worst') ?? worstTrace.skillPlayback.variants[0]), kind: 'worst', playerSampleIndex: worst.sampleIndex }] };
    return result;
  }
  return { calculate, timeline: calculators[0].calculator.timeline, scenario: { performanceScenario: player },
    ...(calculators[0].calculator.upperBound ? { upperBound: calculators[0].calculator.upperBound } : {}) };
}
