import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTeamDraft, parseTeamDraftSearch, serializeTeamDraftSearch } from "../src/lib/team-draft.mjs";
import { createFormationCalculator } from "../src/lib/scoring-rules/formation-power.mjs";
import { createFormalSkillResolver } from "../src/lib/scoring-rules/formal-skills.mjs";
import { createFormalSongCalculator, prepareFormalChart } from "../src/lib/scoring-rules/formal-song-score.mjs";
import { optimizeProductionPairing } from "../src/lib/production-optimizer.mjs";

const rules = JSON.parse(readFileSync(new URL("../src/data/formal-scoring-rules.json", import.meta.url)));
const chart = JSON.parse(readFileSync(new URL("../public/data/music-charts/music-chart-10000103.json", import.meta.url)));
const draft = () => createTeamDraft({ slots: [1, 2, 3, 4, 5].map((id) => ({
  memberCardId: `member-card-${id}`, supportCardId: `support-card-${id}`
})), selectedSongId: chart.trackId, selectedDifficulty: chart.difficulty, modifiers: { tgwCardRank: 2 } });

function simpleFixture() {
  const r = structuredClone(rules);
  r.tables.LiveMusicScore.find((s) => s._id === 10000103)._musicScoreLevel = 5;
  for (const support of r.tables.SupportCard) support._supportSkillId01 = support._supportSkillId02 = 0;
  r.tables.LiveSkillEffect.filter((e) => e._liveSkillID === 1).forEach((e) => { e._effectValue = 10000; });
  const c = { ...chart, feverRanges: [], bpmEvents: [{ tick: 0, bpm: 125 }], skillTimings: [0, 10, 20, 30, 40],
    notes: [0, 4999, 5000].map((tick, id) => ({ id: `tap-${id}`, type: "tap", tick })),
    comboEvents: [0, 4999, 5000].map((tick, id) => ({ noteId: `tap-${id}`, kind: "explicit-judgement", time: tick / 1000 })) };
  return { r, c };
}

test('current-data reference model calculates without claiming the current native audit', () => {
  const {r,c} = simpleFixture();
  const original = createFormalSongCalculator(r,c).calculate(draft()).expectedScore;
  r.referenceProfile = {sourceReleaseId:r.sourceReleaseId,nativeSha256:r.nativeSha256,
    dataCompatibility:'scoring_tables_matched',currentGameplayVerified:false};
  r.sourceReleaseId = 'new-content';r.verificationStatus = 'reference_compatible';
  const current = {...c,sourceReleaseId:'new-content'};
  const result = createFormalSongCalculator(r,current).calculate(draft());
  assert.equal(result.expectedScore,original);
  assert.equal(result.verificationStatus,'reference_formula_reconstructed_chart');
  assert.equal(createFormationCalculator(r).calculate(draft()).status,'estimated');
  assert.equal(r.native.sourceReleaseId,r.referenceProfile.sourceReleaseId);
  assert.throws(()=>createFormalSongCalculator(r,{...current,sourceReleaseId:'wrong'}),/release_mismatch/);
});

test("decoded native coefficient is 0.005; weighted denominator is not the FC count", () => {
  assert.equal(rules.native.difficultyIncrement, Math.fround(0.005));
  assert.equal(rules.native.difficultyIncrementBits, "3ba3d70a");
  const result = prepareFormalChart(rules, chart);
  assert.equal(result.difficultyFactor, Math.fround(1.1));
  assert.equal(result.convertedNoteCount, 555);
  assert.equal(result.events.length, 768);
  assert.equal(result.events.length, result.masterFullCombo);
  assert.equal(result.verificationStatus, "code_formula_reconstructed_chart");
  assert.deepEqual(result.skillTimes, [7578, 27789, 37894, 51789, 74526]);
});

test('combo bonus uses judgements strictly before chart time, including simultaneous threshold crossings', () => {
  const { r, c } = simpleFixture();
  r.tables.LiveComboScoreBonus = [{ _comboBonusType: 0, _requiredComboCount: 2, _bonusFactor: 0.5 }];
  c.notes = [0, 100, 100, 101].map((tick, id) => ({ id: `tap-${id}`, type: 'tap', tick }));
  // Native GetTimingCombo -> FindLastIndexBefore: same-time judgements are
  // excluded even when that group reaches a new bonus threshold.
  const events = prepareFormalChart(r, c).events;
  assert.deepEqual(events.map(e => e.combo), [0, 1, 1, 3]);
  assert.deepEqual(events.map(e => e.comboFactor), [1, 1, 1, 1.5]);
  const result = createFormalSongCalculator(r, c).calculate(draft(), { includeTrace: true });
  assert.deepEqual(result.bestOrderNotes.map(e => e.comboFactor), [1, 1, 1, 1.5]);
});

test("hand fixture: three taps, 100% skill, start inclusive and end exclusive", () => {
  const { r, c } = simpleFixture();
  const d = draft();
  const power = createFormationCalculator(r).calculate(d).total.total;
  const result = createFormalSongCalculator(r, c).calculate(d, { includeTrace: true });
  // Level 5 -> 1; 3 notes -> 3*power/3 = power each. The skill doubles
  // the notes at 0 and 4999 ms, but has expired exactly at 5000 ms.
  assert.equal(result.baseScore, 3 * power);
  assert.equal(result.expectedScore, 5 * power);
  assert.deepEqual(result.bestOrderNotes.map((n) => n.score), [2 * power, 2 * power, power]);
  assert.equal(result.orderCount, 120);
  assert.deepEqual(result.scoreDistribution.outcomes,[{score:5*power,count:120}]);
  assert.equal(result.scoreDistribution.complete,true);
  const screened=createFormalSongCalculator(r,c,{scorePrecision:'screen'}).calculate(d);
  assert.equal(screened.scoreDistribution.count,10);assert.equal(screened.scoreDistribution.complete,false);
});

test("overlapping skills add instead of multiplying; all 120 orders are scored", () => {
  const { r, c } = simpleFixture();
  c.skillTimings = [0, 1, 2, 3, 4];
  const d = draft(), power = createFormationCalculator(r).calculate(d).total.total;
  const result = createFormalSongCalculator(r, c).calculate(d, { includeTrace: true });
  assert.deepEqual(result.bestOrderNotes.map((n) => n.scoreUpFactor), [2, 6, 5]);
  assert.equal(result.expectedScore, 13 * power);
});

test("native float32 removal retains rounding history after the skill ends", () => {
  const { r, c } = simpleFixture();
  r.tables.LiveSkillEffect.filter((e) => e._liveSkillID === 1).forEach((e) => { e._effectValue = 3000; });
  const result = createFormalSongCalculator(r, c).calculate(draft(), { includeTrace: true });
  // Independently checked with Python struct.pack/unpack('<f'):
  // float(1 + float(0.3)) = 1.299999952316284;
  // subtracting float(0.3) leaves 0.999999... rather than resetting to 1.
  assert.equal(result.bestOrderNotes[2].scoreUpFactor, 0.9999999403953552);
  assert.equal(result.bestOrderNotes[2].score, result.power - 1);
});

test("130 percent skill preserves the native floor to 1/100000 precision", () => {
  const { r, c } = simpleFixture();
  r.tables.LiveSkillEffect.filter((e) => e._liveSkillID === 1).forEach((e) => { e._effectValue = 13000; });
  const result = createFormalSongCalculator(r, c).calculate(draft(), { includeTrace: true });
  // float(13000/10000)*100000 rounds to 129999.9921875, then floors to 129999.
  assert.equal(result.bestOrderNotes[0].scoreUpFactor, 2.299990177154541);
  assert.equal(result.bestOrderNotes[2].scoreUpFactor, 1.0000001192092896);
});

test('native skill end timestamps ceil the combined float32 duration', () => {
  const { r, c } = simpleFixture();
  for (const e of r.tables.LiveSkillEffect) e._activationTimeSecond = 0.1001;
  c.notes = [99, 101, 102].map((tick, id) => ({ id: `duration-${id}`, type: 'tap', tick }));
  const result = createFormalSongCalculator(r, c).calculate(draft(), { includeTrace: true });
  assert.equal(result.skills[0].liveEffects[0].durationMs, 101);
  assert.deepEqual(result.bestOrderNotes.map(e => e.scoreUpFactor), [2, 2, 1]);
});

test("all published chart projections adapt; source skill events need not be sorted", () => {
  // The full published catalog must use its own rules snapshot. Historical
  // hand fixtures above deliberately retain the audited baseline rules.
  const publishedRules=process.env.OTONOTE_PUBLISHED_RULES?JSON.parse(readFileSync(process.env.OTONOTE_PUBLISHED_RULES)):rules;
  const directory=process.env.OTONOTE_PUBLISHED_CHARTS?pathToFileURL(resolve(process.env.OTONOTE_PUBLISHED_CHARTS)+'/'):new URL("../public/data/music-charts/", import.meta.url);
  for (const filename of readdirSync(directory).filter((f) => f.endsWith(".json"))) {
    const data = JSON.parse(readFileSync(new URL(filename, directory)));
    const result = prepareFormalChart(publishedRules, data);
    assert.equal(result.events.length, result.masterFullCombo, filename);
    assert.equal(result.skillTimes.length, 5);
    assert.ok(result.skillTimes.every((time, i, all) => !i || time > all[i - 1]), filename);
    assert.equal(result.verificationStatus, publishedRules.referenceProfile ? "reference_formula_reconstructed_chart" : "code_formula_reconstructed_chart");
  }
});

test("support band conditions are exclusive and skill levels follow support rank", () => {
  const d = draft(), resolve = createFormalSkillResolver(rules);
  assert.equal(resolve(d)[0].extensionMs, 500); // support 1 + band 1
  d.slots[0].memberCardId = "member-card-6"; // band 2
  assert.equal(resolve(d)[0].extensionMs, 250);
  d.modifiers.growth = { "support-card-1": { rank: 5 } };
  assert.equal(resolve(d)[0].extensionMs, 1500); // Master level 5 has a larger final step.
  d.slots[0].memberCardId = "member-card-1";
  assert.equal(resolve(d)[0].extensionMs, 3000);
});

test("every released member/support skill at each level resolves in the explicit AP scenario", () => {
  const resolve = createFormalSkillResolver(rules), d = draft();
  for (const member of rules.tables.MemberCard) for (let level = 1; level <= 5; level++) {
    d.slots[0].memberCardId = `member-card-${member._id}`;
    d.modifiers.growth = { [d.slots[0].memberCardId]: { skillLevel: level } };
    const skill = resolve(d)[0];
    assert.ok(skill.liveEffects.some((e) => e.active));
    // At 1000 HP only the positive >=700 branch can apply.
    if (skill.liveEffects.length === 2) assert.equal(skill.liveEffects.filter((e) => e.active).length, 1);
  }
  for (const support of rules.tables.SupportCard) for (let rank = 1; rank <= 5; rank++) {
    d.slots[0].supportCardId = `support-card-${support._id}`;
    d.modifiers.growth = { [d.slots[0].supportCardId]: { rank } };
    assert.ok(resolve(d)[0].extensionMs >= 0);
  }
});

test("unknown effects, mismatched chart/release and invalid skill levels fail closed", () => {
  const d = draft();
  assert.throws(() => createFormalSongCalculator(rules, { ...chart, sourceReleaseId: "other" }), /release_mismatch/);
  assert.throws(() => createFormalSongCalculator(rules, {}).calculate(d));
  d.selectedDifficulty = "normal";
  assert.throws(() => createFormalSongCalculator(rules, chart).calculate(d), /不一致/);
  d.selectedDifficulty = chart.difficulty;
  d.modifiers.growth = { "member-card-1": { skillLevel: 9 } };
  assert.throws(() => createFormalSongCalculator(rules, chart).calculate(d), /skillLevel/);
  const r = structuredClone(rules); r.tables.LiveSkillEffect[0]._skillEffectType = 99999;
  assert.throws(() => createFormalSongCalculator(r, chart).calculate(draft()), /Unsupported live effect/);
});

test("skill growth shares correctly; random mean and max trace reproduce", () => {
  const d = draft(); d.modifiers.growth = { "member-card-1": { skillLevel: 5 } };
  assert.deepEqual(parseTeamDraftSearch(serializeTeamDraftSearch(d)).draft, d);
  const result = createFormalSongCalculator(rules, chart).calculate(d, { includeTrace: true });
  assert.ok(result.minimumScore < result.expectedScore && result.expectedScore < result.maximumScore);
  assert.equal(result.bestOrderNotes.reduce((s, n) => s + n.score, 0), result.maximumScore);
  const reordered = structuredClone(d); [reordered.slots[0], reordered.slots[1]] = [reordered.slots[1], reordered.slots[0]];
  assert.equal(createFormalSongCalculator(rules, chart).calculate(reordered).expectedScore, result.expectedScore);
});

test("600 candidate score optimization uses the same whole-song objective", async () => {
  const { r, c } = simpleFixture();
  const d = draft();
  const result = await optimizeProductionPairing({ rules: r, draft: d, chart: c,
    objective: "expected_song_score", topN: 3, yieldControl: async () => {} });
  assert.equal(result.evaluated, 600);
  assert.equal(result.objective, "expected_song_score");
  const calc = createFormalSongCalculator(r, c);
  for (const item of result.results) {
    assert.equal(item.value, calc.calculate(item.draft).expectedScore);
    assert.equal(item.delta, item.value - result.baseline);
  }
  assert.ok(result.results[0].value >= result.baseline);
});
