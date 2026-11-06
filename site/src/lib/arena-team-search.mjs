import { applyArenaContext } from '../../../packages/scoring/scoring-rules/arena-context.mjs';
import { arenaRankingSample, rankArenaCandidates } from '../../../packages/scoring/scoring-rules/arena-comparison.mjs';
import { createGekisouSongCalculator } from './scoring-rules/gekisou-song-score.mjs';
import { createPerformanceScenario, normalizePerformanceScenario } from '../../../packages/scoring/scoring-rules/performance-scenarios.mjs';
import { createFormationCalculator } from './scoring-rules/formation-power.mjs';
import { resolveSearchInput } from './scoring-rules/formation-input.mjs';
import { maximumPairing } from './scoring-rules/maximum-pairing.mjs';
import { compilePairingModels, draftFromPairing } from './inventory-optimizer.mjs';
import { createTeamDraft } from './team-draft.mjs';
import { stableSnapshotHash } from './scoring-engine.mjs';
import { UnsupportedSkillMechanismError } from '../../../packages/scoring/scoring-rules/skill-mechanism-error.mjs';

/** Power seeds under different JUST requirements preserve count, conversion,
 * window and score cards. They generate candidates; power never ranks the
 * final results. This bounded search has no global optimality certificate. */
export async function generateJustCandidates(rules, profile, context, songs, { onProgress, yieldControl = async () => {} } = {}) {
  const base = createTeamDraft({ selectedSongId: songs[0].trackId, selectedDifficulty: songs[0].difficulty,
    modifiers: { ...structuredClone(profile.account), growth: structuredClone(profile.inventory.growth) } });
  const inventory = { ...profile.inventory, sourceReleaseId: rules.sourceReleaseId };
  const input = resolveSearchInput(rules, base, { scope: 'owned', inventory, constraints: { bandId: context.bandId } });
  const power = createFormationCalculator(rules), t = rules.tables;
  const justMembers = new Set(t.GekisouSkill.filter(s => s._gekisouMissionType === 3).map(s => s._id));
  const justSupports = new Set(t.GekisouSupportSkill.filter(s => s._gekisouMissionType === 3).map(s => s._id));
  const members = input.inventory.memberCardIds.filter(id => justMembers.has(power.card(id, 'member')._gekisouSkillID));
  const supports = input.inventory.supportCardIds.filter(id => {
    const card = power.card(id, 'support');
    return [card._gekisouSupportSkillId01, card._gekisouSupportSkillId02].some(id => justSupports.has(id));
  });
  const withEffect = type => supports.filter(id => {
    const card = power.card(id, 'support'), skills = [card._gekisouSupportSkillId01, card._gekisouSupportSkillId02];
    return t.GekisouSupportSkillEffect.some(e => skills.includes(e._gekisouSupportSkillID) && e._skillEffectType === type);
  });
  const tasks = [ { name: '综合力起点', members: [], supports: [] },
    ...members.map(id => ({ name: 'JUST 成员组合', members: [id], supports: [] })),
    ...supports.map(id => ({ name: 'JUST 留影组合', members: [], supports: [id] })),
    ...withEffect(13005).flatMap(a => withEffect(4004).filter(b => b !== a).map(b => ({ name: '转换与扩窗组合', members: [], supports: [a, b] }))) ];
  const focusedCharacters = new Set(members.map(id => power.card(id, 'member')._characterID));
  const focused = new Set(input.inventory.memberCardIds.filter(id => members.includes(id) || !focusedCharacters.has(power.card(id, 'member')._characterID)));
  const candidates = new Map();
  const seedSongs = [...new Map(songs.map(song => {
    const music = t.LiveMusic.find(m => `music-${m._id}` === song.trackId);
    return [JSON.stringify([music._musicType, music._bestMusicTagIDs]), song];
  })).values()];
  let completed = 0;
  for (const song of seedSongs) {
    const current = { ...input, draft: { ...input.draft, selectedSongId: song.trackId, selectedDifficulty: song.difficulty } };
    const models = await compilePairingModels(rules, current, { yieldControl });
    for (const focus of [false, true]) for (const task of tasks) {
      let best;
      for (const model of models) {
        const edges = focus ? model.edges.filter(edge => focused.has(edge.member)) : model.edges;
        const match = maximumPairing({ edges, requiredMembers: [...new Set([model.leader, ...task.members])], requiredSupports: task.supports });
        if (!match) continue;
        const draft = draftFromPairing(current, model.leader, match.edges);
        const value = power.calculate(draft).total.total;
        if (!best || value > best.value) best = { draft, value };
        // Keep every eligible leader for both unrestricted and JUST-focused
        // starting lineups; choosing a captain is not a power-only decision.
        if (!task.members.length && !task.supports.length) {
          const id = stableSnapshotHash(draft.slots);
          if (!candidates.has(id)) candidates.set(id, { id, name: focus ? '计数侧重 · 队长比较' : '综合力起点 · 队长比较', draft });
        }
      }
      if (best) {
        const id = stableSnapshotHash(best.draft.slots);
        if (!candidates.has(id)) candidates.set(id, { id, name: focus ? `计数侧重 · ${task.name}` : task.name, draft: best.draft });
      }
      onProgress?.({ phase: 'generate', completed: ++completed, total: seedSongs.length * tasks.length * 2, candidates: candidates.size });
      await yieldControl();
    }
  }
  return [...candidates.values()];
}

export async function evaluateArenaCandidates({ rules, context, songs, performance, candidates }, { onProgress, yieldControl = async () => {} } = {}) {
  const calculators = songs.map(song => {
    return Array.from({ length: performance.samples }, (_, sample) => createGekisouSongCalculator(rules, song.chart, {
      performance: createPerformanceScenario(rules, song.chart, performance, sample), performanceOrder: 'sampled',
      scenario: { ranks: Array(3).fill(context.participantCount), frameRate: performance.frameRate }, scorePrecision: 'full'
    }));
  });
  const evaluated = [], omitted = [];
  for (const [index, candidate] of candidates.entries()) {
    const rows = [];
    try {
      for (const [s, song] of songs.entries()) {
        const samples = []; let power;
        for (const calculator of calculators[s]) {
          const result = calculator.calculateRankingSamples({ ...candidate.draft, selectedSongId: song.trackId, selectedDifficulty: song.difficulty });
          if (result.randomSampling) throw Error('本版 JUST 比较暂不支持带随机效果的候选');
          power = result.power;
          samples.push(...result.rankingSamples.map(sample => arenaRankingSample(rules, sample, context.missions, context.participantCount)));
          await yieldControl();
        }
        rows.push({ power, samples });
        onProgress?.({ phase: 'evaluate', completed: index * songs.length + s + 1, total: candidates.length * songs.length, candidates: candidates.length });
      }
      evaluated.push({ ...candidate, songs: rows });
    } catch (error) {
      if (!(error instanceof UnsupportedSkillMechanismError)) throw error;
      omitted.push({ id: candidate.id, reason: error.message, ...error.detail });
    }
  }
  return { evaluated, omitted };
}

export async function searchArenaTeams({ rules: sourceRules, profile, stage, songs, performanceScenario }, { onProgress, yieldControl = async () => {}, evaluateCandidates = evaluateArenaCandidates } = {}) {
  const { context, rules } = applyArenaContext(sourceRules, stage);
  if (context.missions.some(m => m !== 3)) throw Error('第一版支持三段 JUST；COMBO、LUCK 与混段尚未开放');
  if (!songs?.length || songs.length > 12) throw Error('请选择 1–12 首歌曲作为评估范围');
  if (songs.some(s => !Number.isFinite(s.weight) || s.weight <= 0)) throw Error('曲目权重须为正数');
  const keys = songs.map(s => s.trackId);
  if (new Set(keys).size !== keys.length) throw Error('每首歌曲只选一档难度，请合并歌曲权重');
  const performance = normalizePerformanceScenario(performanceScenario);
  for (const song of songs) {
    if (!song.chart || song.chart.sourceReleaseId !== rules.sourceReleaseId || song.chart.trackId !== song.trackId || song.chart.difficulty !== song.difficulty) throw Error('谱面与内容版本不一致，请重新加载');
  }
  const candidates = await generateJustCandidates(rules, profile, context, songs, { onProgress, yieldControl });
  const { evaluated, omitted } = await evaluateCandidates({ rules, context, songs, performance, candidates }, { onProgress, yieldControl });
  const summaries = songs.map(({ chart, ...song }) => ({ ...song, chartHash: stableSnapshotHash(chart) }));
  const ranked = rankArenaCandidates(evaluated, summaries);
  return { version: 2, sourceReleaseId: rules.sourceReleaseId, stage: context, songs: summaries, performance,
    poolMode: 'one_difficulty_per_song', weightMeaning: 'evaluation_importance',
    inputHash: stableSnapshotHash({ rules: stableSnapshotHash(sourceRules), profile, stage: context, songs: summaries, performance, searchVersion: 2 }),
    method: 'pairwise_rank_envelope', generated: candidates.length, omitted, candidates: ranked,
    orderCount: 120, opponentModel: 'independent_rank_envelope', optimality: 'candidate_set_only' };
}
