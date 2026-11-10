import { applyArenaContext } from '../../../packages/scoring/scoring-rules/arena-context.mjs';
import { arenaRankingSample, rankArenaCandidates } from '../../../packages/scoring/scoring-rules/arena-comparison.mjs';
import { createGekisouSongCalculator } from './scoring-rules/gekisou-song-score.mjs';
import { createPerformanceScenario, normalizePerformanceScenario } from '../../../packages/scoring/scoring-rules/performance-scenarios.mjs';
import { createFormationCalculator } from './scoring-rules/formation-power.mjs';
import { resolveSearchInput } from './scoring-rules/formation-input.mjs';
import { compilePairingModels, draftFromPairing } from './inventory-optimizer.mjs';
import { createTeamDraft } from './team-draft.mjs';
import { stableSnapshotHash } from './scoring-engine.mjs';
import { UnsupportedSkillMechanismError } from '../../../packages/scoring/scoring-rules/skill-mechanism-error.mjs';
import { createArenaLuckSearch } from './arena-luck-search.mjs';
import { normalizeArenaSkillPreferences, createArenaSkillPolicy, matchArenaSkills, arenaPreferredCandidate } from './arena-skill-policy.mjs';

/** Power seeds under different JUST requirements preserve count, conversion,
 * window and score cards. They generate candidates; power never ranks the
 * final results. This bounded search has no global optimality certificate. */
export async function generateJustCandidates(rules, profile, context, songs, { onProgress, yieldControl = async () => {}, cardScope = 'owned', skillPreferences } = {}) {
  const settings = normalizeArenaSkillPreferences(skillPreferences);
  if (!['owned', 'reference'].includes(cardScope)) throw Error('未知的卡库范围');
  const base = createTeamDraft({ selectedSongId: songs[0].trackId, selectedDifficulty: songs[0].difficulty,
    modifiers: { ...structuredClone(profile?.account ?? {}), growth: structuredClone(profile?.inventory?.growth ?? {}) } });
  const input = resolveSearchInput(rules, base, { scope: cardScope, inventory: profile?.inventory,
    constraints: { bandId: context.bandId } });
  const policy = createArenaSkillPolicy(rules, input, settings);
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
    ...(settings.preference === 'none' ? [] : [{ name: '技能偏好起点', members: [], supports: [], preferred: true }]),
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
        const priority = task.preferred ? 5 * edges.reduce((max, edge) => Math.max(max, edge.weight), 0) + 1 : 0;
        const match = await matchArenaSkills({ edges, requiredMembers: [...new Set([model.leader, ...task.members])], requiredSupports: task.supports,
          weight: task.preferred ? edge => edge.weight + priority * (Number(policy.has(edge.member, settings.preference)) + Number(policy.has(edge.support, settings.preference))) : undefined }, policy, yieldControl);
        if (!match) continue;
        // Full-card searches carry growth for the entire catalog. A candidate
        // needs only its ten cards, including when cloned for each seed.
        const ids = match.edges.flatMap(edge => [edge.member, edge.support]);
        const modifiers = { ...current.draft.modifiers, growth: Object.fromEntries(ids.map(id => [id, current.draft.modifiers.growth[id]])) };
        if (modifiers.planningResult) modifiers.planningResult = { ...modifiers.planningResult,
          actualGrowth: Object.fromEntries(ids.map(id => [id, modifiers.planningResult.actualGrowth[id]])) };
        const draft = draftFromPairing({ ...current, draft: { ...current.draft, modifiers } }, model.leader, match.edges);
        const value = power.calculate(draft).total.total;
        const skillCounts = policy?.counts(match.edges);
        const preferenceCount = task.preferred ? skillCounts.member[settings.preference] + skillCounts.support[settings.preference] : 0;
        if (!best || preferenceCount > best.preferenceCount || preferenceCount === best.preferenceCount && value > best.value) best = { draft, value, skillCounts, preferenceCount };
        // Keep every eligible leader for both unrestricted and JUST-focused
        // starting lineups; choosing a captain is not a power-only decision.
        if (!task.members.length && !task.supports.length) {
          const id = stableSnapshotHash(draft.slots);
          if (!candidates.has(id)) candidates.set(id, { id, name: task.preferred ? '技能偏好 · 队长比较' : focus ? '计数侧重 · 队长比较' : '综合力起点 · 队长比较', draft, skillCounts });
        }
      }
      if (best) {
        const id = stableSnapshotHash(best.draft.slots);
        if (!candidates.has(id)) candidates.set(id, { id, name: focus ? `计数侧重 · ${task.name}` : task.name, draft: best.draft, skillCounts: best.skillCounts });
      }
      onProgress?.({ phase: 'generate', completed: ++completed, total: seedSongs.length * tasks.length * 2, candidates: candidates.size });
      await yieldControl();
    }
  }
  return [...candidates.values()];
}

export async function evaluateArenaCandidates({ rules, context, songs, performance, candidates }, { onProgress, yieldControl = async () => {} } = {}) {
  const evaluated = candidates.map(candidate => ({ ...candidate, songs: [] })), omitted = new Map();
  // Retain one song's replay setup per worker, independent of pool size.
  // Candidate/song/sample order in the returned matrix remains unchanged.
  for (const [s, song] of songs.entries()) {
    const calculators = Array.from({ length: performance.samples }, (_, sample) => createGekisouSongCalculator(rules, song.chart, {
      performance: createPerformanceScenario(rules, song.chart, performance, sample), performanceOrder: 'sampled',
      scenario: { ranks: Array(3).fill(context.participantCount), frameRate: performance.frameRate }, scorePrecision: 'full'
    }));
    for (const [index, candidate] of evaluated.entries()) {
      if (!omitted.has(candidate.id)) try {
        const samples = []; let power;
        for (const calculator of calculators) {
          const result = calculator.calculateRankingSamples({ ...candidate.draft, selectedSongId: song.trackId, selectedDifficulty: song.difficulty });
          if (result.randomSampling) throw Error('本版 JUST 比较暂不支持带随机效果的候选');
          power = result.power;
          samples.push(...result.rankingSamples.map(sample => arenaRankingSample(rules, sample, sample.sections.map(section => section.missionType), context.participantCount)));
          await yieldControl();
        }
        candidate.songs.push({ power, samples });
      } catch (error) {
        if (!(error instanceof UnsupportedSkillMechanismError)) throw error;
        candidate.songs = [];
        omitted.set(candidate.id, { id: candidate.id, reason: error.message, ...error.detail });
      }
      onProgress?.({ phase: 'evaluate', completed: s * candidates.length + index + 1, total: candidates.length * songs.length, candidates: candidates.length });
    }
  }
  return { evaluated: evaluated.filter(candidate => !omitted.has(candidate.id)),
    omitted: candidates.filter(candidate => omitted.has(candidate.id)).map(candidate => omitted.get(candidate.id)) };
}

export async function searchArenaTeams({ rules: sourceRules, profile, stage, songs, performanceScenario, cardScope = 'owned', skillPreferences }, { onProgress, onSnapshot, onLuckSession, luckOptions = {}, yieldControl = async () => {}, evaluateCandidates = evaluateArenaCandidates } = {}) {
  const { context, rules } = applyArenaContext(sourceRules, stage);
  if (!songs?.length) throw Error('请至少选择一首歌曲作为评估范围');
  if (songs.some(s => !Number.isFinite(s.weight) || s.weight <= 0)) throw Error('曲目权重须为正数');
  const keys = songs.map(s => s.trackId);
  if (new Set(keys).size !== keys.length) throw Error('每首歌曲只选一档难度，请合并歌曲权重');
  const performance = normalizePerformanceScenario(performanceScenario);
  let mission;
  for (const song of songs) {
    if (!song.chart || song.chart.sourceReleaseId !== rules.sourceReleaseId || song.chart.trackId !== song.trackId || song.chart.difficulty !== song.difficulty) throw Error('谱面与内容版本不一致，请重新加载');
    const music = rules.tables.LiveMusic.find(m => `music-${m._id}` === song.trackId);
    const current = music?._gekisouMission1;
    if (![2, 3].includes(current) || [1, 2, 3].some(i => music?.[`_gekisouMission${i}`] !== current) || (mission && mission !== current)) throw Error('所选场次含 COMBO 或混段，请选择三段 JUST 或三段 LUCK 场次');
    mission = current;
  }
  if (mission === 2) {
    const session = createArenaLuckSearch({ sourceRules, rules, profile, context, songs, performance, cardScope }, { ...luckOptions, onProgress, onSnapshot, yieldControl });
    onLuckSession?.(session);
    try { return await session.run(); } finally { if (!onLuckSession) session.close(); }
  }
  const settings = normalizeArenaSkillPreferences(skillPreferences);
  const candidates = await generateJustCandidates(rules, profile, context, songs, { onProgress, yieldControl, cardScope, skillPreferences: settings });
  if (!candidates.length) throw Error('当前卡库无法组成符合技能数量限制的队伍，请调整限制或切换卡库范围。');
  const { evaluated, omitted } = await evaluateCandidates({ rules, context, songs, performance, candidates }, { onProgress, yieldControl });
  if (!evaluated.length) throw Error('候选队伍的技能暂不能完整计算，未生成推荐。');
  const summaries = songs.map(({ chart, ...song }) => ({ ...song, chartHash: stableSnapshotHash(chart) }));
  const ranked = rankArenaCandidates(evaluated, summaries);
  return { version: 3, sourceReleaseId: rules.sourceReleaseId, stage: context, songs: summaries, performance,
    cardScope, skillPreferences: settings, preferredCandidateId: arenaPreferredCandidate(ranked, settings.preference),
    poolMode: 'one_difficulty_per_song', weightMeaning: 'evaluation_importance',
    inputHash: stableSnapshotHash({ rules: stableSnapshotHash(sourceRules), profile, cardScope, skillPreferences: settings, stage: context, songs: summaries, performance, searchVersion: 3 }),
    method: 'pairwise_rank_envelope', generated: candidates.length, omitted, candidates: ranked,
    orderCount: 120, opponentModel: 'independent_rank_envelope', optimality: 'candidate_set_only' };
}
