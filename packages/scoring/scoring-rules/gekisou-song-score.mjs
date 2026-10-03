import { createFrameClock } from './formal-frame-clock.mjs';
import { liveSkillCommands, replayScoreTimeline, compareScoreFactors } from './formal-score-replay.mjs';
import { summarizeScoreDistribution, SCORE_DISTRIBUTION_VERSION } from './score-distribution.mjs';
import { SCORE_MODEL_VERSION } from './model-version.mjs';
import { skillOrdersFor } from './skill-order-sampling.mjs';
import { createFormationCalculator, requireInteger } from './formation-power.mjs';
import { prepareFormalChart } from './formal-song-score.mjs';
import { createFormalSkillResolver } from './formal-skills.mjs';
import { calculateFormalNoteCore } from './formal-note-core.mjs';
import { gekisouTimingCombo, gekisouScoreSection } from './gekisou-timing.mjs';
import { normalizeGekisouOpponents, rankGekisouSection } from './gekisou-ranking.mjs';
import { resolveGekisouSkills, gekisouRankingBonus, gekisouComboFactor } from './gekisou-rules.mjs';
import { replayGekisouFrames } from './gekisou-frame-replay.mjs';
import { gekisouSettlementActions } from './gekisou-score-settlement.mjs';
import { createEventPipeline } from './event-rules.mjs';
import { validateAgainstTimeline } from './formal-performance-replay.mjs';
import { createComboReplay } from './formal-performance-state.mjs';
import { createPerformanceScenario } from './performance-scenarios.mjs';
import { stableSnapshotHash } from '../scoring-engine.mjs';

const f32 = Math.fround;
const supportedEffects = new Set([13000, 12000, 11001, 13002, 11002, 11003, 2001, 2000, 4004, 12006, 11005, 13005, 12004]);
const supportedConditions = new Set([2001, 5000, 4011, 7005, 7000, 7010, 7013, 7020, 7021, 1030]);

export function normalizeGekisouScenario(input = {}) {
  const ranks = input.ranks ?? [1, 1, 1];
  if (!Array.isArray(ranks) || ranks.length !== 3) throw new Error('请指定三个激奏段的名次');
  ranks.forEach(r => requireInteger(r, 'section rank', 1, 5));
  const timingOffsetMs = input.timingOffsetMs ?? 0;
  requireInteger(timingOffsetMs, 'AP timing offset ms', -50, 50);
  const batches = requireInteger(input.batches ?? 1, 'simulation batches', 1, 32);
  const seed = requireInteger(input.seed ?? 20260927, 'simulation seed', 0, 0xffffffff);
  const frameRate = input.frameRate ?? 60;
  const clock = createFrameClock({ frameRate, frames: input.frames });
  const confirmationDelayFrames = input.confirmationDelayFrames ?? [0, 0, 0];
  if (!Array.isArray(confirmationDelayFrames) || confirmationDelayFrames.length !== 3) throw new Error('请指定三个段落的确认延迟');
  confirmationDelayFrames.forEach(value => requireInteger(value, 'confirmation delay frames', 0, 3600));
  const opponents = normalizeGekisouOpponents(input.opponents);
  return { ranks: [...ranks], timingOffsetMs, batches, seed, frameRate, opponents, confirmationDelayFrames: [...confirmationDelayFrames], ...(clock.frames ? { frames: clock.frames } : {}),
    replayVersion: 5, settlementModel: confirmationDelayFrames.some(Boolean) ? 'multiplayer_explicit_confirmation_delay' : 'multiplayer_first_eligible_frame',
    judgement: 'all_perfect_or_just', life: 'full', assist: false,
    timingModel: clock.frames ? 'explicit_clock_native_phase_order' : 'ideal_clock_native_phase_order', rankingModel: opponents.length ? 'opponent_section_results' : 'fixed_section_ranks' };
}

function compileEffects(rules, draft, dynamic = false) {
  const power = createFormationCalculator(rules);
  return resolveGekisouSkills(rules, draft).flatMap(skill => skill.effects.map(effect => {
    const row = effect.definition;
    if (!supportedEffects.has(row._skillEffectType)) throw new Error(`Unsupported Gekisou effect ${row._skillEffectType}`);
    for (const sets of Object.values(effect.conditions)) for (const set of sets) for (const c of set.conditions) {
      if (!supportedConditions.has(c._conditionType)) throw new Error(`Unsupported Gekisou condition ${c._conditionType}`);
    }
    if (effect.cumulative && ![1000, 7001].includes(effect.cumulative._skillCumulativeConditionType)) {
      throw new Error(`Unsupported Gekisou cumulative condition ${effect.cumulative._id}`);
    }
    const member = power.card(draft.slots[skill.slotIndex].memberCardId, 'member');
    const band = rules.tables.Character.find(c => c._id === member._characterID)._bandID;
    const conditions = effect.conditions._skillConditionGroup;
    // Band/life alternatives are exclusive. Probability is drawn on activation,
    // never on every note of an otherwise sustained effect.
    const matchesStatic = c => {
      let match;
      if (c._conditionType === 2001) return dynamic ? true : ((1000 >= c._conditionValues[0]) === Boolean(c._isPositive));
      else if (c._conditionType === 5000) match = c._conditionTargetIDs.some(id => {
        const t = rules.tables.SkillTarget.find(t => t._id === id);
        if (t?._skillTargetType !== 3 || !t._bandID) throw new Error('Unsupported skill band target');
        return t._bandID === band;
      });
      else return true;
      return c._isPositive ? match : !match;
    };
    const staticallyActive = !conditions.length || conditions.some(s => s.conditions.every(matchesStatic));
    const trigger = effect.conditions._skillTriggerConditionGroup.flatMap(s => s.conditions);
    const triggerLife = trigger.filter(c => c._conditionType === 2001).every(matchesStatic);
    const probability = conditions.flatMap(s => s.conditions).find(c => c._conditionType === 4011)?._conditionValues[0] ?? 100;
    return { ...effect, key: `${skill.kind}:${skill.slotIndex}:${row._id}`, missionType: skill.missionType,
      kind: skill.kind, slotIndex: skill.slotIndex, sourceCardId: skill.sourceCardId,
      active: staticallyActive && triggerLife, probability, trigger,
      targets: row._skillTargetIDs.map(id => rules.tables.SkillTarget.find(t => t._id === id)).filter(t => t?._skillTargetType === 4).map(t => t._judgement),
      ...(dynamic ? { eligible: life => {
        const match = c => c._conditionType === 2001 ? ((life >= c._conditionValues[0]) === Boolean(c._isPositive)) : matchesStatic(c);
        return (!conditions.length || conditions.some(set => set.conditions.every(match))) && trigger.filter(c => c._conditionType === 2001).every(match);
      } } : {}),
      comboThreshold: trigger.find(c => c._conditionType === 7005)?._conditionValues[0] ?? 0,
      perfectInterval: trigger.find(c => c._conditionType === 1030)?._conditionValues[0] ?? 0 };
  }));
}

/** Conditional AP score calculator. Replays skill/Gekisou phases on an explicit
 * ideal clock, then resolves timestamped score commands. Device input order,
 * random stream and opponent outcomes remain separate scenario assumptions. */
export function createGekisouSongCalculator(rules, chart, { scenario: inputScenario, eventAdapters = [], referenceProfile = null, scorePrecision = 'full', performance = null, performanceScenario = null, performanceOrder = 'fixed' } = {}) {
  let orders = skillOrdersFor(scorePrecision);
  // A neutral chart benchmark: identical live skills, no card-specific power
  // or Gekisou effects. Normal team calculations do not enter this branch.
  if (referenceProfile) {
    referenceProfile = { ...referenceProfile };
    requireInteger(referenceProfile.power, 'reference power', 1, 10000000);
    requireInteger(referenceProfile.skillPercent, 'reference skill percent', 0, 1000);
    requireInteger(referenceProfile.skillSeconds, 'reference skill seconds', 0, 60);
    if (eventAdapters.length) throw new Error('Reference profile cannot use event adapters');
  }
  const scenario = normalizeGekisouScenario(inputScenario);
  const timeline = prepareFormalChart(rules, performance || performanceScenario ? { ...chart, sourceReleaseId: chart.sourceReleaseId ?? rules.sourceReleaseId } : chart);
  if (performance && performanceScenario) throw new Error('请选择明确操作或发挥情景其中一种');
  performance ??= performanceScenario ? createPerformanceScenario(rules, chart, performanceScenario) : null;
  if (referenceProfile && performance) throw new Error('参考综合力基准不接受玩家操作');
  const performanceInput = performance ? validateAgainstTimeline(timeline, performance, scenario.frameRate) : null;
  if (performanceInput) {
    scenario.frameRate = performanceInput.frameRate;
    if (inputScenario?.frames && !performanceInput.clock.frames) throw new Error('逐帧时钟须放入玩家操作文件，不能与另一套输入帧混用');
    if (performanceInput.clock.frames) scenario.frames = performanceInput.clock.frames;
    else delete scenario.frames;
    scenario.judgement = performance.version; scenario.life = 'replayed'; scenario.playerInput = 'explicit_operations';
    if (!['fixed', 'sampled'].includes(performanceOrder)) throw new Error('未知技能顺序情景');
    if (performanceOrder === 'fixed' && !performanceScenario) orders = [performanceInput.skillOrder];
  }
  const music = rules.tables.LiveMusic.find(r => `music-${r._id}` === timeline.trackId);
  const missions = [1, 2, 3].map(i => music[`_gekisouMission${i}`]);
  const rawRanges = timeline.gekisouRanges;
  if (!rawRanges || rawRanges.length !== 3 || missions.some(m => ![1, 2, 3].includes(m))) throw new Error('谱面缺少三个有效激奏段');
  const ranges = rawRanges.map((r, i) => ({ index: i + 1, missionType: missions[i], ...r }));
  if (ranges.some((r, i) => !Number.isSafeInteger(r.startMs) || !Number.isSafeInteger(r.endMs) || r.startMs < 0 || r.endMs <= r.startMs || (i && r.startMs < ranges[i - 1].endMs))) throw new Error('Invalid Gekisou ranges');
  const setting = key => Number(rules.tables.LiveSettings.find(r => r._key === key)?._value);
  const powerCalculator = createFormationCalculator(rules, { eventAdapters });
  const perfectSkills = createFormalSkillResolver(rules), justSkills = createFormalSkillResolver(rules, { judgement: 6 });
  const dynamicSkills = performanceInput ? createFormalSkillResolver(rules, { dynamic: true }) : null;
  const judgementPercent = new Map(rules.tables.LiveJudgementParameter.map(r => [r._noteSimulateJudgement, r._scorePercent]));
  const warnings = [...timeline.warnings,
    '激奏按判定、技能、激奏更新的顺序逐帧重放；输入帧与同刻判定顺序为显式理想条件，分数与推荐是条件模拟。',
    `LUCK 积压抽奖按${scenario.frames ? '输入的逐帧时钟' : ` ${scenario.frameRate} FPS 的空帧`}处理；这是显式模拟条件，不代表客户端实际帧时序。`,
    ...(scenario.opponents.length ? ['名次按输入的对手段落数据，比较任务累计、段落得分、Perfect 数；对手数据是假设，不代表未知实战对手。'] : [
      '名次是输入情景，不由 AP 或综合力推断；实际对手可能改变名次。',
      '固定名次时，增加 JUST／COMBO 排名计数的抢榜收益不会自动转成额外奖励；可填写对手段落数据或修改名次比较。']),
    '判定偏差移动输入帧；音符计分与区段归属沿用谱面时刻，技能倍率按各自的生效时间戳回放。',
    scenario.confirmationDelayFrames.some(Boolean)
      ? `段落奖励使用上传前取得的区间分数，结果确认额外等待 ${scenario.confirmationDelayFrames.join(' / ')} 帧；延迟是输入条件，不是网络预测。`
      : '段落奖励使用上传前取得的区间分数；假设指定名次或对手结果在首个可确认帧到齐。',
    performanceInput ? (performance.version.includes('timing') ? '按相同原始偏差比较各队；判定窗口与转换技能分别生效。' : '按明确判定回放；没有原始偏差，无法据此衡量扩窗收益。') : scenario.timingOffsetMs === 0 ? 'AP＋零毫秒偏差：可判 JUST 的音符按 JUST；这比一般 AP 更理想。' : `AP＋固定 ${scenario.timingOffsetMs} 毫秒偏差；JUST 扩大和转换技能参与判定。`,
    'LUCK 按正式概率抽样，固定种子可复算；样本最低/最高分不是理论极值。至少两批才能估计抽样标准误。'];

  function calculate(draft, { includeTrace = false } = {}) {
    if (draft.selectedSongId !== timeline.trackId || draft.selectedDifficulty !== timeline.difficulty) throw new Error('歌曲或难度与谱面不一致');
    if (referenceProfile && draft.modifiers?.event?.id != null) throw new Error('Reference profile cannot use an event');
    const referenceSkills = referenceProfile && Array.from({ length: 5 }, () => ({ liveEffects: [{ type: 2000,
      active: referenceProfile.skillSeconds > 0, rate: referenceProfile.skillPercent / 100, durationMs: referenceProfile.skillSeconds * 1000 }] }));
    const formation = referenceProfile ? { total: { total: referenceProfile.power } } : powerCalculator.calculate(draft);
    const perfect = referenceSkills || perfectSkills(draft), just = referenceSkills || justSkills(draft);
    const effects = referenceProfile ? [] : compileEffects(rules, draft, Boolean(performanceInput));
    const ordinarySkills = dynamicSkills?.(draft);
    const randomSampling = missions.includes(2) || effects.some(e => e.active && missions.includes(e.missionType) && e.probability < 100);
    // Ordinary skill order changes score commands, not the Gekisou frame
    // machine. Reuse deterministic history across all 120 order sweeps.
    const deterministicReplay = randomSampling || performanceInput ? null : replayGekisouFrames(rules, timeline, ranges, effects, scenario, scenario.seed);
    const pipeline = createEventPipeline(rules, draft.modifiers?.event, eventAdapters);
    const common = { totalPower: formation.total.total, scoreAdjustmentFactor: setting('note_score_adjustment_factor'),
      musicScoreLevelFactor: timeline.difficultyFactor, convertedNoteCount: timeline.convertedNoteCount,
      eventBonusFactor: 1, lifeOnusFactor: setting('note_score_life_onus_factor'), assistModeNoteScoreFactor: 1, currentLife: 1000 };
    const orderCache = new Map(), referenceCache = new Map();
    const ownerSensitive = effects.some(e => e.active && [2000, 2001].includes(e.definition._skillEffectType));
    function run(order, seed, trace = false) {
      const replay = !trace && deterministicReplay || replayGekisouFrames(rules, timeline, ranges, effects, scenario, seed, { trace, performanceInput, ordinarySkills, skillOrder: order });
      const states = replay.states.map(s => ({ ...s, noteScore: 0, finalNoteScore: 0 }));
      const comboViews = states.map(() => ({ history: [], length: 0 }));
      const ordinaryCommands = replay.ordinaryCommands ?? liveSkillCommands(order, perfect, timeline.skillTimes, scenario.frameRate, just, replay.clock);
      const commandKey = JSON.stringify(ordinaryCommands.slice().sort(compareScoreFactors).map(({ ownerId, ...c }) => c));
      const cacheKey = !performanceInput && !randomSampling && !trace && !eventAdapters.length && pipeline.context.id == null
        ? (ownerSensitive ? JSON.stringify(ordinaryCommands) : commandKey) : null;
      if (cacheKey !== null && orderCache.has(cacheKey)) return orderCache.get(cacheKey);
      const commands = [...ordinaryCommands, ...replay.commands.map(({ perfect, just, ...command }) => ({ ...command,
        ...(command.type === 'luck' ? { luck: command.value } : command.type === 2000 ? { general: command.value }
          : { perfect: perfect ? command.value : 0, just: just ? command.value : 0 }) }))];
      const frameActions = replay.comboUpdates.map(update => ({ frame: update.frame,
        run() { comboViews[update.sectionIndex - 1] = update; } }));
      frameActions.push(...gekisouSettlementActions(states, s => {
        if (scenario.opponents.length) s.rank = rankGekisouSection({combo:s.maxCombo,luckPoints:s.luck.state.bonusPoints,just:s.just,noteScore:s.noteScore,perfectCount:s.perfectCount}, scenario.opponents.map(o=>o.sections[s.index-1]), s.missionType);
        const bonus = gekisouRankingBonus(rules, { missions, sectionIndex: s.index, rank: s.rank, sectionScore: s.noteScore });
        s.rankingPercent = bonus.percent;
        return bonus.additionalScore;
      }, { confirmationDelayFrames: scenario.confirmationDelayFrames }));
      const ordinaryCombo = performanceInput ? createComboReplay(rules.tables.LiveComboScoreBonus) : null;
      const scoreReplay = replayScoreTimeline({ events: replay.events, commands, frameActions, frameRate: scenario.frameRate, clock: replay.clock,
        beforeInputs: notes => { for (const note of notes) ordinaryCombo?.add(note.timeMs, note.judgement); },
        scoreNote(event, factor) {
          const s = states[event.sectionIndex - 1], judgement = event.judgement;
          const view = comboViews[event.sectionIndex - 1];
          const combo = s?.missionType === 1 ? gekisouTimingCombo(view.history, event.timeMs, view.length) : 0;
          const ordinaryComboFactor = ordinaryCombo?.at(event.timeMs).comboFactor ?? event.comboFactor;
          const comboFactor = s?.missionType === 1 ? f32(ordinaryComboFactor * gekisouComboFactor(rules, combo)) : ordinaryComboFactor;
          const scoreUpFactor = f32(factor.general + (factor[{3:'good',4:'great',5:'perfect',6:'just'}[judgement]] ?? 0));
          const luckPercent = 100 + factor.luck;
          const params = { ...common, currentLife: event.lifeAtInput ?? common.currentLife, noteFactorPercent: event.weight, judgementFactorPercent: judgementPercent.get(judgement),
            comboBonusFactor: comboFactor, scoreUpFactor, luckScoreFactorPercent: Math.min(200, luckPercent) };
          const score = calculateFormalNoteCore(pipeline.apply('note_score', params, { draft, note: event, sectionIndex: s?.index })).score;
          return { score, scoreUpFactor, comboFactor, luckPercent, combo };
        } });
      let referenceSections = !performanceInput && referenceCache.get(commandKey);
      if (!referenceSections) {
        const referenceStates = states.map(s => ({ ...s }));
        const referenceCombo = performanceInput ? createComboReplay(rules.tables.LiveComboScoreBonus) : null;
        replayScoreTimeline({ events: replay.events, commands: ordinaryCommands, frameRate: scenario.frameRate, clock: replay.clock,
          frameActions: gekisouSettlementActions(referenceStates),
          beforeInputs: notes => { for (const note of notes) referenceCombo?.add(note.timeMs, note.judgement); },
          scoreNote: (event, factor) => calculateFormalNoteCore({ ...common, noteFactorPercent: event.weight,
            judgementFactorPercent: performanceInput ? judgementPercent.get(event.judgement) : 100, currentLife: event.lifeAtInput ?? 1000, comboBonusFactor: referenceCombo?.at(event.timeMs).comboFactor ?? event.comboFactor,
            scoreUpFactor: f32(factor.general + (performanceInput ? (factor[{3:'good',4:'great',5:'perfect',6:'just'}[event.judgement]] ?? 0) : factor.perfect)), luckScoreFactorPercent: 100 }) });
        referenceSections = referenceStates.map(s => s.noteScore);
        if (!performanceInput) referenceCache.set(commandKey, referenceSections);
      }
      let total = scoreReplay.score, outsideScore = 0;
      const notes = trace ? [] : undefined;
      for (const event of scoreReplay.notes.sort((a, b) => a.scoreIndex - b.scoreIndex)) {
        const s = states[event.sectionIndex - 1], scoreSection = states[gekisouScoreSection(ranges, event.timeMs)];
        if (scoreSection) {
          scoreSection.finalNoteScore += event.result.score;
        } else outsideScore += event.result.score;
        if (trace) {
          const { result, sequence, ...note } = event;
          notes.push({ ...note, sectionIndex: s?.index ?? null, scoreSectionIndex: scoreSection?.index ?? null, ...result });
        }
      }
      const sections = states.map(s => {
        return { index: s.index, missionType: s.missionType, rank: s.rank, noteScore: s.noteScore,
          ordinaryReferenceScore: referenceSections[s.index - 1], rankingBonus: s.rankingBonus, totalScore: s.noteScore + s.rankingBonus,
          rankingPercent: s.rankingPercent, combo: s.maxCombo, currentCombo: s.combo, maxCombo: s.maxCombo, just: s.just, rawJust: s.rawJust, perfectCount: s.perfectCount,
          ...(trace ? { scoreQuery: s.scoreQuery, confirmationFrame: s.confirmationFrame, finalNoteScore: s.finalNoteScore, replayAdjustment: s.finalNoteScore - s.noteScore } : {}),
          luckPoints: s.luck.state.bonusPoints, luckCounts: [...s.luck.state.counts] };
      });
      const rankingBonus = sections.reduce((sum, s) => sum + s.rankingBonus, 0);
      const noteScore = total - rankingBonus;
      const score = pipeline.apply('fixed_score', total, { draft, order, sections });
      if (!Number.isSafeInteger(score) || score < 0) throw new Error('Invalid Gekisou score');
      const result = { score, performance: replay.performance, noteScore, rankingBonus, outsideScore, sections, eventFixedScore: score - total, ...(trace ? { notes, luckEvents: replay.luckEvents, skillTransitions: replay.transitions, stateTrace: replay.stateTrace, ordinarySkillTrace: replay.ordinarySkillTrace, factorCommands: commands, commands: ordinaryCommands } : {}) };
      if (cacheKey !== null) orderCache.set(cacheKey, result);
      return result;
    }
    const batches = randomSampling ? scenario.batches : 1;
    const samples = [], sectionSums = ranges.map(() => ({ noteScore: 0, rankingBonus: 0, totalScore: 0, ordinaryReferenceScore: 0, combo: 0, currentCombo: 0, maxCombo: 0, just: 0, rawJust: 0, luckPoints: 0, perfectCount: 0, rank: 0 }));
    const rankCounts = ranges.map(()=>[0,0,0,0,0]);
    let sum = 0, bonusSum = 0, minimum = Infinity, maximum = -Infinity, best, worst;
    for (let batch = 0; batch < batches; batch++) for (const [index, order] of orders.entries()) {
      const seed = (scenario.seed + Math.imul(batch * orders.length + index + 1, 2654435761)) >>> 0;
      const result = run(order, seed);
      sum += result.score; bonusSum += result.rankingBonus; samples.push(result.score);
      result.sections.forEach((section, i) => { rankCounts[i][section.rank-1]++; for (const key of Object.keys(sectionSums[i])) sectionSums[i][key] += section[key]; });
      if (result.score < minimum) { minimum = result.score; worst = { order, seed }; }
      if (result.score > maximum) { maximum = result.score; best = { order, seed }; }
    }
    const expectedScore = sum / samples.length;
    // Each skill order is a separate stratum, exhaustively enumerated. Only
    // variation ACROSS batches of the SAME order estimates LUCK variance.
    // A single observation per stratum cannot estimate its variance.
    let standardError = randomSampling ? null : 0;
    if (randomSampling && batches > 1) {
      let varianceSum = 0;
      for (let i = 0; i < orders.length; i++) {
        const values = Array.from({ length: batches }, (_, b) => samples[b * orders.length + i]);
        const mean = values.reduce((s, v) => s + v, 0) / batches;
        varianceSum += values.reduce((s, v) => s + (v - mean) ** 2, 0) / (batches - 1);
      }
      standardError = Math.sqrt(varianceSum / (batches * orders.length ** 2));
    }
    const bestTrace = includeTrace ? run(best.order, best.seed, true) : null;
    const worstTrace = includeTrace ? run(worst.order, worst.seed, true) : null;
    return { status: 'estimated', modelVersion: SCORE_MODEL_VERSION, scorePrecision, verificationStatus: 'source_informed_frame_replay', optimizerEligible: !referenceProfile,
      score: expectedScore, expectedScore, minimumScore: minimum, maximumScore: maximum, power: formation.total.total,
      scenario, referenceKind: performanceInput ? 'same_effective_judgements_without_gekisou_score_factors' : 'ordinary_ap_reference', event: pipeline.context, sourceReleaseId: rules.sourceReleaseId, ruleSetVersion: rules.ruleSetVersion,
      inputHash: stableSnapshotHash({ draft, performance, performanceOrder, chartHash: timeline.chartHash, scenario, distributionVersion: SCORE_DISTRIBUTION_VERSION, ...(scorePrecision === 'screen' ? { scorePrecision } : {}), ...(referenceProfile ? { referenceProfile } : {}) }),
      sampleCount: samples.length, orderCount: orders.length, randomSampling, standardError,
      scoreDistribution: summarizeScoreDistribution(samples, { kind: randomSampling ? 'seed_samples' : 'skill_orders', complete: !randomSampling && scorePrecision === 'full' }),
      rankingBonus: bonusSum / samples.length, rankingBonusShare: sum ? bonusSum / sum : 0,
      sections: ranges.map((r, i) => ({ ...r, ...Object.fromEntries(Object.entries(sectionSums[i]).map(([k, v]) => [k, v / samples.length])), rankProbabilities:rankCounts[i].map(n=>n/samples.length), share: sum ? sectionSums[i].totalScore / sum : 0 })),
      effects: effects.map(e => ({ sourceCardId: e.sourceCardId, slotIndex: e.slotIndex, type: e.definition._skillEffectType, active: e.active, missionType: e.missionType,
        contribution: !performanceInput && [12004, 12006].includes(e.definition._skillEffectType) ? 'no_score_change_under_ap' : 'simulated' })),
      bestOrder: best.order, worstOrder: worst.order, warnings, skills: perfect,
      chart: { id: timeline.chartId, level: timeline.level, eventCount: timeline.events.length, chartHash: timeline.chartHash,
        difficultyFactor: timeline.difficultyFactor, convertedNoteCount: timeline.convertedNoteCount, masterFullCombo: timeline.masterFullCombo, skillTimes: timeline.skillTimes },
      ...(includeTrace ? { bestSample: bestTrace, bestSampleSeed: best.seed,
        skillPlayback: { skills: perfect, justSkills: just, skillTimes: timeline.skillTimes, frameRate: scenario.frameRate,
          randomSampling, ranges: ranges.map(({index,missionType,startMs,endMs})=>({index,missionType,startMs,endMs})),
          luckPointsByResult: [...rules.native.luckPointsByResult],
          effects: effects.map(e => ({ source: e.key, sourceCardId: e.sourceCardId, slotIndex: e.slotIndex,
            kind: e.kind, missionType: e.missionType, type: e.definition._skillEffectType, active: e.active,
            probability: e.probability, effectValue: e.definition._effectValue,
            comboThreshold: e.comboThreshold, perfectInterval: e.perfectInterval })),
          variants: [{ kind: 'best', order: [...best.order], seed: best.seed, ...bestTrace },
            { kind: 'worst', order: [...worst.order], seed: worst.seed, ...worstTrace }] } } : {}) };
  }

  // Safe, deliberately loose envelope for the ideal model: released score-up
  // effects at their caps, every note JUST, maximum combo/luck/rank multipliers.
  function upperBound(power, ordinaryFactor) {
    if (eventAdapters.length) throw new Error('Event optimizer requires an audited upper bound');
    const supportBound = rules.tables.GekisouSupportSkillEffect.reduce((max, e) => Math.max(max, e._maxEffectValue, e._effectValue), 0) / 10000;
    const maxJudgement = Math.max(...judgementPercent.values());
    const maxRank = Math.max(...rules.tables.LiveGekisouRankingScoreBonus.map(r => r._scoreBonusPercent));
    return Math.ceil(timeline.events.reduce((sum, e) => sum + calculateFormalNoteCore({ totalPower: power,
      scoreAdjustmentFactor: setting('note_score_adjustment_factor'), musicScoreLevelFactor: timeline.difficultyFactor,
      noteFactorPercent: e.weight, judgementFactorPercent: maxJudgement, comboBonusFactor: f32(e.comboFactor * 2),
      scoreUpFactor: f32(ordinaryFactor + 10 * supportBound + 1), luckScoreFactorPercent: 200,
      convertedNoteCount: timeline.convertedNoteCount, eventBonusFactor: 1, lifeOnusFactor: 1, assistModeNoteScoreFactor: 1, currentLife: 1000 }).score, 0) * (1 + maxRank / 100));
  }
  return { calculate, timeline: { ...timeline, warnings }, scenario, upperBound };
}
