import { skillOrdersFor } from './skill-order-sampling.mjs';
import { createEventPipeline } from "./event-rules.mjs";
import { createFormationCalculator } from "./formation-power.mjs";
import { calculateFormalNoteCore } from "./formal-note-core.mjs";
import { createFormalSkillResolver } from "./formal-skills.mjs";
import { createFormalTickConverter } from "./formal-time.mjs";
import { reconstructFormalChart, FORMAL_CHART_MODEL_VERSION } from "./formal-chart.mjs";
import { stableSnapshotHash } from "../scoring-engine.mjs";
import { referenceScoringRules } from '../scoring-release-gate.mjs';
import { summarizeScoreDistribution, SCORE_DISTRIBUTION_VERSION } from './score-distribution.mjs';
import { liveSkillCommands, replayScoreTimeline, compareScoreFactors } from './formal-score-replay.mjs';
import { SCORE_MODEL_VERSION } from './model-version.mjs';

const f32 = Math.fround;


/** Reconstruct scoring events from authored nodes using production code.
 * Whole-song status retains the ideal-input / simultaneous-order limitation. */
export function prepareFormalChart(rules, chart) {
  if ((!referenceScoringRules(rules) && rules.native?.sourceReleaseId !== rules.sourceReleaseId) || rules.native?.nativeSha256 !== rules.nativeSha256) {
    throw new Error("Native scoring release_mismatch");
  }
  if (!chart?.notes?.length) throw new Error("请先选择并加载完整谱面");
  if (chart.sourceReleaseId && chart.sourceReleaseId !== rules.sourceReleaseId) throw new Error("Chart release_mismatch");
  const masterId = Number(/^music-chart-(\d+)$/.exec(chart.id)?.[1]);
  const master = rules.tables.LiveMusicScore.find((r) => r._id === masterId);
  if (!master) throw new Error("谱面不属于当前正式版 Master");
  const clock = createFormalTickConverter(chart.bpmEvents);
  const weights = new Map(rules.tables.LiveNoteParameter.map((r) => [r._noteOperateType, r._scorePercent]));
  const combos = rules.tables.LiveComboScoreBonus.filter((r) => r._comboBonusType === 0)
    .sort((a, b) => a._requiredComboCount - b._requiredComboCount);
  let cumulative = 0;
  const bonusSteps = combos.map((r) => ({ count: r._requiredComboCount,
    factor: f32(1 + Math.min(1, cumulative = f32(cumulative + f32(r._bonusFactor)))) }));
  const events = reconstructFormalChart(chart).map((event) => {
    if (!Number.isInteger(event.timeMs) || event.timeMs < 0 || !weights.has(event.type)) throw new Error("Invalid scoring event");
    return { ...event, weight: weights.get(event.type) };
  });
  let step = -1, previousTime, comboBeforeTime = 0;
  events.forEach((event, index) => {
    event.scoreIndex = index;
    // ExecuteCommand -> ComboCounter.GetTimingCombo (0x6a57398) ->
    // FindLastIndexBefore (0x6a573e8): read ONLY judgements with time < t.
    // Every note at the same native millisecond shares the pre-group combo.
    if (event.timeMs !== previousTime) comboBeforeTime = index;
    previousTime = event.timeMs;
    event.combo = comboBeforeTime;
    while (step + 1 < bonusSteps.length && bonusSteps[step + 1].count <= event.combo) step++;
    event.comboFactor = step < 0 ? 1 : bonusSteps[step].factor;
  });
  // Recover exact tick of authored skill positions from rounded display seconds.
  // Fail if the source precision cannot identify an integer tick unambiguously.
  let elapsed = 0;
  // Display seconds were projected with source decimal BPM, before native
  // float32 conversion. Recover ticks in that clock, then use the native one.
  const displaySegments = clock.segments.map(s => ({ ...s, bpm: chart.bpmEvents.find(e => (e.tick ?? e.t) === s.tick)?.bpm ?? 120 }));
  const sourceBpm = displaySegments.map((s, i, all) => {
    if (i) elapsed += (s.tick - all[i - 1].tick) * 60 / (all[i - 1].bpm * 480);
    return { ...s, seconds: elapsed };
  });
  const authoredTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid authored timing");
    const segment = sourceBpm.findLast((s) => s.seconds <= seconds + 0.000001);
    const tick = segment.tick + Math.round((seconds - segment.seconds) * segment.bpm * 8);
    const reconstructed = segment.seconds + (tick - segment.tick) / (segment.bpm * 8);
    if (Math.abs(reconstructed - seconds) > 0.000002) throw new Error("Cannot recover authored tick");
    return clock.atTick(tick);
  };
  const skillTimes = (chart.skillTimings ?? []).map(authoredTime).sort((a, b) => a - b);
  // BuildFeverList -> MakePosition uses TickToTimeMs, too. Rounding display
  // seconds directly can move a section edge into the wrong score bucket.
  const gekisouRanges = (chart.gekisouRanges ?? chart.feverRanges ?? []).map(r => ({ startMs: authoredTime(r.start), endMs: authoredTime(r.end) }));
  if (skillTimes.length !== 5 || skillTimes.some((s, i) => i && s <= skillTimes[i - 1])) {
    throw new Error("当前计算仅支持五次成员技能的普通演出谱面");
  }
  const weighted = events.reduce((sum, event) => f32(sum + event.weight), 0);
  const convertedNoteCount = Math.ceil(f32(weighted / 100));
  const warnings = ["谱面、倍率命令排序与 40 ms 记分桶回滚按正式包重建；输入和技能到达采用理想帧时钟，未验证实机完整判定流，整曲结果仍为估算。"];
  if (events.length !== master._fullComboCount) warnings.push(`谱面转换 ${events.length} 连击，与正式 Master ${master._fullComboCount} 不一致。`);
  return { chartId: chart.id, trackId: chart.trackId, difficulty: chart.difficulty,
    sourceReleaseId: rules.sourceReleaseId, level: master._musicScoreLevel,
    masterFullCombo: master._fullComboCount, events, skillTimes, gekisouRanges, convertedNoteCount,
    difficultyFactor: f32(1 + f32(f32(master._musicScoreLevel - 5) * rules.native.difficultyIncrement)),
    verificationStatus: referenceScoringRules(rules) ? 'reference_formula_reconstructed_chart' : 'code_formula_reconstructed_chart', warnings,
    chartHash: stableSnapshotHash({ chart, ruleSetVersion: rules.ruleSetVersion, modelVersion: SCORE_MODEL_VERSION, topologyVersion: FORMAL_CHART_MODEL_VERSION }) };
}

export function createFormalSongCalculator(rules, chart, { eventAdapters = [], scorePrecision = 'full', frameRate = 60 } = {}) {
  if (![30, 60, 120].includes(frameRate)) throw new Error('模拟帧率须为 30、60 或 120');
  const orders = skillOrdersFor(scorePrecision);
  const timeline = prepareFormalChart(rules, chart);
  const formation = createFormationCalculator(rules, { eventAdapters });
  const resolveSkills = createFormalSkillResolver(rules);
  const setting = (key) => Number(rules.tables.LiveSettings.find((r) => r._key === key)?._value);
  const judgement = rules.tables.LiveJudgementParameter.find((r) => r._noteSimulateJudgement === 5)._scorePercent;
  // The ideal factor history depends on the chart and effective skill commands,
  // never on formation power. Reuse that history across candidate teams inside
  // this calculator, retaining native replay for every previously unseen stream.
  const factorHistories = new Map();
  let factorHistoryBytes = 0;
  function calculate(draft, { includeTrace = false } = {}) {
    if (draft.slots?.length !== 5 || draft.slots.some((s) => !s.memberCardId || !s.supportCardId)) throw new Error("请选择五张成员卡和五张留影");
    if (draft.selectedSongId !== timeline.trackId || draft.selectedDifficulty !== timeline.difficulty) throw new Error("歌曲或难度与载入谱面不一致");
    const power = formation.calculate(draft);
    const eventPipeline = createEventPipeline(rules, draft.modifiers?.event, eventAdapters);
    const scoreAdapters = eventPipeline.context.effects.some(e => e.phase === 'note_score' || e.phase === 'fixed_score');
    const skills = resolveSkills(draft);
    const common = { totalPower: power.total.total, scoreAdjustmentFactor: setting("note_score_adjustment_factor"),
      musicScoreLevelFactor: timeline.difficultyFactor, judgementFactorPercent: judgement,
      luckScoreFactorPercent: 100, convertedNoteCount: timeline.convertedNoteCount,
      eventBonusFactor: 1, lifeOnusFactor: setting("note_score_life_onus_factor"),
      assistModeNoteScoreFactor: 1, currentLife: setting("life_base") };
    const noteScore = (event, factor) => calculateFormalNoteCore(eventPipeline.apply("note_score", { ...common, noteFactorPercent: event.weight,
      comboBonusFactor: event.comboFactor, scoreUpFactor: factor }, { draft, note: event })).score;
    const groups = new Map(), scoreCaches = [], baseNotes = [];
    for (const event of timeline.events) {
      let cache;
      if (!scoreAdapters) {
        let combos = groups.get(event.weight);
        if (!combos) groups.set(event.weight, combos = new Map());
        cache = combos.get(event.comboFactor);
        if (!cache) combos.set(event.comboFactor, cache = new Map());
      } else cache = new Map();
      if (!cache.has(1)) cache.set(1, noteScore(event, 1));
      scoreCaches.push(cache); baseNotes.push(cache.get(1));
    }
    const baseScore = baseNotes.reduce((a, b) => a + b, 0);
    // ApplyFactorCommand (0x55e2a14) adds/removes EACH float32 factor.
    // Accumulating integers and dividing once loses native rounding history,
    // including the small residual after a skill ends. Cache note scores by
    // factor, but retain that history across all 120 complete order sweeps.
    const orderCache = new Map();
    const scoreOrder = (order, trace = false) => {
      const commands = liveSkillCommands(order, skills, timeline.skillTimes, frameRate);
      // Key the effective command order, keeping duplicate order probability.
      const cacheKey = !trace && !scoreAdapters
        ? JSON.stringify(commands.slice().sort(compareScoreFactors).map(({ ownerId, ...c }) => c)) : null;
      if (cacheKey !== null && orderCache.has(cacheKey)) return orderCache.get(cacheKey);
      const valueAt = (event, factor) => {
        const cache = scoreCaches[event.scoreIndex];
        let value = cache.get(factor);
        if (value === undefined) { value = noteScore(event, factor); cache.set(factor, value); }
        return value;
      };
      const history = cacheKey === null ? null : factorHistories.get(cacheKey);
      const factors = !history && cacheKey !== null && timeline.events.length * 4 <= 4 * 1024 * 1024
        ? new Float32Array(timeline.events.length) : null;
      const replay = history ? null : replayScoreTimeline({ events: timeline.events, commands, frameRate, retainNotes: trace || scoreAdapters,
        scoreNote(event, state) {
          const factor = f32(state.general + state.perfect), i = event.scoreIndex;
          if (factors) factors[i] = factor;
          return { scoreUpFactor: factor, score: valueAt(event, factor) };
        } });
      if (factors) {
        while (factorHistories.size && (factorHistories.size >= 512 || factorHistoryBytes + factors.byteLength > 4 * 1024 * 1024)) {
          const key = factorHistories.keys().next().value;
          factorHistoryBytes -= factorHistories.get(key).byteLength; factorHistories.delete(key);
        }
        factorHistories.set(cacheKey, factors); factorHistoryBytes += factors.byteLength;
      }
      let score = history ? timeline.events.reduce((sum,event,i) => sum + valueAt(event, history[i]), 0) : replay.score, cumulativeScore = 0;
      const notes = trace ? replay.notes.sort((a, b) => a.scoreIndex - b.scoreIndex).map(event => {
        cumulativeScore += event.result.score;
        const { result, sequence, ...note } = event;
        return { ...note, ...result, cumulativeScore };
      }) : undefined;
      const noteTotal = score;
      score = eventPipeline.apply("fixed_score", score, { draft, order });
      if (!Number.isSafeInteger(score) || score < 0) throw new Error("Invalid event fixed score result");
      const result = { score, noteTotal, fixedScore: score - noteTotal, notes, ...(trace ? { commands } : {}) };
      if (cacheKey !== null) orderCache.set(cacheKey, result);
      return result;
    };
    const scores = [];
    let total = 0, noteTotal = 0, minimum = Infinity, maximum = -Infinity, bestOrder, worstOrder;
    for (const order of orders) {
      const scored = scoreOrder(order), score = scored.score;
      scores.push(score);
      total += score; noteTotal += scored.noteTotal;
      if (score < minimum) { minimum = score; worstOrder = order; }
      if (score > maximum) { maximum = score; bestOrder = order; }
    }
    const bestTrace = includeTrace ? scoreOrder(bestOrder, true) : null;
    const worstTrace = includeTrace ? scoreOrder(worstOrder, true) : null;
    return { status: "estimated", timingModel: { frameRate, clock: "ideal", scoreBucketMs: 40 }, modelVersion: SCORE_MODEL_VERSION, scorePrecision, verificationStatus: timeline.verificationStatus,
      scenario: eventPipeline.context.id == null ? "ordinary_non_event_all_perfect_full_life_no_assist" : "ordinary_event_all_perfect_full_life_no_assist", event: eventPipeline.context, sourceReleaseId: rules.sourceReleaseId,
      ruleSetVersion: rules.ruleSetVersion, inputHash: stableSnapshotHash({ draft, chartHash: timeline.chartHash, frameRate, distributionVersion: SCORE_DISTRIBUTION_VERSION, ...(scorePrecision === 'screen' ? { scorePrecision } : {}) }),
      power: power.total.total, baseScore, expectedScore: total / orders.length, minimumScore: minimum, maximumScore: maximum,
      scoreDistribution: summarizeScoreDistribution(scores, { complete: scorePrecision === 'full' }),
      skillScoreGain: noteTotal / orders.length - baseScore, eventFixedScoreGain: (total - noteTotal) / orders.length, orderCount: orders.length,
      bestOrder: [...bestOrder], worstOrder: [...worstOrder], skills,
      chart: { id: timeline.chartId, level: timeline.level, difficultyFactor: timeline.difficultyFactor,
        convertedNoteCount: timeline.convertedNoteCount, eventCount: timeline.events.length,
        masterFullCombo: timeline.masterFullCombo, skillTimes: timeline.skillTimes, chartHash: timeline.chartHash },
      warnings: timeline.warnings, ...(includeTrace ? { bestOrderNotes: bestTrace.notes, bestOrderFixedScore: bestTrace.fixedScore,
        skillPlayback: { skills, skillTimes: timeline.skillTimes, frameRate, variants: [
          { kind: 'best', order: [...bestOrder], ...bestTrace },
          { kind: 'worst', order: [...worstOrder], ...worstTrace }
        ] } } : {}) };
  }
  function checkBoundContext(eventContext) {
    // Pure power/song-context adapters have already been incorporated in the
    // pairing's power. Any note/fixed-score phase needs its own bound instead.
    if (eventAdapters.length && (eventContext == null || createEventPipeline(rules, eventContext, eventAdapters)
      .context.effects.some(e => ['note_score','fixed_score'].includes(e.phase)))) {
      throw new Error("Event optimizer requires an independently audited upper bound");
    }
  }
  function upperBound(totalPower, scoreUpFactor, { eventContext = null } = {}) {
    checkBoundContext(eventContext);
    const cache=new Map();
    return timeline.events.reduce((sum, event, index) => {
      const factor=typeof scoreUpFactor === 'function' ? scoreUpFactor(event,index) : scoreUpFactor;
      let combos=cache.get(event.weight);if(!combos)cache.set(event.weight,combos=new Map());
      let factors=combos.get(event.comboFactor);if(!factors)combos.set(event.comboFactor,factors=new Map());
      if(!factors.has(factor))factors.set(factor,calculateFormalNoteCore({ totalPower,
      scoreAdjustmentFactor: setting("note_score_adjustment_factor"), musicScoreLevelFactor: timeline.difficultyFactor,
      noteFactorPercent: event.weight, judgementFactorPercent: judgement, comboBonusFactor: event.comboFactor,
      scoreUpFactor: factor,
      luckScoreFactorPercent: 100, convertedNoteCount: timeline.convertedNoteCount,
      eventBonusFactor: 1, lifeOnusFactor: 1, assistModeNoteScoreFactor: 1, currentLife: 1000 }).score);
      return sum+factors.get(factor);
    },0);
  }
  // For any nonnegative factor f, native noteScore(P,f) <= coefficient(P)*f.
  // Use the exact native prefix at f=1, then cover the factor multiplication,
  // division and integer-to-f32 conversion after the floor. Multiplications by
  // 1 are exact. (1+u)^3/(1-u) < 1+8u for u=2^-24. Floors only lower the score.
  function linearUpperBound(totalPower, { eventContext = null } = {}) {
    checkBoundContext(eventContext);
    const cache=new Map();
    return timeline.events.map(event => {
      let combos=cache.get(event.weight);if(!combos)cache.set(event.weight,combos=new Map());
      if(!combos.has(event.comboFactor))combos.set(event.comboFactor,calculateFormalNoteCore({ totalPower,
      scoreAdjustmentFactor: setting('note_score_adjustment_factor'), musicScoreLevelFactor: timeline.difficultyFactor,
      noteFactorPercent: event.weight, judgementFactorPercent: judgement, comboBonusFactor: event.comboFactor,
      scoreUpFactor: 1, luckScoreFactorPercent: 100, convertedNoteCount: timeline.convertedNoteCount,
      eventBonusFactor: 1, lifeOnusFactor: 1, assistModeNoteScoreFactor: 1, currentLife: 1000
      }).beforeFirstFloor * (1 + 2 ** -21));
      return combos.get(event.comboFactor);
    });
  }
  return { calculate, timeline, upperBound, linearUpperBound };
}
