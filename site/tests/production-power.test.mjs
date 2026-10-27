import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFormationCalculator } from "../src/lib/scoring-rules/formation-power.mjs";
import { optimizeProductionPairing } from "../src/lib/production-optimizer.mjs";
import { createTeamDraft, parseTeamDraftSearch, serializeTeamDraftSearch } from "../src/lib/team-draft.mjs";

const rules = JSON.parse(readFileSync(new URL("../../packages/scoring/data/formal-scoring-rules.json", import.meta.url)));
const calculator = createFormationCalculator(rules);
const draft = () => createTeamDraft({ slots: Array.from({ length: 5 }, (_, i) => ({
  memberCardId: `member-card-${i + 1}`, supportCardId: `support-card-${i + 1}`
})), selectedSongId: "music-100001", modifiers: { tgwCardRank: 2 } });

test("unsupported legacy memory inputs cannot change power or the shared percentage base", () => {
  const baseline = draft(), legacy = structuredClone(baseline);
  legacy.modifiers.memoryPoints = { 1: 100000, 2: 200, 3: 300 };
  const before = structuredClone(legacy);
  assert.deepEqual(calculator.calculate(legacy), calculator.calculate(baseline));
  assert.deepEqual(calculator.calculateSlot(legacy, 0), calculator.calculateSlot(baseline, 0));
  assert.deepEqual(legacy, before, "keep saved legacy data intact");
});

test("leader skill category targets use mechanical categories, not display groups", () => {
  const r=structuredClone(rules), member=r.tables.MemberCard[0];
  const skill=r.tables.LiveSkill.find(s=>s._id===member._liveSkillID);
  const target=r.tables.SkillTarget.find(t=>t._skillTargetType===3);
  Object.assign(target,{_characterID:0,_bandID:0,_cardType:0,_tagID:0,_gekisouMissionType:0,_gekisouSkillCategories:[],_liveSkillCategories:[1]});
  const effect={_id:999,_skillTargetIDs:[target._id],_skillEffectType:1001,_effectValue:1800};
  for(const category of [1,2,3]){
    skill._skillCategories=[category];skill._displaySkillCategories=[1];
    const c=createFormationCalculator(r);
    assert.equal(c.matchesTarget(member,target._id),category===1);
    assert.deepEqual(c.effectRates(member,[effect]),[0,category===1?1800:0,0]);
  }
  skill._skillCategories=[1];skill._displaySkillCategories=[3];
  assert.equal(createFormationCalculator(r).matchesTarget(member,target._id),true);
});

test("current catalog IDs resolve and all released cards have supported growth and power effects", () => {
  const instruments = Object.fromEntries(rules.tables.BandItem.map((r) => [r._id, 30]));
  for (const member of rules.tables.MemberCard) {
    const d = createTeamDraft({ slots: [null, null, { memberCardId: `member-card-${member._id}` }],
      modifiers: { bandItems: instruments, growth: { [`member-card-${member._id}`]: { rank: 5, awake: 5 } } } });
    assert.ok(calculator.calculate(d).total.total > 0);
  }
  for (const support of rules.tables.SupportCard) {
    assert.ok(calculator.resolveGrowth(support, "Support", { rank: 5 }).values.every(Number.isInteger));
  }
});

test("manual native-rule fixture: support is a rate; each source floors the SAME bonus base", () => {
  const r = structuredClone(rules), t = r.tables;
  Object.assign(t.MemberCard[0], { _performancePowerMax: 101, _technicPowerMax: 203, _visualPowerMax: 307 });
  Object.assign(t.SupportCard[0], { _performancePowerMax: 1000, _technicPowerMax: 2000, _visualPowerMax: 3000 });
  for (const name of ["MemberCardLevel", "SupportCardLevel"]) for (const row of t[name]) {
    row._performanceRate = row._technicRate = row._visualRate = 10000;
  }
  for (const name of ["MemberCardRank", "MemberCardAwake"]) for (const row of t[name]) {
    row._performanceRate = row._technicRate = row._visualRate = 0;
  }
  t.CharacterRank.find((r) => r._rank === 2)._bonus = 5;
  t.CharacterTotalRank = [{ _totalRank: 25, _bonus: 2 }];
  t.LeaderSkillEffect = [{ _id: 1, _leaderSkillID: t.MemberCard[0]._leaderSkillID, _level: 1,
    _skillTargetIDs: [], _skillEffectType: 1000, _effectValue: 1000 }];
  const d = createTeamDraft({ slots: [null, null, { memberCardId: "member-card-1", supportCardId: "support-card-1" }],
    modifiers: { characterRanks: { 1: 2 }, tgwCardRank: 2 } });
  const result = createFormationCalculator(r).calculate(d);
  assert.deepEqual(result.slots[2].bonusBase, { performance: 108, technic: 210, visual: 314, total: 632 });
  assert.deepEqual(result.breakdown.support, { performance: 10, technic: 42, visual: 94, total: 146 });
  assert.equal(result.breakdown.leader.total, 62); // 10 + 21 + 31
  assert.equal(result.breakdown.typeLink.total, 30); // 5 + 10 + 15
  assert.equal(result.breakdown.tgw.total, 6); // 1 + 2 + 3 (doesn't compound other bonuses)
  assert.equal(result.total.total, 876); // 632 + 146 + 62 + 30 + 6
});

test("music type follows member attribute, not the character band", () => {
  const result = calculator.calculate(draft());
  assert.deepEqual(result.slots.map((s) => s.ratesBP.musicType[0]), [0, 500, 0, 0, 0]);
  assert.ok(result.slots.every((s) => s.ratesBP.musicTag[0] === 500));
  assert.equal(result.leaderSlotIndex, 2);
});

test("individual ranks affect their character while off-team ranks cross shared total-rank thresholds", () => {
  const r=structuredClone(rules),t=r.tables;
  t.CharacterRank.find(row=>row._rank===1)._bonus=0;
  t.CharacterRank.find(row=>row._rank===2)._bonus=5;
  const total=t.Character.length;
  t.CharacterTotalRank=[{_totalRank:total,_bonus:0},{_totalRank:total+1,_bonus:7},{_totalRank:total+2,_bonus:11}];
  const d=draft(),c=createFormationCalculator(r);
  d.modifiers.characterRanks=Object.fromEntries(t.Character.map(character=>[character._id,1]));
  const teamCharacters=d.slots.map(slot=>c.card(slot.memberCardId,'member')._characterID);
  const offTeam=t.Character.find(character=>!teamCharacters.includes(character._id))._id;
  const baseline=c.calculate(d);
  d.modifiers.characterRanks[offTeam]=2;
  const shared=c.calculate(d);
  for(const [index,slot] of shared.slots.entries()){
    assert.equal(slot.breakdown.characterRank.total,0,'an off-team rank must not become individual power');
    assert.deepEqual(slot.breakdown.characterTotalRank,{performance:7,technic:7,visual:7,total:21});
    assert.equal(slot.bonusBase.total,baseline.slots[index].bonusBase.total+21);
  }
  assert.ok(shared.total.total>baseline.total.total);
  // Same account total, but the individual bonus now belongs to an on-team character.
  d.modifiers.characterRanks[offTeam]=1;
  d.modifiers.characterRanks[teamCharacters[0]]=2;
  const individual=c.calculate(d);
  for(const [index,slot] of individual.slots.entries()){
    assert.deepEqual(slot.breakdown.characterTotalRank,shared.slots[index].breakdown.characterTotalRank);
    assert.equal(slot.breakdown.characterRank.total,index===0?15:0);
    assert.equal(slot.bonusBase.total,shared.slots[index].bonusBase.total+(index===0?15:0));
  }
  d.modifiers.characterRanks[offTeam]=2;
  const nextThreshold=c.calculate(d);
  assert.ok(nextThreshold.slots.every(slot=>slot.breakdown.characterTotalRank.total===33));
});

test("invalid releases, levels, duplicates and unsupported effects fail closed", () => {
  assert.throws(() => calculator.calculate(draft(), { sourceReleaseId: "other" }), /release_mismatch/);
  const bad = draft(); bad.slots[1].memberCardId = bad.slots[0].memberCardId;
  assert.throws(() => calculator.calculate(bad), /Duplicate/);
  const level = draft(); level.modifiers.growth = { "member-card-1": { level: 999 } };
  assert.throws(() => calculator.calculate(level), /level/);
  const malformed = draft(); malformed.modifiers.bandItems = "bad";
  assert.throws(() => calculator.calculate(malformed), /settings/);
  assert.throws(() => calculator.effectRates(rules.tables.MemberCard[0], [{
    _id: 1, _skillConditionGroup: 999, _skillTargetIDs: [], _skillEffectType: 1000, _effectValue: 500
  }]), /conditional/);
});

test("growth, account ranks, memory and instruments survive share URL", () => {
  const d = draft(); Object.assign(d.modifiers, { growth: { "member-card-1": { rank: 3, awake: 2, level: 20 } },
    characterRanks: { 1: 10, 25: 20 }, memoryPoints: { 1: 30 }, bandItems: { 101: 10 } });
  const restored = parseTeamDraftSearch(serializeTeamDraftSearch(d)).draft;
  assert.deepEqual(restored, d);
  assert.deepEqual(calculator.calculate(restored), calculator.calculate(d));
  assert.ok(parseTeamDraftSearch("?modifiers=%5B%5D").issues.some((r) => r.code === "invalid_modifiers"));
});

test("pairing search exhausts 600 unique candidates, keeps growth and produces reproducible top N", async () => {
  const d = draft(); d.modifiers.growth = { "member-card-1": { rank: 5, awake: 5 }, "support-card-3": { rank: 5 } };
  const original = structuredClone(d);
  const all = await optimizeProductionPairing({ rules, draft: d, topN: 600, yieldControl: async () => {} });
  assert.equal(all.evaluated, 600);
  assert.equal(new Set(all.results.map((r) => r.id)).size, 600);
  assert.equal(all.objective, "formation_power");
  assert.deepEqual(d, original);
  assert.ok(all.results[0].power >= all.baseline);
  for (const result of all.results) assert.equal(calculator.calculate(result.draft).total.total, result.power);
  const top = await optimizeProductionPairing({ rules, draft: d, topN: 5, yieldControl: async () => {} });
  assert.deepEqual(top.results, all.results.slice(0, 5));
});

test("cancelled search exposes no partial ranking as a complete optimum", async () => {
  const controller = new AbortController();
  const result = await optimizeProductionPairing({ rules, draft: draft(), signal: controller.signal,
    onProgress: () => controller.abort(), yieldControl: async () => {} });
  assert.equal(result.status, "cancelled");
  assert.equal(result.evaluated, 20);
  assert.deepEqual(result.results, []);
});
