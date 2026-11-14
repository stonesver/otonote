import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/gekisou-skill-fixture.mjs';
import { createInventoryManager } from '../src/lib/inventory-manager.mjs';
import { searchArenaTeams } from '../src/lib/arena-team-search.mjs';
import { createArenaLuckSearch } from '../src/lib/arena-luck-search.mjs';
import { createLuckCandidateSource } from '../src/lib/arena-luck-candidates.mjs';
import { createLuckEvaluator, luckSamplePlan, unpackLuckSamples } from '../src/lib/arena-luck-evaluator.mjs';
import { luckSectionEnvelope, rankLuckCandidates, createLuckCandidateRanker } from '../../packages/scoring/scoring-rules/arena-luck-comparison.mjs';
import { createGekisouSongCalculator } from '../../packages/scoring/scoring-rules/gekisou-song-score.mjs';
import { createPerformanceScenario, normalizePerformanceScenario } from '../../packages/scoring/scoring-rules/performance-scenarios.mjs';
import { skillOrdersFor } from '../../packages/scoring/scoring-rules/skill-order-sampling.mjs';
import { arenaRankingSample } from '../../packages/scoring/scoring-rules/arena-comparison.mjs';
import { createCalculationWorkerPool } from '../src/lib/calculation-worker-pool.mjs';
import { arenaSongPreview } from '../src/lib/arena-team-preview.mjs';

function input() {
  const { rules, chart } = fixture({ missions: [2, 2, 2] });
  const manager = createInventoryManager(rules), inventory = manager.empty();
  for (const kind of ['member', 'support']) for (const card of rules.tables[kind === 'member' ? 'MemberCard' : 'SupportCard']) {
    const id = `${kind}-card-${card._id}`; inventory[`${kind}CardIds`].push(id); inventory.growth[id] = manager.preset(id, kind, 'minimum');
  }
  const context = { bandId: 1, musicType: 99, missions: [2, 2, 2], participantCount: 5 };
  return { rules, sourceRules: rules, context, stage: context, profile: { inventory, account: {} },
    songs: [{ trackId: chart.trackId, difficulty: chart.difficulty, weight: 1, chart }],
    performance: normalizePerformanceScenario({ profile: 'steady', samples: 3 }) };
}

test('opponent-threshold DP matches exhaustive dense ranking, ties and narrow integer gaps', () => {
  let state = 13579;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const sample = count => Array.from({ length: count }, () => {
    const key = BigInt(Math.floor(random() * 8));
    return { key, bonuses: [250, 190, 160, 100, 100].map(p => Math.floor((Number(key) + 10) * p / 100)) };
  }).sort((a, b) => Number(a.key - b.key));
  for (let n = 0; n < 1200; n++) {
    const h = 1 + n % 4, a = sample(1 + n % 7), b = sample(1 + n * 3 % 8);
    let minimum = Infinity, maximum = -Infinity;
    const visit = (opponents, next) => {
      const mean = rows => rows.reduce((sum, x) => sum + x.bonuses[opponents.filter(p => p > x.key).length], 0) / rows.length;
      const value = mean(b) - mean(a); minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
      if (opponents.length === h) return;
      for (let p = next; p <= 7; p++) visit([...opponents, BigInt(p)], p + 1);
    };
    visit([], 0);
    const actual = luckSectionEnvelope(a, b, h, 7n);
    assert.ok(Math.abs(actual.maximum - maximum) < 1e-9);
    assert.ok(Math.abs(actual.minimum - minimum) < 1e-9);
  }
});

const candidate = (id, points, noteScore = 100) => ({ id, songs: [{ samples: points.map(luckPoints => ({ noteScore,
  sections: [1, 2, 3].map(index => ({ index, missionType: 2, just: 0, luckPoints, noteScore: 100, perfectCount: 10, bonuses: [100, 0] })) })) }] });

test('random sample pairing cannot change a LUCK recommendation or create regret between identical distributions', () => {
  const a = candidate('A', [0, 20]), b = candidate('B', [20, 0]);
  for (const row of rankLuckCandidates([a, b], [{ weight: 1 }])) assert.equal(row.worstLoss, 0);
  for (const row of rankLuckCandidates([a, candidate('repeat', [0, 20, 0, 20, 0, 20])], [{ weight: 1 }])) assert.equal(row.worstLoss, 0);
  const c = candidate('C', [0, 10, 20], 130);
  const summarize = rows => rankLuckCandidates(rows, [{ weight: 1 }]).map(({ id, worstLoss }) => [id, worstLoss]);
  assert.deepEqual(summarize([a, b, c]), summarize([a, { ...b, songs: [{ samples: [...b.songs[0].samples].reverse() }] }, c]));
});

test('incremental pair comparisons match a fresh ranking after appends and candidate removal', () => {
  const songs = [{weight:1},{weight:3}], teams = [candidate('A',[0,20]), candidate('B',[10,15]), candidate('C',[0,30])];
  for (const team of teams) team.songs.push(structuredClone(team.songs[0]));
  const rank = createLuckCandidateRanker(songs);
  const compare = rows => assert.deepEqual(rank(rows),rankLuckCandidates(rows,songs));
  compare(teams); compare(teams);
  for (let i = 0; i < 6; i++) {
    const team = teams[i % teams.length];
    team.songs.forEach((song,s) => song.samples.push(...candidate('extra',[i, i + s * 10],100 + i * 7).songs[0].samples));
    compare(teams);
  }
  compare(teams.slice(1)); compare([...teams].reverse()); compare(teams);
});

test('LUCK regret keeps one alternative team across the entire weighted pool', () => {
  const make = (id, values) => ({ id, songs: values.map(noteScore => ({ samples: [{ noteScore,
    sections: [1, 2, 3].map(index => ({ index, missionType: 2, luckPoints: 0, noteScore: 0, perfectCount: 0, bonuses: [0, 0] })) }] })) });
  const teams = [make('A', [120, 60]), make('B', [100, 100]), make('C', [60, 120])];
  assert.equal(rankLuckCandidates(teams, [{ weight: 1 }, { weight: 1 }])[0].id, 'B');
  assert.equal(rankLuckCandidates(teams, [{ weight: 3 }, { weight: 1 }])[0].id, 'A');
});

test('explicit ranking plans reproduce existing seeded replays without changing the full calculator', () => {
  const { rules, chart, draft } = fixture();
  const performance = createPerformanceScenario(rules, chart, { profile: 'steady', samples: 1 });
  const calculator = createGekisouSongCalculator(rules, chart, { performance, performanceOrder: 'sampled', scorePrecision: 'screen', scenario: { seed: 2468 } });
  const plan = skillOrdersFor('screen').map((order, index) => ({ order, seed: (2468 + Math.imul(index + 1, 2654435761)) >>> 0 }));
  const old = calculator.calculateRankingSamples(draft);
  assert.deepEqual(calculator.calculateRankingSamples(draft, { samplePlan: plan }), old);
  assert.deepEqual(calculator.calculateRankingSamples(draft), old);
  assert.deepEqual(calculator.calculateRankingSamples(draft, { samplePlan: plan.slice(3, 5) }).rankingSamples, old.rankingSamples.slice(3, 5));
  const full = calculator.calculate(draft, { includeRankingSamples: true });
  assert.deepEqual(full.rankingSamples, old.rankingSamples);
});

test('joint plans balance player strata, append reproducibly and isolate validation/songs', () => {
  const options = { seed: 123, songIndex: 0, playerCount: 3, player: 1, phase: 0 };
  const first = luckSamplePlan({ ...options, start: 0, end: 6 }), second = luckSamplePlan({ ...options, start: 6, end: 12 });
  assert.equal(first.length, 2);
  assert.deepEqual([...first, ...second], luckSamplePlan({ ...options, start: 0, end: 12 }));
  assert.notDeepEqual(first, luckSamplePlan({ ...options, start: 0, end: 6, phase: 1 }));
  assert.notDeepEqual(first, luckSamplePlan({ ...options, start: 0, end: 6, songIndex: 1 }));
});

test('LUCK candidate generation and evaluation preserve actual growth, source input and full song coverage', async () => {
  const data = input(), before = structuredClone(data.profile);
  data.rules.tables.LiveMusic.push({ ...data.rules.tables.LiveMusic[0], _id: 2 });
  data.songs.push({ ...data.songs[0], trackId: 'music-2', weight: 3, chart: { ...data.songs[0].chart, trackId: 'music-2' } });
  const source = await createLuckCandidateSource(data.rules, data.profile, data.context, data.songs, { limit: 6 });
  assert.ok(source.candidates.length);
  const evaluate = createLuckEvaluator(data);
  const row = await evaluate({ candidate: source.candidates[0], start: 0, end: 6, phase: 0 });
  const split = await Promise.all(data.songs.map((_, songIndex) => evaluate({ candidate: source.candidates[0], start: 0, end: 6, phase: 0, songIndex })));
  assert.deepEqual(split.map(result => result.rows[0]), row.rows);
  assert.equal(row.rows.length, data.songs.length);
  assert.equal(unpackLuckSamples(data.rules, row.rows[0].packed, 5).length, 6);
  for (const c of source.candidates) for (const slot of c.draft.slots) for (const id of [slot.memberCardId, slot.supportCardId]) assert.deepEqual(c.draft.modifiers.growth[id], before.inventory.growth[id]);
  assert.deepEqual(data.profile, before);
  const report = await searchArenaTeams({ ...data, performanceScenario: data.performance }, { luckOptions: { candidateLimit: 3, neighbourLimit: 0 } });
  assert.equal(report.method, 'expected_rank_envelope');
  assert.equal(report.orderCount, null);
  assert.ok(report.candidates.every(c => c.songs.length === data.songs.length && c.songs.every(s => s.samples.length >= 12)));
  assert.notEqual(report.validation.status, 'pending');
  await assert.rejects(searchArenaTeams({ ...data, stage: { ...data.stage, missions: [2, 3, 2] } }), /混段/);
});

test('LUCK full-card reference works without a profile and preserves reference growth through expansion', async () => {
  const { rules, chart } = fixture({ copies: 0, missions: [2, 2, 2] });
  const report = await searchArenaTeams({ rules, profile: null, cardScope: 'reference',
    stage: { bandId: 1, musicType: 99, missions: [2, 2, 2], participantCount: 5 },
    songs: [{ trackId: chart.trackId, difficulty: chart.difficulty, weight: 1, chart }] },
    { luckOptions: { candidateLimit: 2, neighbourLimit: 2 } });
  assert.equal(report.cardScope, 'reference');
  assert.ok(report.search.expansions > 0);
  for (const { draft } of report.candidates) {
    assert.equal(draft.modifiers.planningScenario.scope, 'reference');
    for (const slot of draft.slots) {
      const growth = draft.modifiers.growth[slot.memberCardId];
      assert.equal(growth.skillLevel, 5); assert.equal(growth.gekisouSkillLevel, 5);
      assert.equal(growth.rank, 5); assert.equal(growth.awake, 5);
      assert.equal(draft.modifiers.planningResult.actualGrowth[slot.memberCardId], null);
    }
  }
});

test('LUCK workers preserve serial samples, recommendation and independent validation', async () => {
  const { Worker } = await import('node:worker_threads');
  const data = input(), serial = createArenaLuckSearch(data, { candidateLimit: 3, neighbourLimit: 2 });
  const parallel = createArenaLuckSearch(data, { candidateLimit: 3, neighbourLimit: 2, createEvaluator: input => {
    const pool = createCalculationWorkerPool({ size: 2, createWorker: () => {
      const worker = new Worker(new URL('./fixtures/arena-luck-worker.mjs', import.meta.url));
      worker.postMessage({ type: 'initialize', input });
      return { postMessage: data => worker.postMessage(data), terminate: () => worker.terminate(),
        addEventListener: (type, fn) => worker.on(type, type === 'message' ? data => fn({ data }) : fn) };
    } });
    return { run: task => pool.run(task), width: 2, close: pool.close };
  } });
  try {
    const a = await serial.run(), b = await parallel.run();
    assert.deepEqual(b.candidates, a.candidates);
    assert.deepEqual(b.validation, a.validation);
    assert.deepEqual(b.sampling, a.sampling);
  } finally { serial.close(); parallel.close(); }
});

test('LUCK preview ranks joint tuples before averaging and exposes empirical point quantiles', () => {
  const row = candidate('A', [0, 20]).songs[0];
  const opponents = Array.from({ length: 3 }, () => [{ luckPoints: 10, noteScore: 0, perfectCount: 0 }]);
  const value = arenaSongPreview(row, { opponents });
  assert.equal(value.score, 250);
  assert.deepEqual(value.sections[0], { just: 0, luckPoints: 10, p10: 0, p90: 20, minRank: 1, maxRank: 2 });
});

test('stopping and continuing reuse complete blocks without changing deterministic results', async () => {
  const data = input();
  let session, stopped = false;
  session = createArenaLuckSearch(data, { candidateLimit: 2, neighbourLimit: 0, onProgress: p => {
    if (p.phase === 'luck-screen' && !stopped) { stopped = true; session.stop(); }
  } });
  const partial = await session.run();
  assert.equal(partial.search.stopped, true);
  assert.ok(partial.candidates.length);
  const initial = structuredClone(partial.candidates[0].songs[0].samples);
  const continued = await session.run();
  assert.deepEqual(continued.candidates.find(c => c.id === partial.candidates[0].id).songs[0].samples.slice(0, initial.length), initial);
  const fresh = createArenaLuckSearch(data, { candidateLimit: 2, neighbourLimit: 0 });
  const expected = await fresh.run();
  const values = r => r.candidates.map(c => [c.id, c.worstLoss, c.sameRankScore, c.songs]);
  assert.deepEqual(values(continued), values(expected));
  session.close(); fresh.close();
});

test('manual stop publishes only complete-song blocks and keeps unfinished candidates visible', async () => {
  const data = input(); let clock = 0;
  const session = createArenaLuckSearch(data, { candidateLimit: 3, neighbourLimit: 0, now: () => clock,
    onProgress: p => { if (p.phase === 'luck-screen') { clock = 1e12; session.stop(); } } });
  try {
    const result = await session.run();
    assert.equal(result.search.stopped, true);
    assert.equal(result.validation.status, 'pending');
    assert.equal(result.pendingCandidates, 2);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].songs[0].samples.length, 6);
  } finally { session.close(); }
});

test('validation disagreement automatically adds disjoint samples in one run', async () => {
  let firstId;
  const snapshots = [];
  const session = createArenaLuckSearch(input(), { candidateLimit: 2, neighbourLimit: 0,
    onSnapshot: report => snapshots.push(report.validation.status),
    createEvaluator: () => ({ width: 1, close() {}, async run({ candidate, start, end, phase }) {
      firstId ??= candidate.id;
      const packed = new Float64Array((end - start) * 10);
      for (let i = start; i < end; i++) {
        const score = candidate.id !== firstId ? 140 : phase === 1 || i >= 72 ? 200 : 100;
        packed.set([score, 10, 0, 1, 10, 0, 1, 10, 0, 1], (i - start) * 10);
      }
      return { id: candidate.id, rows: [{ power: 1, packed }] };
    } }) });
  try {
    const result = await session.run();
    assert.ok(snapshots.includes('changed'));
    assert.equal(result.search.round, 2);
    assert.equal(result.search.phase, 'complete');
    assert.equal(result.validation.status, 'agrees');
    assert.equal(result.candidates[0].id, firstId);
    assert.equal(result.candidates[0].songs[0].samples.length, 144);
    assert.deepEqual(result.candidates[0].songs[0].samples.map(s => s.noteScore), [...Array(72).fill(100), ...Array(72).fill(200)]);
  } finally { session.close(); }
});

test('iterative expansion finds a two-swap improvement and resumes an interrupted frontier', async () => {
  const data = input();
  const source = await createLuckCandidateSource(data.rules, data.profile, data.context, data.songs, { limit: 1 });
  const slots = structuredClone(source.candidates[0].draft.slots);
  for (const [a, b] of [[0, 1], [3, 4]]) [slots[a].supportCardId, slots[b].supportCardId] = [slots[b].supportCardId, slots[a].supportCardId];
  const target = new Map(slots.map(s => [s.memberCardId, s.supportCardId]));
  const matches = candidate => candidate.draft.slots.filter(s => target.get(s.memberCardId) === s.supportCardId).length;
  // Use the real candidate generator with a deterministic replay objective so
  // reaching the best team requires two neighbourhoods, independent of luck.
  const createEvaluator = () => ({ close() {}, async run({ candidate, start, end }) {
    const packed = new Float64Array((end - start) * 10);
    for (let i = 0; i < packed.length; i += 10) packed.set([1000 * matches(candidate), 1, 10, 1, 1, 10, 1, 1, 10, 1], i);
    return { id: candidate.id, rows: [{ power: candidate.power, packed }] };
  } });
  const options = { candidateLimit: 1, neighbourLimit: 16, createEvaluator };
  let clock = 0, expired = false;
  const interrupted = createArenaLuckSearch(data, { ...options, now: () => clock, onSnapshot: r => {
    if (matches(r.candidates[0]) === 5 && r.validation.status === 'agrees') interrupted.stop();
  }, onProgress: p => {
    if (p.phase === 'luck-expand' && p.expansions === 1 && !expired) { clock = 1e12; expired = true; interrupted.stop(); }
  } });
  const fresh = createArenaLuckSearch(data, { ...options, onSnapshot: r => {
    if (matches(r.candidates[0]) === 5 && r.validation.status === 'agrees') fresh.stop();
  } });
  try {
    const partial = await interrupted.run();
    assert.equal(partial.search.stopped, true);
    assert.equal(partial.search.expansions, 1);
    assert.ok(matches(partial.candidates[0]) < 5);
    const resumed = await interrupted.run();
    const expected = await fresh.run();
    assert.equal(matches(resumed.candidates[0]), 5);
    assert.ok(resumed.search.expansions >= 2);
    assert.equal(resumed.validation.status, 'agrees');
    assert.deepEqual(resumed.candidates, expected.candidates);
    assert.deepEqual(resumed.sampling, expected.sampling);
    assert.equal(new Set(resumed.candidates.map(c => c.id)).size, resumed.candidates.length);
  } finally { interrupted.close(); fresh.close(); }
});

test('interrupted seed generation and partial neighbourhoods remain available after resume', async () => {
  const data = input(); let stopped = false, session;
  session = createArenaLuckSearch(data, { candidateLimit: 2, neighbourLimit: 0, onProgress: p => {
    if (p.phase === 'generate' && !stopped) { stopped = true; session.stop(); }
  } });
  try {
    const partial = await session.run();
    assert.equal(partial.search.stopped, true);
    assert.equal(partial.candidates.length, 0);
    const resumed = await session.run();
    assert.equal(resumed.search.phase, 'complete');
    assert.equal(resumed.validation.status, 'agrees');
  } finally { session.close(); }
  let yields = 0, stop = false, interruptNeighbours = false;
  const options = { limit: 2, shouldStop: () => stop, yieldControl: async () => {
    if (interruptNeighbours && ++yields === 2) stop = true;
  } };
  const source = await createLuckCandidateSource(data.rules, data.profile, data.context, data.songs, options);
  interruptNeighbours = true;
  assert.equal(await source.neighbours(source.candidates, 16), null);
  stop = false; interruptNeighbours = false;
  const resumed = await source.neighbours(source.candidates, 16);
  const fresh = await createLuckCandidateSource(data.rules, data.profile, data.context, data.songs, { limit: 2 });
  assert.deepEqual(resumed, await fresh.neighbours(fresh.candidates, 16));
});

test('unsupported candidates leave both archives; other replay failures abort the search', async () => {
  const data = input(); let omittedId;
  const session = createArenaLuckSearch(data, { candidateLimit: 2, neighbourLimit: 0, createEvaluator: input => {
    const evaluate = createLuckEvaluator(input);
    return { close() {}, async run(task) {
      if (task.phase === 1) omittedId ??= task.candidate.id;
      if (task.candidate.id === omittedId) return { id: omittedId, omitted: { id: omittedId, reason: 'unsupported test mechanism' } };
      return evaluate(task);
    } };
  } });
  try {
    const result = await session.run();
    assert.equal(result.omitted.length, 1);
    assert.equal(result.candidates.length, 1);
    assert.ok(result.candidates.every(c => c.id !== omittedId));
    assert.ok(!result.validation.candidateIds.includes(omittedId));
  } finally { session.close(); }
  const broken = createArenaLuckSearch(data, { candidateLimit: 1, createEvaluator: () => ({ close() {}, run: async () => { throw Error('broken chart'); } }) });
  try { await assert.rejects(broken.run(), /broken chart/); } finally { broken.close(); }
});

test('ranking rewards reconstructed from LUCK samples retain per-sample integer rounding', () => {
  const { rules, chart, draft } = fixture();
  const performance = createPerformanceScenario(rules, chart, { profile: 'steady', samples: 1 });
  const result = createGekisouSongCalculator(rules, chart, { performance, scenario: { batches: 3 } }).calculateRankingSamples(draft);
  const samples = result.rankingSamples.map(s => arenaRankingSample(rules, s, [2, 2, 2], 5));
  for (const ranks of [[1, 1, 1], [5, 3, 1], [4, 2, 5]]) {
    const expected = createGekisouSongCalculator(rules, chart, { performance, scenario: { batches: 3, ranks } }).calculate(draft).expectedScore;
    assert.equal(samples.reduce((n, s) => n + s.noteScore + s.sections.reduce((v, x, j) => v + x.bonuses[ranks[j] - 1], 0), 0) / samples.length, expected);
  }
});

test('bounded ranking is the exact prefix of full ranking and retains all adversaries', () => {
  const teams = Array.from({ length: 45 }, (_, i) => candidate(`team-${i}`, [i % 7, i * 3 % 11, i * 5 % 17], 100 + i % 9));
  const rank = createLuckCandidateRanker([{ weight: 1 }]);
  for (let round = 0; round < 5; round++) {
    const rows = round % 2 ? [...teams].reverse() : teams;
    const full = rankLuckCandidates(rows, [{ weight: 1 }]);
    const exact = rank(rows, { limit: 4 });
    assert.deepEqual(exact, full.slice(0, 4));
    const extra = full.at(-1).id;
    const included = rank(rows, { limit: 4, includeIds: [extra], includeScoreLeaders: true });
    for (const row of included) assert.deepEqual(row, full.find(c => c.id === row.id));
    assert.ok(included.some(row => row.id === extra));
    teams[round].songs[0].samples.push(...candidate('append', [9, 13], 130).songs[0].samples);
  }
});

test('neighbour batches exhaust the same full frontier without losing lower-power proposals', async () => {
  const data = input();
  const small = await createLuckCandidateSource(data.rules, data.profile, data.context, data.songs, { limit: 2 });
  const large = await createLuckCandidateSource(data.rules, data.profile, data.context, data.songs, { limit: 2 });
  const expected = await large.neighbours(large.candidates, Infinity);
  const batches = await small.neighbours(small.candidates, 2);
  assert.ok(small.pending > 0);
  while (small.pending) batches.push(...await small.neighbours([], 2));
  assert.equal(new Set(batches.map(c => c.id)).size, batches.length);
  assert.deepEqual(batches.map(c => c.id).sort(), expected.map(c => c.id).sort());
  assert.deepEqual(await small.neighbours(small.candidates, 2), []);
});

test('a noiseless complete search stops automatically and a repeat run performs no work', async () => {
  let evaluations = 0, clock = 0;
  const session = createArenaLuckSearch(input(), { candidateLimit: 3, neighbourLimit: 2, now: () => clock,
    createEvaluator: () => ({ width: 2, close() {}, async run({ candidate, start, end }) {
      evaluations++; clock += 1e9;
      const packed = new Float64Array((end - start) * 10);
      for (let i = 0; i < packed.length; i += 10) packed.set([1000, 10, 100, 1, 10, 100, 1, 10, 100, 1], i);
      return { id: candidate.id, rows: [{ power: 1, packed }] };
    } }) });
  try {
    const result = await session.run(), calls = evaluations;
    assert.equal(result.search.phase, 'complete');
    assert.equal(result.search.completion.status, 'close');
    assert.equal(result.search.canContinue, false);
    assert.equal(result.pendingCandidates, 0);
    assert.equal(result.sampling.max, 72);
    assert.ok(result.evaluated > 3);
    assert.deepEqual(await session.run(), result);
    assert.equal(evaluations, calls);
  } finally { session.close(); }
});

test('large song pools pause between songs, resume partial blocks, and never publish a partial pool', async () => {
  const data = input();
  data.songs = Array.from({ length: 50 }, (_, i) => ({ ...data.songs[0], weight: i + 1 }));
  const jobs = new Set(); let paused = false, validationPaused = false, session;
  session = createArenaLuckSearch(data, { candidateLimit: 1, neighbourLimit: 0,
    onProgress: p => {
      if (p.phase === 'luck-screen' && !paused) { paused = true; session.stop(); }
      if (p.phase === 'luck-validate' && !validationPaused) { validationPaused = true; session.stop(); }
    },
    createEvaluator: () => ({ width: 2, close() {}, async run({ candidate, start, end, phase, songIndex }) {
      assert.ok(end - start <= 6);
      const key = `${candidate.id}/${phase}/${songIndex}/${start}/${end}`;
      assert.ok(!jobs.has(key), `repeated song job ${key}`); jobs.add(key);
      const packed = new Float64Array((end - start) * 10);
      for (let i = 0; i < packed.length; i += 10) packed.set([songIndex + 100, 10, 100, 1, 10, 100, 1, 10, 100, 1], i);
      return { id: candidate.id, songIndex, rows: [{ power: 1, packed }] };
    } }) });
  try {
    const partial = await session.run();
    assert.equal(jobs.size, 2);
    assert.equal(partial.candidates.length, 0);
    assert.equal(partial.search.canContinue, true);
    const validating = await session.run();
    assert.equal(validating.search.stopped, true);
    assert.equal(validating.validation.status, 'pending');
    const complete = await session.run();
    assert.equal(complete.search.canContinue, false);
    assert.equal(complete.search.completion.status, 'stable');
    assert.equal(complete.songs.length, 50);
    assert.equal(complete.candidates[0].songs.length, 50);
    assert.ok(complete.candidates[0].songs.every((s, i) => s.samples.length === 72 && s.samples.every(x => x.noteScore === i + 100)));
    const expected = data.songs.reduce((sum, song, i) => sum + song.weight * (i + 100), 0) / data.songs.reduce((sum, song) => sum + song.weight, 0);
    assert.ok(Math.abs(complete.candidates[0].noteScore - expected) < 1e-9);
  } finally { session.close(); }
});

test('an available worker starts the next song while an earlier song is still running', async () => {
  const data = input();
  data.songs = Array.from({ length: 50 }, () => ({ ...data.songs[0] }));
  let release, ready, active = 0, maximum = 0;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { ready = resolve; });
  const initial = [];
  const session = createArenaLuckSearch(data, { candidateLimit: 1, neighbourLimit: 0,
    createEvaluator: () => ({ width: 2, close() {}, async run({ candidate, start, end, phase, songIndex }) {
      maximum = Math.max(maximum, ++active);
      if (phase === 0 && start === 0) initial.push(songIndex);
      if (phase === 0 && start === 0 && songIndex === 0) { ready(); await held; }
      const packed = new Float64Array((end - start) * 10);
      for (let i = 0; i < packed.length; i += 10) packed.set([songIndex + 100, 10, 100, 1, 10, 100, 1, 10, 100, 1], i);
      active--;
      return { id: candidate.id, rows: [{ power: 1, packed }] };
    } }) });
  const running = session.run();
  try {
    await started;
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(initial.includes(2), 'a completed song must not wait for the slow song in its batch');
    assert.ok(initial.length <= 4, 'out-of-order results stay bounded as the song pool grows');
    release();
    const result = await running;
    assert.equal(maximum, 2);
    assert.equal(result.search.phase, 'complete');
    assert.equal(result.candidates[0].songs.length, 50);
    assert.ok(result.candidates[0].songs.every((song, i) => song.samples.length === 72 && song.samples.every(s => s.noteScore === i + 100)));
  } finally { release(); await running; session.close(); }
});

test('unresolved independent rankings finish at the sample ceiling without inviting refinement', async () => {
  let firstId;
  const session = createArenaLuckSearch(input(), { candidateLimit: 2, neighbourLimit: 0,
    createEvaluator: () => ({ width: 1, close() {}, async run({ candidate, start, end, phase }) {
      firstId ??= candidate.id;
      const score = (candidate.id === firstId) === (phase === 0) ? 2000 : 1000;
      const packed = new Float64Array((end - start) * 10);
      for (let i = 0; i < packed.length; i += 10) packed.set([score, 1, 0, 1, 1, 0, 1, 1, 0, 1], i);
      return { id: candidate.id, rows: [{ power: 1, packed }] };
    } }) });
  try {
    const result = await session.run();
    assert.equal(result.search.completion.status, 'unresolved');
    assert.equal(result.search.canContinue, false);
    assert.equal(result.sampling.max, 576);
    assert.equal(result.validation.status, 'changed');
  } finally { session.close(); }
});
