import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeArenaSkillPreferences, createArenaSkillPolicy, matchArenaSkills, arenaPreferredCandidate } from '../src/lib/arena-skill-policy.mjs';
import { generateJustCandidates, searchArenaTeams } from '../src/lib/arena-team-search.mjs';
import { resolveSearchInput } from '../src/lib/scoring-rules/formation-input.mjs';
import { fixture } from './fixtures/gekisou-skill-fixture.mjs';

const stage = { bandId: 1, musicType: 99, missions: [3, 3, 3], participantCount: 2 };
const songsOf = chart => [{ trackId: chart.trackId, difficulty: chart.difficulty, weight: 1, chart }];

test('reference search works without an inventory, retains maximum growth and reference provenance', async () => {
  const { rules, chart } = fixture({ copies: 0, missions: [3, 3, 3] });
  const report = await searchArenaTeams({ rules, chart, stage, songs: songsOf(chart), cardScope: 'reference', performanceScenario: { profile: 'ideal' } });
  assert.ok(report.candidates.length);
  assert.equal(report.cardScope, 'reference');
  for (const { draft } of report.candidates) {
    assert.equal(draft.modifiers.planningScenario.scope, 'reference');
    assert.equal(Object.keys(draft.modifiers.growth).length, 10);
    for (const slot of draft.slots) {
      const growth = draft.modifiers.growth[slot.memberCardId];
      assert.equal(growth.skillLevel, 5); assert.equal(growth.gekisouSkillLevel, 5);
      assert.equal(growth.rank, 5); assert.equal(growth.awake, 5);
      assert.equal(draft.modifiers.planningResult.actualGrowth[slot.memberCardId], null);
    }
  }
  const profile = { account: { characterRanks: { 1: 3 }, tgwCardRank: 2 } };
  const before = structuredClone(profile);
  const candidates = await generateJustCandidates(rules, profile, stage, songsOf(chart), { cardScope: 'reference' });
  assert.equal(candidates[0].draft.modifiers.tgwCardRank, 2);
  assert.deepEqual(candidates[0].draft.modifiers.characterRanks, { 1: 3 });
  assert.deepEqual(profile, before);
});

test('skill constraints and preference seeds reach lower-power eligible cards and never relax limits', async () => {
  const { rules, chart, draft } = fixture({ copies: 0, missions: [3, 3, 3] });
  rules.tables.MemberCard.push({ ...rules.tables.MemberCard[0], _id: 6, _gekisouSkillID: 11,
    _performancePowerMax: 1, _technicPowerMax: 1, _visualPowerMax: 1 });
  const window = rules.tables.GekisouSupportSkillEffect.find(e => e._skillEffectType === 4004)._gekisouSupportSkillID;
  rules.tables.SupportCard[0]._gekisouSupportSkillId01 = rules.tables.SupportCard[0]._gekisouSupportSkillId02 = window;
  rules.tables.SupportCard[1]._gekisouSupportSkillId01 = 76; // Conversion uses targets/budgets, with effectValue = 0.
  rules.tables.MemberCard[2]._gekisouSkillID = 19; // COMBO, not JUST.
  const input = resolveSearchInput(rules, draft, { scope: 'reference', constraints: { bandId: 1 } });
  const settings = normalizeArenaSkillPreferences({ preference: 'count', limits: { member: { count: { min: 1, max: 1 } } } });
  const policy = createArenaSkillPolicy(rules, input, settings);
  assert.equal(policy.has('member-card-3', 'count'), false);
  assert.equal(policy.has('member-card-6', 'count'), true);
  assert.equal(policy.has('support-card-1', 'window'), true);
  assert.equal(policy.has('support-card-2', 'conversion'), true);
  const constrained = await searchArenaTeams({ rules, stage, songs: songsOf(chart), cardScope: 'reference', skillPreferences: settings });
  assert.ok(constrained.candidates.every(c => c.draft.slots.some(s => s.memberCardId === 'member-card-6')));
  assert.ok(constrained.candidates.every(c => c.skillCounts.member.count === 1 && c.skillCounts.support.window === 1));
  assert.ok(constrained.candidates.every(c => c.skillCounts.support.conversion === 1));
  assert.ok(constrained.preferredCandidateId);
  const excluded = await generateJustCandidates(rules, null, stage, songsOf(chart), { cardScope: 'reference',
    skillPreferences: { preference: 'count', limits: { member: { count: { max: 0 } } } } });
  assert.ok(excluded.length); assert.ok(excluded.every(c => c.skillCounts.member.count === 0));
  assert.equal(arenaPreferredCandidate(excluded, 'count'), null);
  const preferred = await generateJustCandidates(rules, null, stage, songsOf(chart), { cardScope: 'reference', skillPreferences: { preference: 'count' } });
  assert.ok(preferred.some(c => c.skillCounts.member.count === 1));
  await assert.rejects(searchArenaTeams({ rules, stage, songs: songsOf(chart), cardScope: 'reference',
    skillPreferences: { limits: { member: { count: { min: 2 } } } } }), /无法组成符合技能数量限制/);
  assert.notEqual(constrained.inputHash, (await searchArenaTeams({ rules, stage, songs: songsOf(chart), cardScope: 'reference' })).inputHash);
});

test('overlapping member/support quantity bounds agree with a full small matching oracle', async () => {
  const members = ['m1', 'm1b', 'm2', 'm2b', 'm3', 'm4', 'm5'], supports = ['s1', 's2', 's3', 's4', 's5', 's6'];
  const tags = { m1: ['window'], m1b: ['count'], m2: ['window', 'count'], m2b: [], m3: ['count'], m4: [], m5: [],
    s1: ['window', 'conversion'], s2: ['window'], s3: ['window'], s4: ['conversion'], s5: [], s6: ['conversion'] };
  const edges = members.flatMap((member, m) => supports.map((support, s) => ({ key: `${member}|${support}`, member, support,
    character: member.slice(0, 2), weight: 500 - m * 17 + ((m + 3) * (s + 11) % 53) })));
  const has = (id, role) => tags[id].includes(role);
  const counts = edges => Object.fromEntries(['member', 'support'].map(kind => [kind, Object.fromEntries(['window', 'count', 'conversion']
    .map(role => [role, edges.filter(e => has(e[kind], role)).length]))]));
  const all = [];
  function enumerate(chosen = [], used = new Set()) {
    if (chosen.length === 5) { all.push({ edges: chosen, weight: chosen.reduce((n, e) => n + e.weight, 0), counts: counts(chosen) }); return; }
    for (const edge of edges.filter(e => e.character === `m${chosen.length + 1}` && !used.has(e.support))) enumerate([...chosen, edge], new Set([...used, edge.support]));
  }
  enumerate();
  for (const limits of [
    [{ kind: 'member', role: 'window', min: 0, max: 1 }, { kind: 'support', role: 'conversion', min: 3, max: 3 }],
    [{ kind: 'member', role: 'count', min: 2, max: 3 }, { kind: 'support', role: 'window', min: 1, max: 2 }],
    [{ kind: 'member', role: 'window', min: 0, max: 0 }, { kind: 'support', role: 'conversion', min: 2, max: 2 }],
    [{ kind: 'member', role: 'count', min: 4, max: 5 }]
  ]) {
    const feasible = all.filter(candidate => limits.every(({ kind, role, min, max }) => candidate.counts[kind][role] >= min && candidate.counts[kind][role] <= max));
    const actual = await matchArenaSkills({ edges }, { limits, has, counts }, async () => {});
    assert.equal(actual?.weight ?? null, feasible.length ? Math.max(...feasible.map(c => c.weight)) : null);
  }
});

test('preference keeps comprehensive ordering on ties and rejects reversed quantity bounds', () => {
  const candidates = [0, 2, 2, 1].map((n, i) => ({ id: String(i), skillCounts: { member: { count: n }, support: { count: 0 } } }));
  assert.equal(arenaPreferredCandidate(candidates, 'count'), '1');
  assert.equal(arenaPreferredCandidate(candidates, 'none'), null);
  assert.throws(() => normalizeArenaSkillPreferences({ limits: { support: { window: { min: 3, max: 1 } } } }), /最少不能超过最多/);
});
