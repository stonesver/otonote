import { createScoringRandom } from './gekisou-luck.mjs';

const base = 2147483648n;
const keyOf = section => (BigInt(section.luckPoints) * base + BigInt(section.noteScore)) * base + BigInt(section.perfectCount);

/** A room has whole, independently sampled opponents. At an exact tie only
 * DISTINCT better tuples count, matching the game's dense ranking. Sweep all
 * room boundaries once; candidate replays then need only a binary lookup. */
export function prepareLuckReferenceSection(rooms, participants) {
  const counts = new Float64Array(participants), changes = new Map();
  for (const room of rooms) {
    const keys = [...new Set(room.map(keyOf))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    counts[keys.length]++;
    keys.forEach((key, i) => {
      if (!changes.has(key)) changes.set(key, new Float64Array(participants));
      const delta = changes.get(key), before = keys.length - i;
      delta[before]--; delta[before - 1]++;
    });
  }
  const keys = [...changes.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const probabilities = [Float64Array.from(counts, n => n / rooms.length)];
  for (const key of keys) {
    const delta = changes.get(key);
    for (let rank = 0; rank < participants; rank++) counts[rank] += delta[rank];
    probabilities.push(Float64Array.from(counts, n => n / rooms.length));
  }
  return section => {
    const key = keyOf(section); let low = 0, high = keys.length;
    while (low < high) { const middle = (low + high) >>> 1; if (keys[middle] <= key) low = middle + 1; else high = middle; }
    return probabilities[low];
  };
}

/** Opponent bank and room draws are independent of candidate discovery and
 * validation. Each player's one song sample supplies ALL three sections. */
export function prepareLuckReferenceScenarios(scenarios, { participants, rooms = 576, seed = 20261117 } = {}) {
  return scenarios.map((scenario, scenarioIndex) => ({ ...scenario,
    sections: scenario.teams[0].songs.map((_, songIndex) => {
      const random = createScoringRandom((seed ^ Math.imul(scenarioIndex + 1, 9176) ^ Math.imul(songIndex + 1, 2654435761)) >>> 0);
      const matches = Array.from({ length: rooms }, () => Array.from({ length: participants - 1 }, (_, opponent) => {
        const samples = scenario.teams[opponent % scenario.teams.length].songs[songIndex].samples;
        return samples[Math.floor(random() * samples.length)];
      }));
      return [0, 1, 2].map(section => prepareLuckReferenceSection(matches.map(room => room.map(sample => sample.sections[section])), participants));
    })
  }));
}

export function createLuckReferenceRanker(songs, scenarios) {
  const prepared = new WeakMap(), totalWeight = songs.reduce((sum, song) => sum + song.weight, 0);
  return (candidates, { limit = Infinity, includeIds = [], includeScoreLeaders = false } = {}) => {
    const rows = candidates.map(candidate => {
      const version = candidate.songs[0].samples.length, previous = prepared.get(candidate);
      if (previous?.version === version) return { ...previous.row };
      const referenceScenarios = scenarios.map(scenario => ({ id: scenario.id, label: scenario.label, score: 0, firstRates: [0, 0, 0], songs: [] }));
      let firstRankScore = 0, sameRankScore = 0, noteScore = 0;
      candidate.songs.forEach((song, songIndex) => {
        const weight = songs[songIndex].weight / totalWeight, n = song.samples.length;
        const results = scenarios.map(() => ({ score: 0, firstRates: [0, 0, 0] }));
        for (const sample of song.samples) {
          noteScore += weight * sample.noteScore / n;
          firstRankScore += weight * (sample.noteScore + sample.sections.reduce((sum, section) => sum + section.bonuses[0], 0)) / n;
          sameRankScore += weight * (sample.noteScore + sample.sections.reduce((sum, section) => sum + section.bonuses.at(-1), 0)) / n;
          scenarios.forEach((scenario, scenarioIndex) => {
            let score = sample.noteScore;
            sample.sections.forEach((section, sectionIndex) => {
              const probabilities = scenario.sections[songIndex][sectionIndex](section);
              for (let rank = 0; rank < probabilities.length; rank++) score += probabilities[rank] * section.bonuses[rank];
              results[scenarioIndex].firstRates[sectionIndex] += probabilities[0] / n;
            });
            results[scenarioIndex].score += score / n;
          });
        }
        results.forEach((result, i) => {
          referenceScenarios[i].score += weight * result.score;
          result.firstRates.forEach((rate, j) => referenceScenarios[i].firstRates[j] += weight * rate);
          referenceScenarios[i].songs.push(result);
        });
      });
      const row = { ...candidate, noteScore, firstRankScore, sameRankScore, referenceScenarios,
        referenceMeanScore: referenceScenarios.reduce((sum, scenario) => sum + scenario.score, 0) / referenceScenarios.length };
      prepared.set(candidate, { version, row }); return { ...row };
    });
    if (!rows.length) throw Error('没有完整可计算的候选队伍');
    const leaders = scenarios.map((_, i) => rows.reduce((a, b) => b.referenceScenarios[i].score > a.referenceScenarios[i].score ? b : a));
    for (const row of rows) {
      row.worstLoss = 0; row.alternativeId = row.id;
      row.referenceScenarios = row.referenceScenarios.map((scenario, i) => {
        const loss = leaders[i].referenceScenarios[i].score - scenario.score;
        if (loss > row.worstLoss) { row.worstLoss = loss; row.alternativeId = leaders[i].id; }
        return { ...scenario, loss, leaderId: leaders[i].id };
      });
    }
    rows.sort((a, b) => a.worstLoss - b.worstLoss || b.referenceMeanScore - a.referenceMeanScore || b.firstRankScore - a.firstRankScore || a.id.localeCompare(b.id));
    if (limit >= rows.length) return rows;
    const required = new Set([...includeIds, ...leaders.map(row => row.id)]);
    if (includeScoreLeaders) for (const field of ['sameRankScore', 'firstRankScore']) required.add(rows.reduce((a, b) => b[field] > a[field] ? b : a).id);
    return rows.filter((row, i) => i < limit || required.has(row.id));
  };
}

/** Preserve score and scenario leaders as well as the balanced frontier. */
export function luckReferenceLeaders(ranked) {
  const ids = new Set(ranked.slice(0, 3).map(row => row.id));
  if (ranked.length) {
    ids.add(ranked.reduce((a, b) => b.firstRankScore > a.firstRankScore ? b : a).id);
    for (const scenario of ranked[0].referenceScenarios) ids.add(scenario.leaderId);
  }
  return ranked.filter(row => ids.has(row.id));
}
