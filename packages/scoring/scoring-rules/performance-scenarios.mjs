import { prepareFormalChart } from './formal-song-score.mjs';
import { createFrameClock } from './formal-frame-clock.mjs';
import { createScoringRandom } from './gekisou-luck.mjs';
import { formalJudgementType } from './formal-judgement.mjs';
import { requireInteger } from './formation-power.mjs';

export const PERFORMANCE_SCENARIO_VERSION = 'performance-scenario-v1';
export const TIMING_PERFORMANCE_VERSION = 'ournotes-performance-timing-v1';
export const PERFORMANCE_PROFILES = Object.freeze([
  { id: 'ideal', label: '理想发挥', timingSpreadMs: 0, missRate: 0, description: '零毫秒偏差、不漏击；JUST 段按可用判定窗口计算。' },
  { id: 'steady', label: '连击较稳的参考发挥', timingSpreadMs: 65, missRate: 0, description: '每个音符偏差在 -65 至 65 毫秒间均匀抽样，不额外漏击；这是参考条件，不代表你的实测水平。' },
  { id: 'practice', label: '练习中的参考发挥', timingSpreadMs: 110, missRate: 0.02, description: '偏差在 -110 至 110 毫秒间均匀抽样，另有 2% 漏击；可以指定难段。' },
]);
export function normalizePerformanceScenario(input = {}) {
  if (typeof input === 'string') input = { profile: input };
  const profile = input.profile ?? 'steady';
  const preset = PERFORMANCE_PROFILES.find(row => row.id === profile);
  if (!preset && profile !== 'explicit') throw new Error('未知的发挥情景');
  if (profile === 'explicit' && !input.performance) throw new Error('指定发挥需要完整判定文件');
  const seed = requireInteger(input.seed ?? 20261004, 'player seed', 0, 0xffffffff);
  const samples = requireInteger(input.samples ?? (profile === 'ideal' || profile === 'explicit' ? 1 : 3), 'player samples', 1, 16);
  const timingBiasMs = requireInteger(input.timingBiasMs ?? 0, 'timing bias', -500, 500);
  const timingSpreadMs = requireInteger(input.timingSpreadMs ?? preset?.timingSpreadMs ?? 0, 'timing spread', 0, 500);
  const missRate = input.missRate ?? preset?.missRate ?? 0;
  if (!Number.isFinite(missRate) || missRate < 0 || missRate > 1) throw new Error('漏击比例须在 0 至 1 之间');
  const difficultRanges = (input.difficultRanges ?? []).map(range => {
    if (!Number.isSafeInteger(range.startMs) || !Number.isSafeInteger(range.endMs) || range.startMs < 0 || range.endMs <= range.startMs) throw new Error('难段起止时间无效');
    const spreadMultiplier = range.spreadMultiplier ?? 1.5;
    if (!Number.isFinite(spreadMultiplier) || spreadMultiplier < 1 || spreadMultiplier > 5) throw new Error('难段偏差倍率须在 1 至 5 之间');
    return { startMs: range.startMs, endMs: range.endMs, spreadMultiplier };
  });
  const frameRate = input.frameRate ?? 60;
  createFrameClock({ frameRate });
  return { version: PERFORMANCE_SCENARIO_VERSION, profile, seed, samples: profile === 'explicit' ? 1 : samples,
    timingBiasMs, timingSpreadMs, missRate, difficultRanges, frameRate,
    ...(profile === 'explicit' ? { performance: structuredClone(input.performance) } : {}),
    description: profile === 'explicit' ? '按指定操作回放。' : preset.description };
}

/** Generate once per chart/sample, never per candidate. Raw offsets are before
 * any card's window expansion or converter; RNG is separate from game luck. */
export function createPerformanceScenario(rules, chart, input = {}, sampleIndex = 0) {
  const scenario = normalizePerformanceScenario(input);
  if (scenario.profile === 'explicit') return structuredClone(scenario.performance);
  requireInteger(sampleIndex, 'player sample index', 0, 15);
  const timeline = prepareFormalChart(rules, { ...chart, sourceReleaseId: chart.sourceReleaseId ?? rules.sourceReleaseId });
  const random = createScoringRandom((scenario.seed + Math.imul(sampleIndex, 2654435761)) >>> 0);
  const clock = createFrameClock({ frameRate: scenario.frameRate });
  return { version: TIMING_PERFORMANCE_VERSION, chartId: timeline.chartId, chartHash: timeline.chartHash, frameRate: scenario.frameRate,
    skillOrder: [0, 1, 2, 3, 4], judgements: timeline.events.map(event => {
      const multiplier = Math.max(1, ...scenario.difficultRanges.filter(r => event.timeMs >= r.startMs && event.timeMs <= r.endMs).map(r => r.spreadMultiplier));
      const timingOffsetMs = Math.max(-event.timeMs, scenario.timingBiasMs + Math.round((random() * 2 - 1) * scenario.timingSpreadMs * multiplier));
      const missed = random() < scenario.missRate;
      return { scoreIndex: event.scoreIndex, timeMs: event.timeMs, timingOffsetMs, missed,
        inputFrame: clock.indexAt(event.timeMs + timingOffsetMs) };
    }) };
}

/** Table-informed timing scenario, not a recreation of touch hit-testing.
 * Automatic subnotes are retained as chart events; explicit judgements remain
 * the route for captured outcomes whose raw operations cannot be recovered. */
export function resolveTimingJudgement(rules, event, { justEnabled = false, justExpansion = () => 0 } = {}) {
  if (event.originalJudgement != null) return event.originalJudgement;
  if (event.missed) return 1;
  const offset = event.timingOffsetMs;
  const type = formalJudgementType(event.type, event.critical);
  const rows = rules.tables.LiveJudgementTiming.filter(row => row._assistLevel === 0 && row._noteSimulateJudgement >= 1 && row._noteSimulateJudgement <= 6 && row._noteJudgementType === type && (justEnabled || row._noteSimulateJudgement !== 6))
    .sort((a, b) => a._judgementPriority - b._judgementPriority);
  if (!rows.length) throw new Error(`缺少音符类型 ${type} 的判定窗口`);
  return rows.find(row => Math.abs(offset) <= (offset < 0 ? row._beforeMs : row._afterMs) +
    (row._noteSimulateJudgement === 6 ? justExpansion(offset < 0 ? row._beforeMs : row._afterMs) : 0))?._noteSimulateJudgement ?? 1;
}
