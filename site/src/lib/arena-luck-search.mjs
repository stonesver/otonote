import { createLuckCandidateRanker, rankLuckCandidates } from '../../../packages/scoring/scoring-rules/arena-luck-comparison.mjs';
import { createLuckReferenceRanker, prepareLuckReferenceScenarios, luckReferenceLeaders } from '../../../packages/scoring/scoring-rules/arena-luck-reference.mjs';
import { assessLuckCrossValidation } from '../../../packages/scoring/scoring-rules/arena-luck-validation.mjs';
import { createLuckReferenceTeams } from './arena-luck-reference-teams.mjs';
import { stableSnapshotHash } from './scoring-engine.mjs';
import { createLuckCandidateSource } from './arena-luck-candidates.mjs';
import { createLuckEvaluator, unpackLuckSamples } from './arena-luck-evaluator.mjs';

function contenders(ranked, limit, protectedIds = []) {
  const ids = new Set(protectedIds);
  if (ranked[0]?.referenceScenarios) for (const row of luckReferenceLeaders(ranked)) ids.add(row.id);
  for (const row of ranked.slice(0, Math.ceil(limit / 2))) { ids.add(row.id); ids.add(row.alternativeId); }
  for (const row of ranked) { if (ids.size >= limit) break; ids.add(row.id); }
  return [...ids];
}

// Agreement across independent lottery samples is an empirical stopping rule,
// not a confidence interval or a certificate of global optimality.
function stability(discovery, validation, songs, playerCount, tolerance) {
  const split = Math.floor(validation[0].songs[0].samples.length / (2 * playerCount)) * playerCount;
  const batches = [discovery, validation, ...[false, true].map(second => validation.map(row => ({ ...row,
    songs: row.songs.map(song => ({ ...song, samples: second ? song.samples.slice(split) : song.samples.slice(0, split) }))
  })))].map(rows => rankLuckCandidates(rows, songs));
  const winner = batches[0][0].id;
  const close = batches[0].filter(row => batches.every(batch => {
    const other = batch.find(c => c.id === row.id);
    return other.worstLoss - batch[0].worstLoss <= tolerance;
  })).map(row => row.id);
  const closeStable = close.length > 1 && close.includes(winner);
  return { status: closeStable ? 'close' : batches.every(batch => batch[0].id === winner) ? 'stable' : 'unresolved',
    candidateIds: closeStable ? close : [...new Set(batches.map(batch => batch[0].id))], tolerance };
}

/** One finite search, with manual pause/resume. All selected songs participate;
 * only completed full-pool, balanced-player blocks enter a recommendation. */
export function createArenaLuckSearch(input, {
  onProgress, onSnapshot, yieldControl = async () => {}, now = () => performance.now(),
  candidateLimit = 32, neighbourLimit = 16,
  comparisonMode = 'reference',
  createEvaluator = data => {
    const run = createLuckEvaluator(data);
    return { run: task => run(task, { yieldControl }), close() {}, width: 1 };
  }
} = {}) {
  const { rules, context, songs, profile, performance: playing, cardScope = 'owned', comparisonTeam = null } = input;
  if (!['reference', 'legacy'].includes(comparisonMode)) throw Error('未知的 LUCK 比较方式');
  const reference = comparisonMode === 'reference';
  const summaries = songs.map(({ chart, ...song }) => ({ ...song, chartHash: stableSnapshotHash(chart) }));
  const inputHash = stableSnapshotHash({ rules: stableSnapshotHash(input.sourceRules), profile, cardScope, stage: context, songs: summaries, performance: playing,
    ...(comparisonTeam ? { comparisonTeam: { name: comparisonTeam.name, slots: comparisonTeam.draft.slots } } : {}), searchVersion: reference ? 'luck-reference-3' : 'luck-4' });
  const archives = Array.from({ length: 4 }, () => new Map()), omitted = new Map(), expanded = new Set(), rankingCache = [null, null];
  const rankers = reference ? [null, null] : [0, 1].map(() => createLuckCandidateRanker(summaries));
  const blocks = Array.from({ length: 4 }, () => new Map()), byId = new Map();
  let referenceSource, referenceScenarios, referencePrecision = 72, crossValidation = null;
  const referenceVersions = [0, 0], referenceIds = [];
  let source, evaluator, candidates = [], stopped = false, running = false, runStarted = 0, phase = 'generate', step = 'screen';
  let elapsedMs = 0, expansions = 0, precision = 72, round = 1, verificationIds = [], completion = null, validationReady = false;
  const count = (id, which) => archives[which].get(id)?.songs[0].samples.length ?? 0;
  const protectedIds = () => source?.comparisonId && !omitted.has(source.comparisonId) ? [source.comparisonId] : [];
  const ranked = which => {
    const rows = which ? verificationIds.flatMap(id => archives[1].has(id) ? [archives[1].get(id)] : []) : [...archives[0].values()];
    return rankingCache[which] ??= rows.length && rankers[which] ? rankers[which](rows,
      { limit: 24, includeScoreLeaders: true, includeIds: [...protectedIds(), ...(which ? [] : verificationIds)] }) : [];
  };
  const target = n => Math.ceil(n / playing.samples) * playing.samples;
  const allIds = () => candidates.filter(c => !omitted.has(c.id)).map(c => c.id);
  function report() {
    const rows = ranked(0), checked = ranked(1), counts = [...archives[0].keys()].map(id => count(id, 0));
    return { version: reference ? 6 : 4, sourceReleaseId: rules.sourceReleaseId, stage: context, songs: summaries, performance: playing, cardScope,
      poolMode: 'one_difficulty_per_song', weightMeaning: 'evaluation_importance', inputHash,
      method: reference ? 'reference_opponent_regret' : 'expected_rank_envelope', generated: source?.generated ?? 0, evaluated: archives[0].size,
      pendingCandidates: allIds().length - archives[0].size + (source?.pending ?? 0), omitted: [...omitted.values()], candidates: rows,
      orderCount: null, possibleOrderCount: 120, opponentModel: reference ? 'independent_complete_reference_teams' : 'fixed_opponent_results_per_song_section', optimality: 'candidate_set_only',
      ...(comparisonTeam ? { comparisonTeam: { id: source?.comparisonId ?? null, name: comparisonTeam.name,
        status: omitted.has(source?.comparisonId) ? 'omitted' : archives[0].has(source?.comparisonId) ? 'evaluated' : 'pending' } } : {}),
      ...(reference ? { referenceOpponents: { ready: referenceVersions[0] > 0, validationReady: referenceVersions[1] > 0,
        samplesPerTeam: referenceVersions[0] + referenceVersions[1], samplesPerBank: [...referenceVersions], rooms: target(referencePrecision) * 8,
        scenarios: referenceScenarios?.map(({ id, label, level, teams }) => ({ id, label, level, teams: teams.map(({ id, name, draft }) => ({ id, name, draft })) })) ?? [] } } : {}),
      sampling: { kind: 'joint_player_order_lottery', seed: playing.seed, min: counts.length ? Math.min(...counts) : 0,
        max: counts.length ? Math.max(...counts) : 0, total: [0, 1].reduce((sum, p) => sum + [...archives[p].keys()].reduce((n, id) => n + count(id, p) * songs.length, 0), 0) },
      validation: { status: !validationReady ? 'pending' : checked[0]?.id === rows[0]?.id ? 'agrees' : 'changed',
        scope: 'finalists_and_alternatives', winnerId: checked[0]?.id ?? null, candidateIds: checked.slice(0, 3).map(row => row.id),
        ...(reference ? { cross: crossValidation } : {}) },
      search: { phase, round, expansions, expandedCandidates: expanded.size,
        elapsedMs: elapsedMs + (running ? now() - runStarted : 0), canContinue: !completion, stopped,
        pendingNeighbours: source?.pending ?? 0, scope: { seedLimit: candidateLimit, replacementsPerLeader: 32, additionalSkillTradeoffs: reference, leadersPerExpansion: reference ? 'balanced_score_and_scenarios' : 3 }, completion }
    };
  }
  async function advance(ids, threshold, which, label) {
    phase = label;
    const needed = target(threshold), width = Math.max(1, evaluator.width ?? 1);
    // Refill idle workers immediately, but commit in dispatch order so archive
    // order, sample order and tie-breaking do not depend on song duration.
    // At most two worker-widths of results can wait behind a slow song.
    const pending = [], assigned = new Map();
    let active = 0, completedJobs = 0, lastProgress = -Infinity;
    while (!stopped || pending.length) {
      const waiting = ids.filter(id => !omitted.has(id) && count(id, which) < needed)
        .sort((a, b) => count(a, which) - count(b, which) || a.localeCompare(b));
      for (const id of waiting) {
        if (stopped || active >= width || pending.length >= width * 2) break;
        let block = blocks[which].get(id);
        if (!block) {
          block = { start: count(id, which), end: Math.min(needed, count(id, which) + target(6)), rows: Array(songs.length).fill(null) };
          blocks[which].set(id, block);
        }
        if (!assigned.has(id)) assigned.set(id, new Set());
        const reserved = assigned.get(id);
        for (let songIndex = 0; songIndex < songs.length && active < width && pending.length < width * 2; songIndex++) {
          if (block.rows[songIndex] || reserved.has(songIndex)) continue;
          const task = { candidate: byId.get(id), phase: which >= 2 ? 2 + (which - 2) * referenceIds.length + referenceIds.indexOf(id) : which, start: block.start, end: block.end, songIndex };
          const job = { task, done: false, result: null, promise: null };
          reserved.add(songIndex); active++; pending.push(job);
          job.promise = evaluator.run(task).then(result => { job.result = result; job.done = true; active--; });
        }
      }
      if (!pending.length) return !stopped;
      // A full reorder buffer can finish during yieldControl(). Commit it
      // before waiting; Promise.race([]) would otherwise never resolve.
      if (!pending[0].done) await Promise.race(pending.filter(job => !job.done).map(job => job.promise));
      while (pending[0]?.done) {
        const { task, result } = pending.shift(); completedJobs++;
        assigned.get(result.id)?.delete(task.songIndex);
        if (result.omitted) {
          if (which >= 2) throw Error(`参考对手暂不能计算：${result.omitted.reason}`);
          omitted.set(result.id, result.omitted); archives.forEach(a => a.delete(result.id)); blocks.forEach(a => a.delete(result.id)); rankingCache.fill(null); continue;
        }
        if (omitted.has(result.id)) continue;
        const block = blocks[which].get(result.id);
        block.rows[task.songIndex] = result.rows[0];
        if (block.rows.some(row => row === null)) continue;
        let row = archives[which].get(result.id);
        if (!row) {
          row = { ...byId.get(result.id), songs: block.rows.map(song => ({ power: song.power, samples: [] })) };
          archives[which].set(result.id, row);
        }
        block.rows.forEach((song, i) => row.songs[i].samples.push(...unpackLuckSamples(rules, song.packed, context.participantCount)));
        blocks[which].delete(result.id); rankingCache[which] = null;
      }
      if (completedJobs >= width || now() - lastProgress >= 48 || !pending.length) {
        completedJobs = 0; lastProgress = now();
        onProgress?.({ phase: label, completed: ids.reduce((n, id) => n + (omitted.has(id) ? needed * songs.length :
          Math.min(needed, count(id, which)) * songs.length + (blocks[which].get(id)?.rows.filter(Boolean).length ?? 0) *
            (blocks[which].get(id) ? blocks[which].get(id).end - blocks[which].get(id).start : 0)), 0),
          total: ids.length * needed * songs.length, candidates: archives[0].size, workers: width, expansions, pending: source.pending });
      }
      await yieldControl();
    }
    return false;
  }
  const snapshot = () => { const value = report(); if (value.candidates.length) onSnapshot?.(value); };
  const leaders = () => {
    const rows = ranked(0), selected = reference ? luckReferenceLeaders(rows) : rows.slice(0, 3);
    return [...new Map([...selected, ...rows.filter(row => protectedIds().includes(row.id))].map(row => [row.id, row])).values()];
  };
  async function prepareReferences(bank) {
    if (referenceVersions[bank] >= target(referencePrecision)) return true;
    if (!referenceSource?.complete) {
      referenceSource = cardScope === 'reference' && !profile && candidateLimit === 32 ? source : await createLuckCandidateSource(rules, null, context, songs, { limit: 32, cardScope: 'reference',
        onProgress: progress => onProgress?.({ ...progress, phase: 'luck-reference-generate' }), yieldControl, shouldStop: () => stopped });
      if (!referenceSource.complete) return false;
      referenceScenarios = createLuckReferenceTeams(rules, referenceSource.seeds);
      for (const scenario of referenceScenarios) for (const team of scenario.teams) { referenceIds.push(team.id); byId.set(team.id, team); }
    }
    if (!await advance(referenceIds, referencePrecision, bank + 2, bank ? 'luck-reference-validate' : 'luck-reference')) return false;
    const scenarios = referenceScenarios.map(scenario => ({ ...scenario, teams: scenario.teams.map(team => ({ ...team,
      songs: archives[bank + 2].get(team.id).songs
    })) }));
    rankers[bank] = createLuckReferenceRanker(summaries, prepareLuckReferenceScenarios(scenarios, {
      participants: context.participantCount, rooms: target(referencePrecision) * 8, seed: (playing.seed ^ Math.imul(bank + 1, 123456789)) >>> 0
    }));
    referenceVersions[bank] = target(referencePrecision); rankingCache.fill(null); return true;
  }
  async function refine(limit, samples, label = 'luck-refine') {
    do {
      if (!await advance(contenders(ranked(0), limit, protectedIds()), samples, 0, label)) return false;
    } while (contenders(ranked(0), limit, protectedIds()).some(id => count(id, 0) < target(samples)));
    return true;
  }
  return {
    stop() { stopped = true; },
    close() { stopped = true; evaluator?.close(); },
    async run() {
      if (running) throw Error('LUCK 搜索正在进行');
      if (completion) return report();
      running = true; stopped = false; const started = now(); runStarted = started;
      try {
        if (!source?.complete) {
          source = await createLuckCandidateSource(rules, profile, context, songs, { limit: candidateLimit, cardScope, preserveSkillTradeoffs: reference, comparisonTeam, onProgress, yieldControl, shouldStop: () => stopped });
          candidates = [...source.candidates]; candidates.forEach(row => byId.set(row.id, row));
          if (!source.complete) return report();
          if (!candidates.length) throw Error('当前卡库无法组成完整队伍');
        }
        evaluator ??= createEvaluator(input);
        if (reference && !await prepareReferences(0)) return report();
        while (!stopped) {
          if (step === 'screen') {
            if (!await advance(allIds(), 12, 0, expansions ? 'luck-neighbours' : 'luck-screen')) return report();
            snapshot();
            if (!archives[0].size) throw Error('没有完整可计算的候选队伍');
            // Drain the frontier in small batches. Refining all old candidates
            // on each batch would multiply the cost as the song pool grows.
            step = source.pending ? 'expand' : 'refine';
          }
          if (step === 'refine') {
            if (!await refine(12, 36) || !await refine(6, precision)) return report();
            step = 'expand';
          }
          if (step === 'expand') {
            const nextLeaders = source.pending ? [] : leaders().filter(row => !expanded.has(row.id));
            if (neighbourLimit && (nextLeaders.length || source.pending)) {
              phase = 'luck-expand';
              onProgress?.({ phase, completed: expanded.size, total: expanded.size + nextLeaders.length, candidates: archives[0].size, expansions, pending: source.pending });
              await yieldControl(); if (stopped) return report();
              const neighbours = await source.neighbours(nextLeaders, neighbourLimit);
              if (neighbours === null) return report();
              nextLeaders.forEach(row => expanded.add(row.id)); if (nextLeaders.length) expansions++;
              candidates.push(...neighbours); neighbours.forEach(row => byId.set(row.id, row)); source.generated += neighbours.length;
              step = 'screen'; continue;
            }
            step = 'validate';
          }
          if (step === 'validate') {
            if (reference && (!await prepareReferences(0) || !await prepareReferences(1))) return report();
            if (!await refine(8, precision)) return report();
            if (neighbourLimit && leaders().some(row => !expanded.has(row.id))) { step = 'expand'; continue; }
            verificationIds = contenders(ranked(0), 8, protectedIds());
            // Validation assesses only a fixed shortlist plus its strongest
            // alternatives. Discovery still ranks against the entire archive.
            rankingCache.fill(null); validationReady = false; crossValidation = null;
            if (!await advance(verificationIds, precision, 1, 'luck-validate')) return report();
            verificationIds = verificationIds.filter(id => !omitted.has(id));
            if (!verificationIds.length) throw Error('没有完整可计算的候选队伍');
            validationReady = true;
            const winner = ranked(0)[0];
            const discovery = verificationIds.map(id => archives[0].get(id)), validation = verificationIds.map(id => archives[1].get(id));
            const tolerance = Math.max(1, winner.firstRankScore * 0.002);
            const outcome = reference ? assessLuckCrossValidation(discovery, validation, rankers,
              { playerCount: playing.samples, tolerance, winnerId: winner.id }) : stability(discovery, validation, summaries, playing.samples, tolerance);
            if (reference) crossValidation = outcome;
            // A shortlist can have a different minimax winner from the full
            // archive. Never call that agreement with the published winner.
            if (!outcome.candidateIds.includes(winner.id)) outcome.status = 'unresolved';
            snapshot();
            if (stopped) return report();
            const growCandidate = (outcome.needs?.candidate ?? true) && precision < 576;
            const growOpponent = reference && outcome.needs.opponent && referencePrecision < 576;
            if (outcome.status !== 'unresolved' || (!growCandidate && !growOpponent)) {
              completion = outcome; phase = 'complete'; return report();
            }
            if (growCandidate) precision *= 2;
            if (growOpponent) referencePrecision *= 2;
            round++; validationReady = false; crossValidation = null;
          }
        }
        return report();
      } finally { elapsedMs += now() - started; running = false; }
    },
    report
  };
}
