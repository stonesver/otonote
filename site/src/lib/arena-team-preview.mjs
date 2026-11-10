import { rankGekisouSection } from './scoring-rules/gekisou-ranking.mjs';

export function arenaCandidateScore(candidate, preview) {
  if (preview.mode === 'unknown') return null;
  if (preview.mode === 'opponents') return arenaSongPreview(candidate.songs[preview.songIndex], {
    opponents: preview.opponents.get(preview.songIndex)
  }).score;
  return preview.mode === 'first' ? candidate.firstRankScore : candidate.sameRankScore;
}

/** Presentation order is independent of the search's recommendation order. */
export function arenaCandidateOrder(candidates, preview, sort = preview.mode === 'unknown' ? 'recommendation' : 'score') {
  const rows = candidates.map((candidate, index) => ({ candidate, index, score: arenaCandidateScore(candidate, preview) }));
  const value = row => preview.mode === 'unknown' ? row.candidate.firstRankScore : row.score;
  return sort === 'score' ? rows.sort((a, b) => value(b) - value(a) || a.index - b.index) : rows;
}

/** Match characters, not positions: moving the captain must not look like replacing cards. */
export function arenaCandidateChanges(draft, reference, cards) {
  const character = slot => cards.get(slot.memberCardId).characterId;
  const previous = new Map(reference.slots.map(slot => [character(slot), slot]));
  const supports = new Set(reference.slots.map(slot => slot.supportCardId));
  const slots = draft.slots.map(slot => {
    const before = previous.get(character(slot));
    return {
      before,
      memberChanged: slot.memberCardId !== before.memberCardId,
      supportChanged: !supports.has(slot.supportCardId),
      supportMoved: supports.has(slot.supportCardId) && slot.supportCardId !== before.supportCardId
    };
  });
  return {
    slots,
    members: slots.filter(slot => slot.memberChanged).length,
    supports: slots.filter(slot => slot.supportChanged).length,
    pairings: slots.filter(slot => slot.supportMoved).length,
    leaderChanged: draft.slots[2].memberCardId !== reference.slots[2].memberCardId
  };
}

/** Rank every replay before averaging scores; show the range when ranks vary. */
export function arenaSongPreview(song, { rank, opponents }) {
  const samples = song.samples.map(sample => {
    const ranks = sample.sections.map((section, j) => rank ?? rankGekisouSection(section, opponents[j], section.missionType));
    return { ranks, score: sample.noteScore + sample.sections.reduce((sum, section, j) => sum + section.bonuses[ranks[j] - 1], 0) };
  });
  return {
    score: samples.reduce((sum, sample) => sum + sample.score, 0) / samples.length,
    sections: song.samples[0].sections.map((section, j) => ({
      just: song.samples.reduce((sum, sample) => sum + sample.sections[j].just, 0) / samples.length,
      ...(section.missionType === 2 ? (() => {
        const points = song.samples.map(sample => sample.sections[j].luckPoints).sort((a, b) => a - b);
        return { luckPoints: points.reduce((sum, n) => sum + n, 0) / points.length,
          p10: points[Math.ceil(points.length * 0.1) - 1], p90: points[Math.ceil(points.length * 0.9) - 1] };
      })() : {}),
      minRank: Math.min(...samples.map(sample => sample.ranks[j])),
      maxRank: Math.max(...samples.map(sample => sample.ranks[j]))
    }))
  };
}
