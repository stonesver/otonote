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

const stage = { bandId: 1, musicType: 99, missions: [3, 3, 3], participantCount: 5 };
const section = (just, bonuses, noteScore = 100, perfectCount = 20) => ({ index: 1, missionType: 3, just, noteScore, perfectCount, bonuses });
const candidate = (id, noteScore, just) => ({ id, songs: [{ samples: [{ noteScore, sections: [section(just, [50000, 0])] }] }] });

test('count-only benefit survives unknown-opponent comparison and changes recommendation', () => {
  const ranked = rankArenaCandidates([candidate('score', 5000000, 40), candidate('count', 4980000, 110)], [{ weight: 1 }]);
  assert.deepEqual(ranked.map(c => [c.id, c.worstLoss]), [['count', 20000], ['score', 30000]]);
  assert.equal(ranked[0].sameRankScore, 4980000);
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
  const input = { rules, context: stage, candidates, performance: normalizePerformanceScenario({ profile: 'steady' }),
    songs: [{ trackId: chart.trackId, difficulty: chart.difficulty, weight: 1, chart }] };
  const createWorker = () => {
    const worker = new Worker(new URL('./fixtures/arena-evaluation-worker.mjs', import.meta.url));
    return { postMessage: data => worker.postMessage(data), terminate: () => worker.terminate(),
      addEventListener: (type, fn) => worker.on(type, type === 'message' ? data => fn({ data }) : fn) };
  };
  const serial = await evaluateArenaCandidates(input), progress = [];
  const parallel = await evaluateArenaCandidatesParallel(input, { size: 2, createWorker, onProgress: p => progress.push(p) });
  assert.deepEqual(parallel, serial);
  assert.equal(progress.at(-1).completed, candidates.length);
});

test('team skills use actual member levels and support ranks, and separate inactive missions and durations', async () => {
  const { buildArenaTeamSkills } = await import('../src/lib/arena-team-skills.mjs');
  const { rules, draft } = fixture({ missions: [3, 3, 3] });
  rules.tables.MemberCard[0]._gekisouSkillID = rules.tables.MemberCard[1]._gekisouSkillID = 1;
  rules.tables.MemberCard[2]._gekisouSkillID = rules.tables.GekisouSkill.find(s => s._gekisouMissionType === 2)._id;
  const windowSkill = rules.tables.GekisouSupportSkillEffect.find(e => e._skillEffectType === 4004)._gekisouSupportSkillID;
  rules.tables.SupportCard[0]._gekisouSupportSkillId01 = rules.tables.SupportCard[1]._gekisouSupportSkillId01 = windowSkill;
  draft.modifiers.growth = { 'member-card-1': { gekisouSkillLevel: 1 }, 'member-card-2': { gekisouSkillLevel: 5 },
    'support-card-1': { rank: 1 }, 'support-card-2': { rank: 5 } };
  const cards = new Map();
  for (const kind of ['member', 'support']) for (const native of rules.tables[kind === 'member' ? 'MemberCard' : 'SupportCard']) {
    const id = `${kind}-card-${native._id}`, skillId = kind === 'member' ? native._gekisouSkillID : native._gekisouSupportSkillId01;
    const parent = rules.tables[kind === 'member' ? 'GekisouSkill' : 'GekisouSupportSkill'].find(s => s._id === skillId);
    cards.set(id, { id, kind, masterId: native._id, skills: parent ? [{ kind: kind === 'member' ? 'gekisou' : 'gekisou_support',
      slot: kind === 'member' ? 'gekisou' : 'gekisou_support_1', mission: parent._gekisouMissionType,
      levels: [1, 2, 3, 4, 5].map(level => ({ level, summary: `效果等级 ${level}` })) }] : [] });
  }
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
