import { prepareFormalChart } from './scoring-rules/formal-song-score.mjs';
import { calculateFormalNoteCore } from './scoring-rules/formal-note-core.mjs';
import { compareScoreFactors, liveSkillCommands, replayScoreTimeline } from './scoring-rules/formal-score-replay.mjs';
import { skillOrdersFor } from './scoring-rules/skill-order-sampling.mjs';
import { summarizeScoreDistribution } from './scoring-rules/score-distribution.mjs';
import { SCORE_MODEL_VERSION } from './scoring-rules/model-version.mjs';
import { scoringRulesAvailable } from './scoring-release-gate.mjs';
import { validateSongSkillProfile, songSkillProfileKey } from './song-skill-profile.mjs';

/** A neutral, ordinary-live comparison using the same note core and replay as
 * the team calculator. "Replay" describes precision, not real-play certainty.
 * No formation, conditional skill, event or Gekisou bonus is inferred. */
export function calculateSongSkillReplay({ rules, chart, skills, power = 100000, frameRate = 60, includeTrace = false }) {
  validateSongSkillProfile(skills);
  if (!Number.isSafeInteger(power) || power < 1 || power > 10000000) throw new Error('无效的比较综合力');
  if (!scoringRulesAvailable(rules, chart.sourceReleaseId)) throw new Error('计分规则与谱面版本不一致');
  const profileKey = songSkillProfileKey(skills, frameRate);
  const timeline = prepareFormalChart(rules, chart);
  const setting = key => Number(rules.tables.LiveSettings.find(row => row._key === key)?._value);
  const common = { totalPower: power, scoreAdjustmentFactor: setting('note_score_adjustment_factor'),
    musicScoreLevelFactor: timeline.difficultyFactor,
    judgementFactorPercent: rules.tables.LiveJudgementParameter.find(row => row._noteSimulateJudgement === 5)._scorePercent,
    luckScoreFactorPercent: 100, convertedNoteCount: timeline.convertedNoteCount, eventBonusFactor: 1,
    lifeOnusFactor: setting('note_score_life_onus_factor'), assistModeNoteScoreFactor: 1, currentLife: setting('life_base') };
  const params = event => ({ ...common, noteFactorPercent: event.weight, comboBonusFactor: event.comboFactor });
  const noteScores = timeline.events.map(event => new Map([[1, calculateFormalNoteCore({ ...params(event), scoreUpFactor: 1 }).score]]));
  const baseScore = noteScores.reduce((sum, cache) => sum + cache.get(1), 0);
  const resolved = skills.map(skill => {
    const durationRawMs = Math.fround(Math.fround(skill.seconds) * 1000);
    return { liveEffects: [{ type: 2000, active: skill.percent > 0 && skill.seconds > 0,
      rate: Math.fround(skill.percent / 100), durationRawMs, durationMs: Math.ceil(durationRawMs) }] };
  });
  const scores = [], cache = new Map();
  let bestOrder, worstOrder, minimum = Infinity, maximum = -Infinity;
  for (const order of skillOrdersFor('full')) {
    const commands = liveSkillCommands(order, resolved, timeline.skillTimes, frameRate);
    // Equivalent commands keep their probability but need only one replay.
    const key = JSON.stringify(commands.slice().sort(compareScoreFactors).map(({ ownerId, ...command }) => command));
    let score = cache.get(key);
    if (score === undefined) {
      score = replayScoreTimeline({ events: timeline.events, commands, frameRate,
        scoreNote(event, state) {
          const factor = Math.fround(state.general + state.perfect), values = noteScores[event.scoreIndex];
          if (!values.has(factor)) values.set(factor, calculateFormalNoteCore({ ...params(event), scoreUpFactor: factor }).score);
          return { score: values.get(factor), scoreUpFactor: factor };
        } }).score;
      cache.set(key, score);
    }
    scores.push(score);
    if (score > maximum) { maximum = score; bestOrder = [...order]; }
    if (score < minimum) { minimum = score; worstOrder = [...order]; }
  }
  const traceOrder = (order, kind) => {
    const commands = liveSkillCommands(order, resolved, timeline.skillTimes, frameRate);
    const replay = replayScoreTimeline({ events: timeline.events, commands, frameRate,
      scoreNote(event, state) { const factor = Math.fround(state.general + state.perfect);
        return { score: calculateFormalNoteCore({ ...params(event), scoreUpFactor: factor }).score, scoreUpFactor: factor }; } });
    return { kind, order, score: replay.score, commands, notes: replay.notes.map(({ result, ...note }) => ({ ...note, ...result })) };
  };
  return { ...(includeTrace ? { skillPlayback: { skills: resolved.map((s,i)=>({...s,slotIndex:i})), skillTimes: timeline.skillTimes, frameRate,
    variants: [traceOrder(bestOrder, 'best'), traceOrder(worstOrder, 'worst')] } } : {}), mode: 'ordinary' , precision: 'replay', profileKey, skills: skills.map(skill => ({ ...skill })),
    power, baseScore, distribution: summarizeScoreDistribution(scores), bestOrder, worstOrder,
    modelVersion: SCORE_MODEL_VERSION, chartHash: timeline.chartHash, chartId: chart.id,
    trackId: chart.trackId, difficulty: chart.difficulty, sourceReleaseId: rules.sourceReleaseId,
    frameRate, startsSeconds: timeline.skillTimes.map(time => time / 1000),
    verificationStatus: timeline.verificationStatus, warnings: timeline.warnings };
}
