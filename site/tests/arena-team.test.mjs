import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/gekisou-skill-fixture.mjs';
import { applyArenaContext } from '../../packages/scoring/scoring-rules/arena-context.mjs';
import { arenaRankingSample, sectionRegret, rankArenaCandidates } from '../../packages/scoring/scoring-rules/arena-comparison.mjs';
import { createGekisouSongCalculator } from '../../packages/scoring/scoring-rules/gekisou-song-score.mjs';
import { createPerformanceTemplate } from '../../packages/scoring/scoring-rules/formal-performance-replay.mjs';
import { generateJustCandidates, searchArenaTeams } from '../src/lib/arena-team-search.mjs';
import { createInventoryManager } from '../src/lib/inventory-manager.mjs';
import { rankGekisouSection } from '../../packages/scoring/scoring-rules/gekisou-ranking.mjs';
import { arenaCandidateChanges, arenaCandidateOrder, arenaSongPreview } from '../src/lib/arena-team-preview.mjs';
import { arenaStageTracks } from '../src/lib/arena-song-picker.mjs';

const stage = { bandId: 1, musicType: 99, missions: [3, 3, 3], participantCount: 5 };
const section = (just, bonuses, noteScore = 100, perfectCount = 20) => ({ index: 1, missionType: 3, just, noteScore, perfectCount, bonuses });
const candidate = (id, noteScore, just) => ({ id, songs: [{ samples: [{ noteScore, sections: [section(just, [50000, 0])] }] }] });

test('candidate differences distinguish card replacement, support reassignment and captain movement', () => {
  const slots = Array.from({ length: 5 }, (_, i) => ({ memberCardId: `m${i}`, supportCardId: `s${i}` }));
  const cards = new Map(slots.map((slot, i) => [slot.memberCardId, { characterId: i }]));
  cards.set('m0-new', { characterId: 0 });
  const reference = { slots }, snapshot = structuredClone(reference);
  const diff = draft => arenaCandidateChanges(draft, reference, cards);
  const counts = result => [result.members, result.supports, result.pairings, result.leaderChanged];
  // Whole-pair permutations do not replace cards or change who a support belongs to.
  assert.deepEqual(counts(diff({ slots: [slots[1], slots[0], slots[2], slots[4], slots[3]] })), [0, 0, 0, false]);
  const captain = diff({ slots: [slots[2], slots[1], slots[0], slots[3], slots[4]] });
  assert.deepEqual(counts(captain), [0, 0, 0, true]);
  const replaced = diff({ slots: slots.map((slot, i) => i === 0 ? { memberCardId: 'm0-new', supportCardId: 'new-support' } : slot) });
  assert.deepEqual(counts(replaced), [1, 1, 0, false]);
  assert.equal(replaced.slots[0].before, slots[0]);
  assert.equal(replaced.slots[0].memberChanged, true);
  assert.equal(replaced.slots[0].supportChanged, true);
  // Swapping two existing supports is a pairing change, not two newly added cards.
  const reassigned = diff({ slots: slots.map((slot, i) => i < 2 ? { ...slot, supportCardId: slots[1 - i].supportCardId } : slot) });
  assert.deepEqual(counts(reassigned), [0, 0, 2, false]);
  assert.equal(reassigned.slots[0].supportMoved, true);
  const variant = diff({ slots: slots.map((slot, i) => i === 0 ? { ...slot, memberCardId: 'm0-new' } : slot) });
  assert.deepEqual(counts(variant), [1, 0, 0, false]);
  assert.deepEqual(reference, snapshot);
});

test('count-only benefit survives unknown-opponent comparison and changes recommendation', () => {
  const ranked = rankArenaCandidates([candidate('score', 5000000, 40), candidate('count', 4980000, 110)], [{ weight: 1 }]);
  assert.deepEqual(ranked.map(c => [c.id, c.worstLoss]), [['count', 20000], ['score', 30000]]);
  assert.equal(ranked[0].sameRankScore, 4980000);
  const unknown = arenaCandidateOrder(ranked, { mode: 'unknown' });
  assert.deepEqual(unknown.map(row => row.candidate.id), ['count', 'score']);
  assert.ok(unknown.every(row => row.score === null));
  assert.deepEqual(arenaCandidateOrder(ranked, { mode: 'unknown' }, 'score').map(row => row.candidate.id), ['score', 'count']);
});

test('arena song choices follow the league band and available charts, independent of original attributes and missions', () => {
  const tracks = [
    { id: 'a', bandIds: ['band-1'], musicType: 1, missions: [1, 2, 3] },
    { id: 'b', bandIds: ['band-2'], musicType: 99, missions: [3, 3, 3] },
    { id: 'shared', bandIds: ['band-1', 'band-2'] },
    { id: 'missing', bandIds: ['band-1'] }
  ];
  const charts = ['a', 'b', 'shared'].map(trackId => ({ trackId, analysisDataUrl: '/chart.json' }));
  const ids = band => arenaStageTracks(tracks, charts, band).map(track => track.id);
  assert.deepEqual(ids(1), ['a', 'shared']);
  assert.deepEqual(ids('2'), ['b', 'shared']);
});

test('same task counts use score/perfect tie-breakers; identical tuples must share ranks', () => {
  const a = section(100, [90, 50, 10]), b = section(100, [95, 55, 15]);
  assert.equal(sectionRegret(a, b).loss, 5);
  assert.equal(sectionRegret(a, { ...b, noteScore: 101 }).loss, 85);
  assert.equal(sectionRegret(a, { ...b, perfectCount: 21 }).loss, 85);
  for (const opponents of [[a, a], [b], [{ ...a, just: 99 }, { ...a, just: 101 }]]) {
    const ra = rankGekisouSection(a, opponents, 3), rb = rankGekisouSection(b, opponents, 3);
    assert.ok(b.bonuses[rb - 1] - a.bonuses[ra - 1] <= sectionRegret(a, b).loss);
  }
});

test('regret uses one fixed alternative across songs, not a per-song oracle', () => {
  const make = (id, values) => ({ id, songs: values.map(noteScore => ({ samples: [{ noteScore, sections: [section(1, [0, 0])] }] })) });
  const result = rankArenaCandidates([make('A', [120, 60]), make('B', [100, 100]), make('C', [60, 120])], [{ weight: 1 }, { weight: 1 }]);
  assert.equal(result[0].id, 'B'); assert.equal(result[0].worstLoss, 0);
  assert.equal(result.find(c => c.id === 'A').worstLoss, 10);
  const weighted = rankArenaCandidates([make('A', [120, 60]), make('B', [100, 100]), make('C', [60, 120])], [{ weight: 3 }, { weight: 1 }]);
  assert.equal(weighted[0].id, 'A');
  assert.equal(weighted.find(c => c.id === 'B').worstLoss, 5);
});

test('ranking is performed before averaging operation samples', () => {
  const a = candidate('A', 100, 10), b = candidate('B', 100, 10);
  a.songs[0].samples = [0, 20].map(just => ({ noteScore: 100, sections: [section(just, [50, 0])] }));
  b.songs[0].samples = [10, 10].map(just => ({ noteScore: 100, sections: [section(just, [50, 0])] }));
  assert.equal(rankArenaCandidates([a, b], [{ weight: 1 }])[0].worstLoss, 25);
});

test('visible rank previews preserve sample rank ranges and score the same scenario', () => {
  const song = { samples: [0, 20].map(just => ({ noteScore: 100, sections: [section(just, [50, 0])] })) };
  const opponents = [[{ just: 10, noteScore: 0, perfectCount: 0 }]];
  assert.deepEqual(arenaSongPreview(song, { opponents }), {
    score: 125, sections: [{ just: 10, minRank: 1, maxRank: 2 }]
  });
  assert.deepEqual(arenaSongPreview(song, { rank: 2 }), {
    score: 100, sections: [{ just: 10, minRank: 2, maxRank: 2 }]
  });
  assert.equal(arenaSongPreview(song, { rank: 1 }).score, 150);
  assert.equal(arenaSongPreview(song, { opponents: [[{ just: 0, noteScore: 0, perfectCount: 0 }]] }).score, 150);
});

test('candidate score order follows the displayed rank scenario without changing recommendation order', () => {
  const count = { ...candidate('count', 100, 20), sameRankScore: 100, firstRankScore: 50100 };
  const score = { ...candidate('score', 1000, 0), sameRankScore: 1000, firstRankScore: 51000 };
  const middle = { ...candidate('middle', 2000, 0), sameRankScore: 2000, firstRankScore: 22000 };
  middle.songs[0].samples[0].sections[0].bonuses = [20000, 0];
  const tied = { ...structuredClone(score), id: 'tied' }, candidates = [count, score, middle, tied];
  const ids = rows => rows.map(row => row.candidate.id);
  assert.deepEqual(ids(arenaCandidateOrder(candidates, { mode: 'same' })), ['middle', 'score', 'tied', 'count']);
  assert.deepEqual(ids(arenaCandidateOrder(candidates, { mode: 'first' })), ['score', 'tied', 'count', 'middle']);
  const preview = { mode: 'opponents', songIndex: 0, opponents: new Map([[0, [[{ just: 10, noteScore: 0, perfectCount: 0 }]]]]) };
  const rows = arenaCandidateOrder(candidates, preview);
  assert.deepEqual(rows.map(row => [row.candidate.id, row.score]), [['count', 50100], ['middle', 2000], ['score', 1000], ['tied', 1000]]);
  assert.deepEqual(ids(arenaCandidateOrder(candidates, preview, 'recommendation')), ['count', 'score', 'middle', 'tied']);
  assert.deepEqual(candidates.map(c => c.id), ['count', 'score', 'middle', 'tied']);
});

test('stage view is immutable, distinguishes fallback from ALL and keeps mixed missions', () => {
  const { rules } = fixture({ missions: [1, 2, 3] }), original = structuredClone(rules.tables.LiveMusic);
  const { rules: effective } = applyArenaContext(rules, { ...stage, missions: [3, 0, 1] });
  const song = effective.tables.LiveMusic.find(m => m._id === 100001);
  assert.equal(song._musicType, 99); assert.deepEqual([song._gekisouMission1, song._gekisouMission2, song._gekisouMission3], [3, 2, 1]);
  assert.deepEqual(rules.tables.LiveMusic, original);
  assert.equal(applyArenaContext(rules, { ...stage, musicType: 0 }).rules.tables.LiveMusic[0]._musicType, original[0]._musicType);
});

test('sample ranking rewards reproduce complete scoring for all rank combinations', () => {
  const f = fixture(), rules = applyArenaContext(f.rules, stage).rules;
  for (const m of rules.tables.MemberCard) m._gekisouSkillID = 0;
  const performance = createPerformanceTemplate(rules, f.chart);
  const result = createGekisouSongCalculator(rules, f.chart, { performance }).calculate(f.draft, { includeRankingSamples: true });
  const sample = arenaRankingSample(rules, result.rankingSamples[0], stage.missions, 5);
  for (let a = 1; a <= 5; a++) for (let b = 1; b <= 5; b++) for (let c = 1; c <= 5; c++) {
    const ranks = [a, b, c];
    const actual = createGekisouSongCalculator(rules, f.chart, { performance, scenario: { ranks } }).calculate(f.draft);
    assert.equal(sample.noteScore + sample.sections.reduce((sum, s, i) => sum + s.bonuses[ranks[i] - 1], 0), actual.expectedScore);
  }
  const changed = applyArenaContext(f.rules, { ...stage, musicType: 1 }).rules;
  for (const m of changed.tables.MemberCard) m._gekisouSkillID = 0;
  assert.notEqual(createGekisouSongCalculator(changed, f.chart, { performance }).calculate(f.draft).inputHash, result.inputHash);
});

test('owned growth is preserved, band restriction applies only to members, and search is complete per candidate', async () => {
  const { rules: source, chart } = fixture(), rules = applyArenaContext(source, stage).rules;
  // Add an out-of-band member and make one of the five required supports
  // belong to that other band. Only the member should be excluded.
  rules.tables.MemberCard.push({ ...rules.tables.MemberCard[4], _id: 6, _characterID: 6 });
  rules.tables.SupportCard[4]._characterIDs = [6];
  for (const m of rules.tables.MemberCard) m._gekisouSkillID = 0;
  const manager = createInventoryManager(rules), inventory = manager.empty();
  for (const kind of ['member', 'support']) for (const row of rules.tables[kind === 'member' ? 'MemberCard' : 'SupportCard']) {
    const id = `${kind}-card-${row._id}`; inventory[`${kind}CardIds`].push(id); inventory.growth[id] = manager.preset(id, kind, 'minimum');
  }
  const profile = { inventory, account: { characterRanks: { 1: 3 }, tgwCardRank: 1 } };
  const second = { ...structuredClone(chart), id: 'music-chart-10000203', trackId: 'music-100002' };
  const snapshot = structuredClone(profile), songs = [chart, second].map((chart, i) => ({ trackId: chart.trackId, difficulty: chart.difficulty, weight: i + 1, chart }));
  const generated = await generateJustCandidates(rules, profile, stage, songs);
  assert.ok(generated.length);
  assert.ok(generated.every(c => c.draft.slots.every(s => s.memberCardId !== 'member-card-6')));
  assert.ok(generated.every(c => c.draft.slots.some(s => s.supportCardId === 'support-card-5')));
  for (const c of generated) for (const slot of c.draft.slots) {
    assert.deepEqual(c.draft.modifiers.growth[slot.memberCardId], inventory.growth[slot.memberCardId]);
    assert.deepEqual(c.draft.modifiers.growth[slot.supportCardId], inventory.growth[slot.supportCardId]);
  }
  const result = await searchArenaTeams({ rules, profile, stage, songs, performanceScenario: { profile: 'ideal' } });
  assert.equal(result.orderCount, 120);
  assert.ok(result.candidates.every(c => c.songs.length === 2 && c.songs.every(s => s.samples.length === 120)));
  assert.deepEqual(profile, snapshot);
  assert.equal(result.poolMode, 'one_difficulty_per_song');
  assert.equal(result.weightMeaning, 'evaluation_importance');
  const fullPool = Array.from({ length: 6 }, (_, i) => {
    const id = 990001 + i;
    rules.tables.LiveMusic.push({ ...rules.tables.LiveMusic.find(m => m._id === 100001), _id: id });
    rules.tables.LiveMusicScore.push({ ...rules.tables.LiveMusicScore.find(m => m._id === 10000103), _id: id * 100 + 3, _liveMusicID: id });
    const copiedChart = { ...structuredClone(chart), id: `music-chart-${id}03`, trackId: `music-${id}` };
    return { trackId: copiedChart.trackId, difficulty: copiedChart.difficulty, weight: i + 1, chart: copiedChart };
  });
  const expanded = await searchArenaTeams({ rules, profile, stage: { ...stage, participantCount: 2 }, songs: fullPool, performanceScenario: { profile: 'ideal' } });
  assert.equal(expanded.songs.length, 6);
  assert.ok(expanded.candidates.every(c => c.songs.length === 6 && c.songs.every(s => s.samples.length === 120)));
  const inherited = await searchArenaTeams({ rules, profile, stage: { ...stage, missions: [0, 0, 0] }, songs, performanceScenario: { profile: 'ideal' } });
  assert.deepEqual(inherited.candidates.map(c => [c.id, c.sameRankScore, c.firstRankScore, c.worstLoss]), result.candidates.map(c => [c.id, c.sameRankScore, c.firstRankScore, c.worstLoss]));
  await assert.rejects(searchArenaTeams({ rules, profile, stage, songs: [songs[0], { ...songs[0], difficulty: 'hard' }] }), /每首歌曲只选一档难度/);
  await assert.rejects(searchArenaTeams({ rules, profile, stage: { ...stage, missions: [1, 3, 3] }, songs }), /混段/);
  await assert.rejects(searchArenaTeams({ rules, profile, stage, songs: [songs[0], { ...songs[0], chart: null, trackId: 'music-unknown' }] }), /谱面/);
});

test('ranking-only evaluation preserves every full replay sample, including non-AP and mixed missions', () => {
  for (const missions of [[3, 3, 3], [1, 2, 3]]) {
    const { rules, chart, draft } = fixture({ missions });
    const performance = createPerformanceTemplate(rules, chart);
    performance.judgements[2].judgement = 1;
    const calculator = createGekisouSongCalculator(rules, chart, { performance, performanceOrder: 'sampled' });
    const full = calculator.calculate(draft, { includeRankingSamples: true });
    assert.deepEqual(calculator.calculateRankingSamples(draft), {
      power: full.power, randomSampling: full.randomSampling, rankingSamples: full.rankingSamples
    });
  }
});

test('parallel evaluation retains every candidate, song and skill-order sample in serial order', async () => {
  const { Worker } = await import('node:worker_threads');
  const { evaluateArenaCandidates } = await import('../src/lib/arena-team-search.mjs');
  const { evaluateArenaCandidatesParallel } = await import('../src/lib/arena-team-parallel.mjs');
  const { normalizePerformanceScenario } = await import('../../packages/scoring/scoring-rules/performance-scenarios.mjs');
  const { rules, chart, draft } = fixture({ missions: [3, 3, 3] });
  const candidates = Array.from({ length: 3 }, (_, i) => ({ id: `candidate-${i}`, draft: { ...draft,
    slots: [...draft.slots.slice(i), ...draft.slots.slice(0, i)] } }));
  const second = { ...structuredClone(chart), id: 'music-chart-10000203', trackId: 'music-100002' };
  const music = rules.tables.LiveMusic.find(row => row._id === 100002);
  for (let i = 1; i <= 3; i++) music[`_gekisouMission${i}`] = 3;
  const input = { rules, context: stage, candidates, performance: normalizePerformanceScenario({ profile: 'steady' }),
    songs: [chart, second].map(chart => ({ trackId: chart.trackId, difficulty: chart.difficulty, weight: 1, chart })) };
  const createWorker = () => {
    const worker = new Worker(new URL('./fixtures/arena-evaluation-worker.mjs', import.meta.url));
    return { postMessage: data => worker.postMessage(data), terminate: () => worker.terminate(),
      addEventListener: (type, fn) => worker.on(type, type === 'message' ? data => fn({ data }) : fn) };
  };
  const serial = await evaluateArenaCandidates(input), progress = [];
  const parallel = await evaluateArenaCandidatesParallel(input, { size: 2, createWorker, onProgress: p => progress.push(p) });
  assert.deepEqual(parallel, serial);
  assert.equal(progress.at(-1).completed, candidates.length * input.songs.length);
  assert.ok(progress.every((p, i) => !i || p.completed >= progress[i - 1].completed));
});

function arenaSkillCards(rules) {
  const cards = new Map();
  for (const kind of ['member', 'support']) for (const native of rules.tables[kind === 'member' ? 'MemberCard' : 'SupportCard']) {
    const id = `${kind}-card-${native._id}`, skillId = kind === 'member' ? native._gekisouSkillID : native._gekisouSupportSkillId01;
    const parent = rules.tables[kind === 'member' ? 'GekisouSkill' : 'GekisouSupportSkill'].find(s => s._id === skillId);
    cards.set(id, { id, kind, masterId: native._id, skills: parent ? [{ kind: kind === 'member' ? 'gekisou' : 'gekisou_support',
      slot: kind === 'member' ? 'gekisou' : 'gekisou_support_1', mission: parent._gekisouMissionType,
      levels: [1, 2, 3, 4, 5].map(level => ({ level, summary: `效果等级 ${level}` })) }] : [] });
  }
  return cards;
}

test('team skills use actual member levels and support ranks, and separate inactive missions and durations', async () => {
  const { buildArenaTeamSkills } = await import('../src/lib/arena-team-skills.mjs');
  const { rules, draft } = fixture({ missions: [3, 3, 3] });
  rules.tables.MemberCard[0]._gekisouSkillID = rules.tables.MemberCard[1]._gekisouSkillID = 1;
  rules.tables.MemberCard[2]._gekisouSkillID = rules.tables.GekisouSkill.find(s => s._gekisouMissionType === 2)._id;
  const windowSkill = rules.tables.GekisouSupportSkillEffect.find(e => e._skillEffectType === 4004)._gekisouSupportSkillID;
  rules.tables.SupportCard[0]._gekisouSupportSkillId01 = rules.tables.SupportCard[1]._gekisouSupportSkillId01 = windowSkill;
  draft.modifiers.growth = { 'member-card-1': { gekisouSkillLevel: 1 }, 'member-card-2': { gekisouSkillLevel: 5 },
    'support-card-1': { rank: 1 }, 'support-card-2': { rank: 5 } };
  const cards = arenaSkillCards(rules);
  const skills = buildArenaTeamSkills(rules, draft, cards, [3]);
  assert.equal(skills.byCard.get('member-card-1')[0].summary, '效果等级 1');
  assert.equal(skills.byCard.get('member-card-2')[0].summary, '效果等级 5');
  assert.equal(skills.byCard.get('member-card-3')[0].active, false);
  assert.equal(skills.byCard.get('support-card-1')[0].level, 1);
  assert.equal(skills.byCard.get('support-card-2')[0].level, 5);
  assert.ok(skills.groups.every(g => g.mission === 3));
  const count = skills.groups.find(g => g.role === '计数');
  assert.equal(count.sources.length, 2);
  assert.equal(count.entries.length, 2, 'different durations must not be added into a whole-section bonus');
});


test('compact JUST summaries retain level caps, paired-band branches, conversion selectors and separate budgets', async () => {
  const { buildArenaTeamSkills } = await import('../src/lib/arena-team-skills.mjs');
  const { rules, draft } = fixture({ missions: [3, 3, 3] });
  rules.tables.MemberCard[0]._gekisouSkillID = 11;
  rules.tables.MemberCard[1]._gekisouSkillID = 16;
  rules.tables.MemberCard[2]._gekisouSkillID = 19;
  rules.tables.SupportCard[0]._gekisouSupportSkillId01 = 76;
  draft.modifiers.growth = { 'member-card-1': { gekisouSkillLevel: 3 }, 'member-card-2': { gekisouSkillLevel: 5 },
    'support-card-1': { rank: 5 } };
  const cards = arenaSkillCards(rules), build = () => buildArenaTeamSkills(rules, draft, cards, [3]);
  const first = build();
  assert.equal(first.byCard.get('member-card-1')[0].compactSummary, '每 4 次 JUST，额外计数 +1（最多 +5）');
  assert.equal(first.byCard.get('member-card-1')[0].summary, '效果等级 3', 'native text remains available');
  assert.equal(first.byCard.get('member-card-3')[0].compactSummary, '', 'inactive COMBO is not presented as a JUST effect');
  const life = first.byCard.get('member-card-2')[0].compactSummary;
  assert.match(life, /入段 LIFE < 700：每次 JUST 额外 \+1/);
  assert.match(life, /入段 LIFE ≥ 700：每次 JUST 额外 \+3/);
  assert.equal(first.byCard.get('support-card-1')[0].compactSummary,
    '每 30 次 PERFECT，下 1 次 PERFECT～MISS → JUST；每段最多 4 轮');
  const character = rules.tables.Character.find(c => c._id === rules.tables.MemberCard[0]._characterID);
  rules.tables.MemberCard[0]._characterID = rules.tables.Character.find(c => c._bandID !== character._bandID)._id;
  assert.match(build().byCard.get('support-card-1')[0].compactSummary, /^每 50 次 PERFECT/);
  for (const e of rules.tables.GekisouSupportSkillEffect.filter(e => e._gekisouSupportSkillID === 76)) {
    e._effectExecuteLimitResetConditionGroup = 0; e._effectLimitCount = 2;
  }
  assert.equal(build().byCard.get('support-card-1')[0].compactSummary,
    '每 50 次 PERFECT，下 2 次 PERFECT～MISS → JUST；整曲最多 4 轮');
  const trigger = rules.tables.GekisouSkillEffect.find(e => e._gekisouSkillID === 11 && e._level === 3)._skillTriggerConditionGroup;
  const branch = rules.tables.SkillConditionSet.find(s => s._group === trigger);
  rules.tables.SkillConditionSet.push({ ...branch, _id: 999999 });
  assert.equal(build().byCard.get('member-card-1')[0].compactSummary, '效果等级 3', 'a template cannot flatten an unhandled OR program');
});
