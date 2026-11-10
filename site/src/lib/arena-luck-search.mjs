import { createLuckCandidateRanker } from '../../../packages/scoring/scoring-rules/arena-luck-comparison.mjs';
import { stableSnapshotHash } from './scoring-engine.mjs';
import { createLuckCandidateSource } from './arena-luck-candidates.mjs';
import { createLuckEvaluator, unpackLuckSamples } from './arena-luck-evaluator.mjs';

function contenders(ranked, limit) {
  const ids = new Set();
  for (const row of ranked.slice(0, Math.ceil(limit / 2))) { ids.add(row.id); ids.add(row.alternativeId); }
  for (const row of ranked) { if (ids.size >= limit) break; ids.add(row.id); }
  return [...ids];
}

/** One in-memory search session. Continuing adds disjoint samples to the same
 * complete-song archive; input edits terminate the owning worker/session. */
export function createArenaLuckSearch(input, {
  onProgress, onSnapshot, yieldControl = async () => {}, now = () => performance.now(),
  candidateLimit = 32, neighbourLimit = 16,
  createEvaluator = data => {
    const run = createLuckEvaluator(data);
    return { run: task => run(task, { yieldControl }), close() {}, width: 1 };
  }
} = {}) {
  const { rules, context, songs, profile, performance: playing } = input;
  const summaries = songs.map(({ chart, ...song }) => ({ ...song, chartHash: stableSnapshotHash(chart) }));
  const inputHash = stableSnapshotHash({ rules: stableSnapshotHash(input.sourceRules), profile, stage: context, songs: summaries, performance: playing, searchVersion: 'luck-3' });
  const archives = [new Map(), new Map()], omitted = new Map(), expanded = new Set(), rankingCache = [null, null];
  const rankers = [0, 1].map(() => createLuckCandidateRanker(summaries));
  let source, evaluator, candidates = [], stopped = false, deadline, running = false, runStarted = 0, round = 0, phase = 'generate', elapsedMs = 0, expansions = 0, validationFactor = 1;
  const interrupted = () => stopped || now() >= deadline;
  const count = (id, which) => archives[which].get(id)?.songs[0].samples.length ?? 0;
  const ranked = which => rankingCache[which] ??= archives[which].size ? rankers[which]([...archives[which].values()]) : [];
  const target = n => Math.ceil(n / playing.samples) * playing.samples;
  const allIds = () => candidates.filter(c => !omitted.has(c.id)).map(c => c.id);
  function report() {
    const rows = ranked(0), checked = ranked(1);
    const validationComplete = rows.length === allIds().length && rows.length > 0 && rows.every(row => count(row.id, 1) >= target(12 * validationFactor)) &&
      contenders(checked, 6).every(id => count(id, 1) >= target(36 * validationFactor));
    const counts = rows.map(row => count(row.id, 0));
    return { version: 3, sourceReleaseId: rules.sourceReleaseId, stage: context, songs: summaries, performance: playing,
      poolMode: 'one_difficulty_per_song', weightMeaning: 'evaluation_importance', inputHash,
      method: 'expected_rank_envelope', generated: source?.generated ?? 0, evaluated: rows.length,
      pendingCandidates: allIds().length - rows.length, omitted: [...omitted.values()], candidates: rows,
      orderCount: null, possibleOrderCount: 120, opponentModel: 'fixed_opponent_results_per_song_section', optimality: 'candidate_set_only',
      sampling: { kind: 'joint_player_order_lottery', seed: playing.seed, min: counts.length ? Math.min(...counts) : 0,
        max: counts.length ? Math.max(...counts) : 0, total: [0, 1].reduce((sum, p) => sum + [...archives[p].keys()].reduce((n, id) => n + count(id, p) * songs.length, 0), 0) },
      validation: { status: !validationComplete ? 'pending' : checked[0].id === rows[0].id ? 'agrees' : 'changed',
        winnerId: checked[0]?.id ?? null, candidateIds: checked.slice(0, 3).map(row => row.id) },
      search: { phase, round, expansions, expandedCandidates: expanded.size,
        elapsedMs: elapsedMs + (running ? now() - runStarted : 0), canContinue: round < 5, stopped, budgetReached: now() >= deadline }
    };
  }
  async function advance(ids, threshold, which, label) {
    phase = label;
    const needed = target(threshold), width = Math.max(1, evaluator.width ?? 1);
    while (!interrupted()) {
      const waiting = ids.filter(id => !omitted.has(id) && count(id, which) < needed)
        .sort((a, b) => count(a, which) - count(b, which) || a.localeCompare(b));
      if (!waiting.length) return true;
      const tasks = waiting.slice(0, width).map(id => ({ candidate: candidates.find(c => c.id === id), phase: which,
        start: count(id, which), end: Math.min(needed, count(id, which) + playing.samples * 2) }));
      const results = await Promise.all(tasks.map(task => evaluator.run(task)));
      rankingCache[which] = null;
      for (const result of results) {
        if (result.omitted) { omitted.set(result.id, result.omitted); archives.forEach(a => a.delete(result.id)); rankingCache.fill(null); continue; }
        let row = archives[which].get(result.id);
        if (!row) {
          row = { ...candidates.find(c => c.id === result.id), songs: result.rows.map(song => ({ power: song.power, samples: [] })) };
          archives[which].set(result.id, row);
        }
        // Every job contains every selected song. Never publish an incomplete
        // curve or renormalize the pool after cancellation/unsupported skills.
        result.rows.forEach((song, i) => row.songs[i].samples.push(...unpackLuckSamples(rules, song.packed, context.participantCount)));
      }
      onProgress?.({ phase: label, completed: ids.reduce((n, id) => n + (omitted.has(id) ? needed : Math.min(needed, count(id, which))), 0),
        total: ids.length * needed, candidates: archives[0].size, workers: width, expansions });
      await yieldControl();
    }
    return false;
  }
  const snapshot = () => { const value = report(); if (value.candidates.length) onSnapshot?.(value); };
  return {
    stop() { stopped = true; },
    close() { stopped = true; evaluator?.close(); },
    async run({ budgetMs = 60000 } = {}) {
      if (running) throw Error('LUCK 搜索正在进行');
      running = true; stopped = false; const started = now(); runStarted = started; deadline = started + budgetMs;
      try {
        if (!source?.complete) {
          source = await createLuckCandidateSource(rules, profile, context, songs, { limit: candidateLimit, onProgress, yieldControl, shouldStop: interrupted });
          candidates = source.candidates;
          if (!source.complete) return report();
          if (!candidates.length) throw Error('当前卡库无法组成完整队伍');
        }
        evaluator ??= createEvaluator(input);
        let factor = 2 ** round; validationFactor = factor;
        while (!interrupted()) {
          if (!await advance(allIds(), 12 * factor, 0, expansions ? 'luck-neighbours' : 'luck-screen')) return report();
          snapshot();
          if (!archives[0].size) throw Error('没有完整可计算的候选队伍');
          if (!await advance(contenders(ranked(0), 12), 36 * factor, 0, 'luck-refine')) return report();
          do {
            if (!await advance(contenders(ranked(0), 6), 72 * factor, 0, 'luck-refine')) return report();
          } while (contenders(ranked(0), 6).some(id => count(id, 0) < target(72 * factor)));
          if (!await advance(allIds(), 12 * factor, 1, 'luck-validate')) return report();
          do {
            if (!await advance(contenders(ranked(1), 6), 36 * factor, 1, 'luck-validate')) return report();
          } while (contenders(ranked(1), 6).some(id => count(id, 1) < target(36 * factor)));
          snapshot();
          // Expand newly competitive teams, including teams discovered by an
          // earlier expansion. Validation seeds never choose the frontier.
          const leaders = ranked(0).slice(0, 3).filter(row => !expanded.has(row.id));
          if (!leaders.length) {
            round++;
            // Spend the remaining budget resolving a discovery/validation
            // disagreement. Keep both seed domains and all previous samples.
            if (round < 5 && ranked(0)[0].id !== ranked(1)[0].id) {
              factor = 2 ** round; validationFactor = factor; continue;
            }
            phase = 'complete'; return report();
          }
          if (interrupted()) return report();
          phase = 'luck-expand';
          onProgress?.({ phase, completed: expansions, total: expansions + 1, candidates: archives[0].size, expansions });
          await yieldControl();
          const neighbours = await source.neighbours(leaders, neighbourLimit);
          if (neighbours === null) return report();
          leaders.forEach(row => expanded.add(row.id)); expansions++;
          candidates.push(...neighbours); source.generated += neighbours.length;
        }
        return report();
      } finally { elapsedMs += now() - started; running = false; }
    },
    report
  };
}
