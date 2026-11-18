/** Cross the candidate batches with both independent opponent banks. This
 * diagnoses practical recommendation instability, not a confidence interval. */
export function assessLuckCrossValidation(discovery, validation, rankers, { playerCount, tolerance, winnerId }) {
  const split = Math.floor(validation[0].songs[0].samples.length / (2 * playerCount)) * playerCount;
  const batches = [discovery, validation, ...[false, true].map(second => validation.map(row => ({ ...row,
    songs: row.songs.map(song => ({ ...song, samples: second ? song.samples.slice(split) : song.samples.slice(0, split) }))
  })))];
  const matrix = rankers.map(rank => batches.map(rows => rank(rows)));
  const acceptable = rankings => rankings[0].filter(row => rankings.every(rows => {
    const other = rows.find(candidate => candidate.id === row.id);
    return other.worstLoss - rows[0].worstLoss <= tolerance;
  })).map(row => row.id);
  const all = matrix.flat(), close = acceptable(all);
  const candidateUncertain = matrix.some(rows => !acceptable(rows).length);
  const opponentUncertain = batches.some((_, i) => !acceptable(matrix.map(rows => rows[i])).length);
  const status = close.length > 1 && close.includes(winnerId) ? 'close'
    : all.every(rows => rows[0].id === winnerId) ? 'stable' : 'unresolved';
  // Pairwise agreement need not give a common acceptable team across every
  // cell. If neither axis alone explains disagreement, extend both axes.
  const interaction = status === 'unresolved' && !candidateUncertain && !opponentUncertain;
  return { status, tolerance,
    candidateIds: status === 'close' ? close : [...new Set(all.map(rows => rows[0].id))],
    candidateStatus: candidateUncertain || interaction ? 'uncertain' : 'agrees',
    opponentStatus: opponentUncertain || interaction ? 'uncertain' : 'agrees',
    needs: { candidate: status === 'unresolved' && (candidateUncertain || interaction), opponent: status === 'unresolved' && (opponentUncertain || interaction) },
    cells: matrix.flatMap((rows, opponentBank) => rows.map((ranked, candidateBatch) => ({ opponentBank, candidateBatch,
      winnerId: ranked[0].id, recommendationGap: ranked.find(row => row.id === winnerId).worstLoss - ranked[0].worstLoss })))
  };
}
