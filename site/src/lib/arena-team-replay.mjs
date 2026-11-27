import { applyArenaContext } from '../../../packages/scoring/scoring-rules/arena-context.mjs';
import { requireInteger } from '../../../packages/scoring/scoring-rules/formation-power.mjs';
import { createGekisouSongCalculator, gekisouOrderSeed } from './scoring-rules/gekisou-song-score.mjs';
import { createPerformanceScenario, normalizePerformanceScenario } from '../../../packages/scoring/scoring-rules/performance-scenarios.mjs';
import { skillOrdersFor } from '../../../packages/scoring/scoring-rules/skill-order-sampling.mjs';
import { luckSamplePlan } from './arena-luck-evaluator.mjs';

// In LUCK the index identifies a discovery draw before worker packing groups it
// by player. In JUST each player stratum contains all 120 orders.
function replayInput(rules, chart, performance, luck, songIndex, sampleIndex) {
  requireInteger(sampleIndex, 'sample index', 0, luck ? 0x7fffffff : performance.samples * 120 - 1);
  const player = luck ? sampleIndex % performance.samples : Math.floor(sampleIndex / 120);
  const operations = createPerformanceScenario(rules, chart, performance, player);
  let seed;
  if (luck) {
    const [draw] = luckSamplePlan({ seed: performance.seed, songIndex, playerCount: performance.samples,
      player, start: sampleIndex, end: sampleIndex + 1, phase: 0 });
    seed = draw.seed;
    if (performance.profile !== 'explicit') operations.skillOrder = draw.order;
  } else {
    const orderIndex = sampleIndex % 120;
    operations.skillOrder = skillOrdersFor('full')[orderIndex];
    seed = gekisouOrderSeed(orderIndex);
  }
  return { player, operations, seed };
}

// Accept the same section-major opponent rows used by the arena preview.
function rankingScenario(participants, ranks, opponents) {
  if (opponents != null) {
    if (ranks != null || opponents.length !== 3 || opponents.some(rows => rows.length !== participants - 1)) {
      throw Error('请按舞台人数填写三段对手，或单独指定三段名次');
    }
    return { opponents: opponents[0].map((_, i) => ({
      sections: opponents.map(rows => ({ combo: 0, just: 0, luckPoints: 0, ...rows[i] }))
    })) };
  }
  if (!ranks || ranks.some(rank => rank > participants)) throw Error('请指定当前对局人数内的三个段落名次');
  return { ranks };
}

export function calculateArenaTeamReplay({ rules: sourceRules, stage, song, songIndex, performanceScenario,
  draft, ranks, opponents, sampleIndex = 0 }) {
  const { chart } = song;
  if (chart.sourceReleaseId !== sourceRules.sourceReleaseId || chart.trackId !== song.trackId || chart.difficulty !== song.difficulty) {
    throw Error('回放谱面与推荐歌曲或内容版本不一致');
  }
  requireInteger(songIndex, 'song index', 0);
  const { rules, context } = applyArenaContext(sourceRules, stage);
  const music = rules.tables.LiveMusic.find(m => 'music-' + m._id === song.trackId);
  const missions = [1, 2, 3].map(i => music?.['_gekisouMission' + i]);
  if (![2, 3].includes(missions[0]) || !missions.every(mission => mission === missions[0])) {
    throw Error('配队回放需要三段 JUST 或三段 LUCK');
  }
  const performance = normalizePerformanceScenario(performanceScenario);
  const { operations, player, seed } = replayInput(rules, chart, performance, missions[0] === 2, songIndex, sampleIndex);
  const scenario = rankingScenario(context.participantCount, ranks, opponents);
  const calculator = createGekisouSongCalculator(rules, chart, {
    performance: operations, scenario: { ...scenario, frameRate: performance.frameRate, seed }
  });
  const team = { ...draft, selectedSongId: song.trackId, selectedDifficulty: song.difficulty };
  const replay = calculator.replaySample(team, { seed, includeTrace: true });
  const contributions = [];
  for (const [slotIndex, slot] of team.slots.entries()) {
    for (const kind of ['member', 'support']) {
      const cardId = slot[kind + 'CardId'];
      const without = calculator.replaySample(team, { seed, mutedCardId: cardId });
      contributions.push({ cardId, kind, slotIndex, noteScoreDelta: replay.noteScore - without.noteScore,
        rankingBonusDelta: replay.rankingBonus - without.rankingBonus, scoreDelta: replay.score - without.score });
    }
  }
  return { sourceReleaseId: rules.sourceReleaseId, trackId: song.trackId, difficulty: song.difficulty,
    sample: { songIndex, sampleIndex, playerIndex: player, order: operations.skillOrder, seed },
    replay, contributions };
}
