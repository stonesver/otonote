import { prepareFormalChart } from './formal-song-score.mjs';
import { createFormationCalculator } from './formation-power.mjs';
import { createFormalSkillResolver } from './formal-skills.mjs';
import { createFrameClock, skillEndFrame } from './formal-frame-clock.mjs';
import { createScoreReplay } from './formal-score-replay.mjs';
import { calculateFormalNoteCore } from './formal-note-core.mjs';
import { createLifeReplay, createComboReplay, createOrdinarySkillLifecycle } from './formal-performance-state.mjs';
import { createEventPipeline } from './event-rules.mjs';
import { summarizeScoreDistribution } from './score-distribution.mjs';
import { stableSnapshotHash } from '../scoring-engine.mjs';
import { SCORE_MODEL_VERSION } from './model-version.mjs';
import { TIMING_PERFORMANCE_VERSION, resolveTimingJudgement } from './performance-scenarios.mjs';

export const PERFORMANCE_VERSION = 'ournotes-performance-v1';
const f32 = Math.fround;
const judgementField = { 3: 'good', 4: 'great', 5: 'perfect', 6: 'just' };
const chartWithRelease = (rules, chart) => ({ ...chart, sourceReleaseId: chart.sourceReleaseId ?? rules.sourceReleaseId });

export function createPerformanceTemplate(rules, chart, { frameRate = 60 } = {}) {
  const timeline = prepareFormalChart(rules, chartWithRelease(rules, chart));
  const clock = createFrameClock({ frameRate });
  return { version: PERFORMANCE_VERSION, chartId: timeline.chartId, chartHash: timeline.chartHash, frameRate,
    skillOrder: [0, 1, 2, 3, 4], judgements: timeline.events.map(event => ({ scoreIndex: event.scoreIndex,
      timeMs: event.timeMs, judgement: 5, inputFrame: clock.indexAt(event.timeMs) })) };
}

export function validateAgainstTimeline(timeline, performance, defaultFrameRate) {
  if (!performance || ![PERFORMANCE_VERSION, TIMING_PERFORMANCE_VERSION].includes(performance.version)) throw new Error('判定文件版本不受支持');
  if (performance.chartId !== timeline.chartId || performance.chartHash !== timeline.chartHash) throw new Error('判定文件与当前谱面或模型不匹配，请重新下载模板');
  const allowed = new Set(['version', 'chartId', 'chartHash', 'frameRate', 'frames', 'skillOrder', 'judgements']);
  for (const key of Object.keys(performance)) if (!allowed.has(key)) throw new Error(`不支持的判定文件字段：${key}`);
  const frameRate = performance.frameRate ?? defaultFrameRate ?? 60;
  const clock = createFrameClock({ frameRate, frames: performance.frames });
  const order = performance.skillOrder;
  if (!Array.isArray(order) || order.length !== 5 || new Set(order).size !== 5 || order.some(i => !Number.isInteger(i) || i < 0 || i > 4)) throw new Error('技能顺序必须是 0 至 4 的完整排列');
  if (!Array.isArray(performance.judgements) || performance.judgements.length !== timeline.events.length) throw new Error(`判定文件须包含全部 ${timeline.events.length} 个计分事件`);
  const seen = new Set();
  const judgements = performance.judgements.map((row, sequence) => {
    if (!row || Object.keys(row).some(key => !(performance.version === TIMING_PERFORMANCE_VERSION ? ['scoreIndex', 'timeMs', 'timingOffsetMs', 'missed', 'inputFrame'] : ['scoreIndex', 'timeMs', 'judgement', 'inputFrame']).includes(key))) throw new Error(`第 ${sequence + 1} 条判定包含未知字段`);
    if (!Number.isInteger(row.scoreIndex) || row.scoreIndex < 0 || row.scoreIndex >= timeline.events.length || seen.has(row.scoreIndex)) throw new Error(`第 ${sequence + 1} 条计分事件编号重复或无效`);
    seen.add(row.scoreIndex);
    const event = timeline.events[row.scoreIndex];
    if (row.timeMs !== event.timeMs) throw new Error(`计分事件 ${row.scoreIndex} 的谱面时间不匹配`);
    if (performance.version !== TIMING_PERFORMANCE_VERSION && (!Number.isInteger(row.judgement) || row.judgement < 1 || row.judgement > 6)) throw new Error(`计分事件 ${row.scoreIndex} 的判定须为 1 至 6`);
    if (!Number.isSafeInteger(row.inputFrame) || row.inputFrame < 0 || row.inputFrame >= 100000) throw new Error(`计分事件 ${row.scoreIndex} 的输入帧无效`);
    if (performance.version === TIMING_PERFORMANCE_VERSION && (!Number.isSafeInteger(row.timingOffsetMs) || Math.abs(row.timingOffsetMs) > 3000 || typeof row.missed !== 'boolean')) throw new Error('原始操作需要有效偏差与漏击标记');
    if (performance.version === TIMING_PERFORMANCE_VERSION && clock.indexAt(event.timeMs + row.timingOffsetMs) !== row.inputFrame) throw new Error('原始操作的输入帧与偏差不一致');
    clock.at(row.inputFrame);
    return { ...event, ...(performance.version === TIMING_PERFORMANCE_VERSION ? { timingOffsetMs: row.timingOffsetMs, missed: row.missed } : { originalJudgement: row.judgement }), inputFrame: row.inputFrame, inputSequence: sequence };
  });
  // The array order is authoritative for simultaneous input. It is not sorted
  // by note identity and cannot be recovered from per-judgement percentages.
  judgements.sort((a, b) => a.inputFrame - b.inputFrame || a.inputSequence - b.inputSequence);
  return { clock, frameRate, skillOrder: [...order], judgements };
}

export function validatePerformance(rules, chart, performance) {
  const timeline = prepareFormalChart(rules, chartWithRelease(rules, chart));
  const value = validateAgainstTimeline(timeline, performance);
  return { valid: true, chartId: timeline.chartId, chartHash: timeline.chartHash, eventCount: value.judgements.length,
    frameRate: value.frameRate, clock: value.clock.kind, skillOrder: value.skillOrder };
}

/** Explicit ordinary-live scenario. Judgements are inputs, not inferred timing
 * windows. This reuses the score bucket engine and independently reconstructs
 * life/combos and the currently audited skill vocabulary. It is not a captured
 * Unity input stream and intentionally does not synthesize Gekisou or assist. */
export function createPerformanceSongCalculator(rules, chart, { performance, frameRate = 60, eventAdapters = [] } = {}) {
  const timeline = prepareFormalChart(rules, chartWithRelease(rules, chart));
  const input = validateAgainstTimeline(timeline, performance, frameRate);
  const { clock, skillOrder, judgements } = input;
  const formation = createFormationCalculator(rules, { eventAdapters });
  const resolve = createFormalSkillResolver(rules, { dynamic: true });
  const setting = key => Number(rules.tables.LiveSettings.find(row => row._key === key)?._value);
  const judgementRows = new Map(rules.tables.LiveJudgementParameter.map(row => [row._noteSimulateJudgement, row]));
  const maximumLife = setting('life_base');
  const musicLengthMs = Math.max(...timeline.events.map(event => event.timeMs), ...timeline.skillTimes);

  function run(draft, { includeTrace = false, withoutSkills = false, skillOrder = input.skillOrder } = {}) {
    if (draft.slots?.length !== 5 || draft.slots.some(slot => !slot.memberCardId || !slot.supportCardId)) throw new Error('请选择五张成员卡和五张留影');
    if (draft.selectedSongId !== timeline.trackId || draft.selectedDifficulty !== timeline.difficulty) throw new Error('歌曲或难度与载入谱面不一致');
    const power = formation.calculate(draft), skills = resolve(draft);
    const eventPipeline = createEventPipeline(rules, draft.modifiers?.event, eventAdapters);
    const common = { totalPower: power.total.total, scoreAdjustmentFactor: setting('note_score_adjustment_factor'),
      musicScoreLevelFactor: timeline.difficultyFactor, luckScoreFactorPercent: 100, convertedNoteCount: timeline.convertedNoteCount,
      eventBonusFactor: 1, lifeOnusFactor: setting('note_score_life_onus_factor'), assistModeNoteScoreFactor: 1 };
    const combo = createComboReplay(rules.tables.LiveComboScoreBonus), life = createLifeReplay(maximumLife, musicLengthMs);
    const noteValue = (event, comboFactor, scoreUpFactor) => calculateFormalNoteCore(eventPipeline.apply('note_score', {
      ...common, noteFactorPercent: event.weight, judgementFactorPercent: judgementRows.get(event.judgement)._scorePercent,
      comboBonusFactor: comboFactor, scoreUpFactor, currentLife: event.lifeAtInput }, { draft, note: event })).score;
    const replay = createScoreReplay({ musicLengthMs, scoreNote(event, factors) {
      const comboAtScore = combo.at(event.timeMs);
      const scoreUpFactor = f32(factors.general + (factors[judgementField[event.judgement]] ?? 0));
      return { ...comboAtScore, scoreUpFactor, score: noteValue(event, comboAtScore.comboFactor, scoreUpFactor),
        baseScore: noteValue(event, comboAtScore.comboFactor, 1) };
    } });
    const arrivals = new Map(), stateTrace = [], factorCommands = [];
    const addFactor = command => { replay.addFactor(command); if (includeTrace) factorCommands.push(command); };
    for (const event of judgements) { if (!arrivals.has(event.inputFrame)) arrivals.set(event.inputFrame, []); arrivals.get(event.inputFrame).push(event); }
    const lifecycle = createOrdinarySkillLifecycle({ skills, skillTimes: timeline.skillTimes, skillOrder, clock, life, skillEndFrame, onFactor: addFactor, withoutSkills });
    const { converters, skillTrace } = lifecycle;
    let lastFrame = Math.max(...arrivals.keys(), lifecycle.lastFrame), convertedCount = 0, lowestLife = maximumLife, totalDamage = 0;
    const counts = Object.fromEntries([1,2,3,4,5,6].map(j => [j, 0]));
    const conversionCounts = new Map();
    for (let frame = 0; frame <= lastFrame; frame++) {
      const nowMs = clock.at(frame).timeMs;
      let changed = false;
      for (const inputNote of arrivals.get(frame) ?? []) {
        const originalJudgement = resolveTimingJudgement(rules, inputNote);
        const { judgement, convertedBy } = lifecycle.convert(originalJudgement);
        if (convertedBy) conversionCounts.set(convertedBy.effectId, (conversionCounts.get(convertedBy.effectId) ?? 0) + 1);
        if (convertedBy) convertedCount++;
        counts[judgement]++;
        combo.add(inputNote.timeMs, judgement);
        const damage = judgementRows.get(judgement)?._damage;
        if (!Number.isInteger(damage) || damage < 0) throw new Error(`缺少判定 ${judgement} 的生命参数`);
        if (damage) { life.add({ timeMs: inputNote.timeMs, kind: 0, value: damage }); totalDamage += damage; }
        // LiveExecutor.UpdateCurrentFrameParameters captures life immediately
        // after this note's damage; later bucket replay must not re-query it.
        const lifeAtInput = life.at(inputNote.timeMs);
        lowestLife = Math.min(lowestLife, lifeAtInput);
        replay.addNote({ ...inputNote, originalJudgement, judgement, convertedBy, lifeAtInput });
        changed = true;
      }
      replay.calculate(nowMs);
      changed = lifecycle.advance(frame) || changed;
      lastFrame = Math.max(lastFrame, lifecycle.lastFrame);
      const currentLife = life.at(nowMs);
      lowestLife = Math.min(lowestLife, currentLife);
      replay.calculate(nowMs);
      if (includeTrace && changed) stateTrace.push({ frame, timeMs: nowMs, life: currentLife, combo: combo.state.combo,
        maxCombo: combo.state.maxCombo, score: replay.score, converters: converters.filter(c => c.active)
          .map(c => ({ slotIndex: c.slot, effectId: c.effect.id, remaining: c.remaining })) });
    }
    const finalMs = Math.max(musicLengthMs, clock.at(lastFrame + 1).timeMs);
    replay.calculate(finalMs);
    const noteTotal = replay.score, score = eventPipeline.apply('fixed_score', noteTotal, { draft, order: skillOrder });
    if (!Number.isSafeInteger(score) || score < 0) throw new Error('Invalid event fixed score result');
    const baseScore = replay.notes.reduce((sum, note) => sum + note.result.baseScore, 0);
    let cumulativeScore = 0;
    const notes = includeTrace ? replay.notes.slice().sort((a, b) => a.scoreIndex - b.scoreIndex).map(({ result, sequence, ...note }) => ({ ...note, ...result,
      cumulativeScore: cumulativeScore += result.score })) : undefined;
    const { combo: finalCombo, maxCombo, allPerfect, fullCombo } = combo.state;
    const finalState = { combo: finalCombo, maxCombo, allPerfect, fullCombo, life: life.at(finalMs), lowestLife, totalDamage, recoveryAmount: lifecycle.recoveryAmount,
      judgementCounts: counts, convertedCount, conversions: [...conversionCounts].map(([effectId, count]) => ({ effectId, count })) };
    return { status: 'estimated', modelVersion: SCORE_MODEL_VERSION, scorePrecision: 'explicit_performance',
      verificationStatus: timeline.verificationStatus, scenario: performance.version === TIMING_PERFORMANCE_VERSION ? 'ordinary_raw_timing_no_assist' : 'ordinary_explicit_judgements_no_assist',
      timingModel: { frameRate: input.frameRate, clock: clock.kind, scoreBucketMs: 40 },
      sourceReleaseId: rules.sourceReleaseId, ruleSetVersion: rules.ruleSetVersion, event: eventPipeline.context,
      inputHash: stableSnapshotHash({ draft, chartHash: timeline.chartHash, performance, skillOrder, modelVersion: SCORE_MODEL_VERSION }),
      power: power.total.total, baseScore, expectedScore: score, minimumScore: score, maximumScore: score,
      skillScoreGain: noteTotal - baseScore, eventFixedScoreGain: score - noteTotal, orderCount: 1,
      scoreDistribution: summarizeScoreDistribution([score], { complete: false }), bestOrder: skillOrder, worstOrder: skillOrder, skills,
      chart: { id: timeline.chartId, level: timeline.level, difficultyFactor: timeline.difficultyFactor, convertedNoteCount: timeline.convertedNoteCount,
        eventCount: timeline.events.length, masterFullCombo: timeline.masterFullCombo, skillTimes: timeline.skillTimes, chartHash: timeline.chartHash },
      performance: { version: PERFORMANCE_VERSION, eventCount: judgements.length, skillOrder, ...finalState },
      warnings: [performance.version === TIMING_PERFORMANCE_VERSION ? '按原始偏差与规则表窗口计算判定；未重建触屏命中、长条按压和客户端输入调度。' : '结果仅对应导入的明确判定、输入帧和技能顺序；明确判定不用于推算扩窗收益。',
        '生命、连击、转换次数与技能条件按客户端代码回放；不包含激奏、辅助模式或其他未支持技能。',
        ...timeline.warnings.filter(warning => warning.includes('不一致'))],
      ...(includeTrace ? { bestOrderNotes: notes, bestOrderFixedScore: score - noteTotal, stateTrace, skillTrace,
        skillPlayback: { skills, skillTimes: timeline.skillTimes, frameRate: input.frameRate,
          variants: [{ kind: 'explicit', order: skillOrder, score, notes, commands: factorCommands, skillTrace }] } } : {}) };
  }
  function calculate(draft, options = {}) {
    const order = options.skillOrder ?? input.skillOrder;
    if (!Array.isArray(order) || order.length !== 5 || new Set(order).size !== 5 || order.some(i => !Number.isInteger(i) || i < 0 || i > 4)) throw new Error('技能顺序必须是 0 至 4 的完整排列');
    const baseline = run(draft, { withoutSkills: true, skillOrder: order });
    const result = run(draft, { includeTrace: Boolean(options.includeTrace), skillOrder: order });
    // A second explicit scenario removes score, conversion and recovery
    // effects together; the gain includes their resulting combo/life changes.
    result.baseScore = baseline.expectedScore - baseline.eventFixedScoreGain;
    result.skillScoreGain = result.expectedScore - result.eventFixedScoreGain - result.baseScore;
    return result;
  }
  return { calculate, timeline };
}
