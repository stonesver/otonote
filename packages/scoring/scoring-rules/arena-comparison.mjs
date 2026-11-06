import { compareGekisouSection } from './gekisou-ranking.mjs';
import { gekisouRankingBonus } from './gekisou-rules.mjs';

export function arenaRankingSample(rules, sample, missions, participantCount) {
  return { noteScore: sample.noteScore, sections: sample.sections.map(section => ({ ...section,
    bonuses: Array.from({ length: participantCount }, (_, i) => gekisouRankingBonus(rules, {
      missions, sectionIndex: section.index, rank: i + 1, sectionScore: section.noteScore
    }).additionalScore)
  })) };
}

/** Pairwise envelope over shared opponents. Higher task/score/perfect tuples
 * cannot rank below weaker tuples; identical tuples must share rank. We allow
 * all other rank pairs, including unproven opponent realizations. This is an
 * upper bound on regret, not a distribution or an exact feasible-match model. */
export function sectionRegret(candidate, alternative) {
  const comparison = compareGekisouSection(candidate, alternative, candidate.missionType);
  let loss = -Infinity, ranks;
  for (let a = 0; a < candidate.bonuses.length; a++) for (let b = 0; b < alternative.bonuses.length; b++) {
    if (comparison === 0 ? a !== b : comparison < 0 ? a > b : a < b) continue;
    const next = alternative.bonuses[b] - candidate.bonuses[a];
    if (next > loss) { loss = next; ranks = [a + 1, b + 1]; }
  }
  return { loss, ranks };
}

/** Each candidate has rows in the same song/sample/order sequence. Opponents
 * can vary across those rows. Maximize over ONE alternative after aggregating
 * the entire pool, never splice per-song winners into an unattainable team. */
export function rankArenaCandidates(candidates, songs) {
  if (!candidates.length) throw Error('没有完整可计算的候选队伍');
  const totalWeight = songs.reduce((sum, song) => sum + song.weight, 0);
  const aggregate = (candidate, fn) => candidate.songs.reduce((sum, row, s) =>
    sum + songs[s].weight / totalWeight * row.samples.reduce((n, sample) => n + fn(sample), 0) / row.samples.length, 0);
  const result = candidates.map(candidate => {
    let worstLoss = 0, alternativeId = candidate.id, witness = [];
    for (const alternative of candidates) {
      if (alternative.id === candidate.id) continue;
      let loss = 0;
      const differences = candidate.songs.map((row, s) => {
        let subtotal = 0, worstSample = null;
        for (let i = 0; i < row.samples.length; i++) {
          const a = row.samples[i], b = alternative.songs[s].samples[i];
          const sections = a.sections.map((section, j) => sectionRegret(section, b.sections[j]));
          const delta = b.noteScore - a.noteScore + sections.reduce((n, section) => n + section.loss, 0);
          subtotal += delta;
          if (!worstSample || delta > worstSample.delta) worstSample = { sampleIndex: i, delta, ranks: sections.map(section => section.ranks) };
        }
        const meanLoss = subtotal / row.samples.length;
        loss += meanLoss * songs[s].weight / totalWeight;
        return { songIndex: s, meanLoss, worstSample };
      });
      if (loss > worstLoss) { worstLoss = loss; alternativeId = alternative.id; witness = differences; }
    }
    return { ...candidate, worstLoss, alternativeId, witness,
      sameRankScore: aggregate(candidate, sample => sample.noteScore + sample.sections.reduce((sum, section) => sum + section.bonuses.at(-1), 0)),
      firstRankScore: aggregate(candidate, sample => sample.noteScore + sample.sections.reduce((sum, section) => sum + section.bonuses[0], 0)),
      noteScore: aggregate(candidate, sample => sample.noteScore)
    };
  });
  return result.sort((a, b) => a.worstLoss - b.worstLoss || b.sameRankScore - a.sameRankScore || a.id.localeCompare(b.id));
}
