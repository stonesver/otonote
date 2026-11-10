// Lexicographic integer domain used by the existing section comparator.
const base = 2147483648n;
const lastKey = base ** 3n - 1n;
const keyOf = s => (BigInt(s.luckPoints) * base + BigInt(s.noteScore)) * base + BigInt(s.perfectCount);

function distribution(samples, section) {
  return samples.map(sample => {
    const value = sample.sections[section];
    return { key: keyOf(value), bonuses: value.bonuses };
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** Exact expected reward difference on two empirical distributions.
 * Opponent tuples are fixed across lottery outcomes. Dense ranking counts
 * DISTINCT better tuples, not players. A gap can hold only as many distinct
 * integer tuples as its width; this includes exact ties at the upper endpoint.
 * Both extrema are computed together, giving both comparison directions.
 */
export function luckSectionEnvelope(a, b, opponents, maximumKey = lastKey) {
  const keys = [], stride = opponents + 1;
  const differences = new Float64Array((a.length + b.length) * stride);
  const left = new Float64Array(stride), right = new Float64Array(stride);
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    const key = j >= b.length || (i < a.length && a[i].key <= b[j].key) ? a[i].key : b[j].key;
    left.fill(0); right.fill(0);
    while (i < a.length && a[i].key === key) {
      for (let r = 0; r <= opponents; r++) left[r] += a[i].bonuses[r];
      i++;
    }
    while (j < b.length && b[j].key === key) {
      for (let r = 0; r <= opponents; r++) right[r] += b[j].bonuses[r];
      j++;
    }
    // Sum integer rewards before dividing, so repeated copies of the same
    // distribution cancel even when the teams have different sample counts.
    const offset = keys.length * stride;
    for (let r = 0; r <= opponents; r++) differences[offset + r] = right[r] / b.length - left[r] / a.length;
    keys.push(key);
  }
  let maximum = new Float64Array(stride).fill(-Infinity), nextMax = new Float64Array(stride);
  let minimum = new Float64Array(stride).fill(Infinity), nextMin = new Float64Array(stride);
  maximum[0] = minimum[0] = 0;
  for (let p = keys.length - 1; p >= 0; p--) {
    const capacity = Math.min(opponents, Number((keys[p + 1] ?? maximumKey) - keys[p]));
    nextMax.fill(-Infinity); nextMin.fill(Infinity);
    const offset = p * stride;
    if (capacity === opponents) {
      // An unrestricted gap admits every used <= rank. Its transitions are
      // prefix extrema; adding the same finite reward preserves their order.
      let hi = -Infinity, lo = Infinity;
      for (let rank = 0; rank <= opponents; rank++) {
        hi = Math.max(hi, maximum[rank]); lo = Math.min(lo, minimum[rank]);
        nextMax[rank] = hi + differences[offset + rank];
        nextMin[rank] = lo + differences[offset + rank];
      }
    } else for (let used = 0; used <= opponents; used++) for (let add = 0; add <= Math.min(capacity, opponents - used); add++) {
        const rank = used + add;
        nextMax[rank] = Math.max(nextMax[rank], maximum[used] + differences[offset + rank]);
        nextMin[rank] = Math.min(nextMin[rank], minimum[used] + differences[offset + rank]);
    }
    [maximum, nextMax] = [nextMax, maximum]; [minimum, nextMin] = [nextMin, minimum];
  }
  // Unused players may tie existing opponents or the all-zero tuple.
  return { maximum: Math.max(...maximum), minimum: Math.min(...minimum) };
}

/** The search appends complete-song blocks to stable archive rows. Keep one
 * ranker per input and seed domain; only pairs touching appended rows expire. */
export function createLuckCandidateRanker(songs) {
  const cache = { prepared: new WeakMap(), pairs: new WeakMap() };
  return candidates => rankCandidates(candidates, songs, cache);
}

export function rankLuckCandidates(candidates, songs) {
  return rankCandidates(candidates, songs);
}

function rankCandidates(candidates, songs, cache = null) {
  if (!candidates.length) throw Error('没有完整可计算的候选队伍');
  const totalWeight = songs.reduce((sum, song) => sum + song.weight, 0);
  const versions = candidates.map(candidate => candidate.songs[0].samples.length);
  const prepared = candidates.map((candidate, i) => {
    const saved = cache?.prepared.get(candidate);
    if (saved?.version === versions[i]) return saved.rows;
    const rows = candidate.songs.map(row => ({
      noteScore: row.samples.reduce((sum, s) => sum + s.noteScore, 0) / row.samples.length,
      sections: [0, 1, 2].map(j => distribution(row.samples, j))
    }));
    cache?.prepared.set(candidate, { version: versions[i], rows });
    return rows;
  });
  const result = candidates.map((candidate, i) => {
    const aggregate = fn => candidate.songs.reduce((sum, row, s) => sum + songs[s].weight / totalWeight *
      row.samples.reduce((n, sample) => n + fn(sample), 0) / row.samples.length, 0);
    return { ...candidate, worstLoss: 0, alternativeId: candidate.id,
      noteScore: prepared[i].reduce((sum, row, s) => sum + row.noteScore * songs[s].weight / totalWeight, 0),
      sameRankScore: aggregate(s => s.noteScore + s.sections.reduce((sum, x) => sum + x.bonuses.at(-1), 0)),
      firstRankScore: aggregate(s => s.noteScore + s.sections.reduce((sum, x) => sum + x.bonuses[0], 0)) };
  });
  for (let a = 0; a < candidates.length; a++) for (let b = a + 1; b < candidates.length; b++) {
    let pairs = cache?.pairs.get(candidates[a]);
    if (cache && !pairs) { pairs = new WeakMap(); cache.pairs.set(candidates[a], pairs); }
    const saved = pairs?.get(candidates[b]);
    let ab, ba;
    if (saved?.a === versions[a] && saved?.b === versions[b]) ({ ab, ba } = saved);
    else {
      ab = 0; ba = 0;
      for (let s = 0; s < songs.length; s++) {
        const left = prepared[a][s], right = prepared[b][s];
        let forward = right.noteScore - left.noteScore, backward = -forward;
        for (let j = 0; j < 3; j++) {
          const count = left.sections[j][0].bonuses.length - 1;
          const envelope = luckSectionEnvelope(left.sections[j], right.sections[j], count);
          forward += envelope.maximum; backward -= envelope.minimum;
        }
        ab += forward * songs[s].weight / totalWeight; ba += backward * songs[s].weight / totalWeight;
      }
      pairs?.set(candidates[b], { a: versions[a], b: versions[b], ab, ba });
    }
    if (ab > result[a].worstLoss) { result[a].worstLoss = ab; result[a].alternativeId = result[b].id; }
    if (ba > result[b].worstLoss) { result[b].worstLoss = ba; result[b].alternativeId = result[a].id; }
  }
  return result.sort((a, b) => a.worstLoss - b.worstLoss || b.sameRankScore - a.sameRankScore || a.id.localeCompare(b.id));
}
