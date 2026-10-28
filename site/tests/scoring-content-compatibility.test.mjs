import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectPublishedSkillsCompatibility } from '../../packages/scoring/scoring-rules/scoring-compatibility.mjs';

const baseline = JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json', import.meta.url)));
const catalog = { memberCards: baseline.tables.MemberCard.map(row => ({ id: `member-card-${row._id}` })),
  supportCards: baseline.tables.SupportCard.map(row => ({ id: `support-card-${row._id}` })) };
const memberEffect = rules => rules.tables.GekisouSkillEffect.find(row => row._gekisouSkillID === rules.tables.MemberCard[0]._gekisouSkillID && row._level === 5);

test('all public levels report compatibility without coupling content publication to scoring', () => {
  const result = inspectPublishedSkillsCompatibility(baseline, catalog);
  assert.equal(result.checks, (catalog.memberCards.length + catalog.supportCards.length - 1) * 5);
  assert.equal(result.status, 'compatible');
  assert.deepEqual(result.issues, []);
});
test('a new level-five mechanism is reported with its public card and level', () => {
  const rules = structuredClone(baseline);
  memberEffect(rules)._skillEffectType = 98765;
  const result = inspectPublishedSkillsCompatibility(rules, catalog);
  assert.equal(result.status, 'partial');
  assert.ok(result.issues.some(i => i.memberCardId === 'member-card-1' && i.level === 5 &&
    i.code === 'unsupported_skill_mechanism' && /effect 98765/.test(i.message)));
  assert.equal(result.checks, inspectPublishedSkillsCompatibility(baseline, catalog).checks);
});
test('conditions, cumulative rules and missing level data are distinguished in diagnostics', () => {
  for (const change of ['condition', 'cumulative', 'missing']) {
    const rules = structuredClone(baseline), effect = memberEffect(rules);
    if (change === 'condition') {
      effect._skillConditionGroup = 98765;
      rules.tables.SkillConditionSet.push({ _id: 98765, _group: 98765, _conditionIds: [98765] });
      rules.tables.SkillCondition.push({ _id: 98765, _conditionType: 98765 });
    } else if (change === 'cumulative') {
      effect._skillCumulativeConditionID = 98765;
      rules.tables.SkillCumulativeCondition.push({ _id: 98765, _skillCumulativeConditionType: 98765 });
    } else rules.tables.GekisouSkillEffect = rules.tables.GekisouSkillEffect.filter(row => row !== effect);
    const result = inspectPublishedSkillsCompatibility(rules, catalog);
    assert.equal(result.status, 'partial');
    assert.ok(result.issues.some(i => i.code === (change === 'missing' ? 'invalid_skill_data' : 'unsupported_skill_mechanism')));
  }
});
test('support ranks and ordinary effects use the same diagnostic path', () => {
  const rules = structuredClone(baseline), support = rules.tables.SupportCard.find(row => row._gekisouSupportSkillId01);
  rules.tables.GekisouSupportSkillEffect.filter(row => row._gekisouSupportSkillID === support._gekisouSupportSkillId01 && row._level === 5)
    .forEach(row => { row._skillEffectType = 98765; });
  assert.ok(inspectPublishedSkillsCompatibility(rules, catalog).issues.some(i => i.level === 5 && /effect 98765/.test(i.message)));
  const ordinary = structuredClone(baseline);
  ordinary.tables.LiveSkillEffect.find(row => row._liveSkillID === ordinary.tables.MemberCard[0]._liveSkillID && row._level === 5)._skillEffectType = 98765;
  assert.ok(inspectPublishedSkillsCompatibility(ordinary, catalog).issues.some(i => /Unsupported live effect/.test(i.message)));
});
test('unreferenced future rows do not misreport coverage of public cards', () => {
  const rules = structuredClone(baseline);
  rules.tables.GekisouSkillEffect.push({ ...memberEffect(rules), _id: 98765, _gekisouSkillID: 98765, _skillEffectType: 98765 });
  assert.equal(inspectPublishedSkillsCompatibility(rules, catalog).status, 'compatible');
});
test('missing public cards report unavailable or invalid data, not empty successful coverage', () => {
  assert.equal(inspectPublishedSkillsCompatibility(baseline, {}).status, 'unavailable');
  assert.equal(inspectPublishedSkillsCompatibility(baseline, { memberCards: [], supportCards: [] }).status, 'unavailable');
  assert.equal(inspectPublishedSkillsCompatibility(baseline, { ...catalog, memberCards: [{ id: 'member-card-99999' }] }).status, 'partial');
});

// Synthetic definitions exercise the current vocabulary without publishing a
// private Master snapshot. Both live modes use the same ordinary lifecycle.
import { eventYieldOracleFixture } from './helpers/event-yield-oracle-fixture.mjs';
import { createFormalSkillResolver } from '../../packages/scoring/scoring-rules/formal-skills.mjs';
import { createFormalSongCalculator } from '../../packages/scoring/scoring-rules/formal-song-score.mjs';
import { createPerformanceSongCalculator, createPerformanceTemplate } from '../../packages/scoring/scoring-rules/formal-performance-replay.mjs';
import { createFormationCalculator } from '../../packages/scoring/scoring-rules/formation-power.mjs';
import { createOrdinarySkillLifecycle } from '../../packages/scoring/scoring-rules/formal-performance-state.mjs';
import { createFrameClock, skillEndFrame } from '../../packages/scoring/scoring-rules/formal-frame-clock.mjs';
import { optimizeInventory } from '../src/lib/inventory-optimizer.mjs';

function ordinaryFixture() {
  const { rules:r, chart:c, draft:d } = eventYieldOracleFixture();
  c.notes = Array.from({length:40},(_,i)=>({id:`synthetic-${i}`,type:'tap',tick:900+i*100}));
  for (const row of r.tables.LiveSkillEffect) row._effectValue=0;
  for (const row of r.tables.SupportCard) row._supportSkillId01=row._supportSkillId02=0;
  r.tables.SupportCard.find(row=>row._id===1)._supportSkillId01=990;
  r.tables.SupportCardRank.forEach(row=>row._supportSkill01Level=1);
  r.tables.SkillCondition.push({_id:990,_conditionType:5000,_conditionValues:[],_isPositive:true,_conditionTargetIDs:[3]});
  r.tables.SkillConditionSet.push({_id:990,_group:990,_conditionIds:[990]});
  const effect={...r.tables.SupportSkillEffect[0],_id:990,_supportSkillID:990,_level:1,_skillTriggerConditionGroup:53,
    _skillTriggerType:1,_skillConditionGroup:990,_skillReleaseConditionGroup:0,_skillCumulativeConditionID:0,
    _maxEffectValue:0,_effectExecuteLimitCount:0,_effectExecuteLimitResetConditionGroup:0,_effectLimitCount:0,
    _skillTargetIDs:[],_activationTimeSecond:5};
  r.tables.SupportSkillEffect.push(effect);
  return {r,c,d,effect};
}

test('ordinary cumulative support ramps at matching judgements, caps, expires and resets for each run',()=>{
  const {r,c,d,effect}=ordinaryFixture();
  Object.assign(effect,{_skillEffectType:2001,_effectValue:2000,_maxEffectValue:12000,_skillCumulativeConditionID:990});
  r.tables.SkillCumulativeCondition.push({_id:990,_skillCumulativeConditionType:1000,_conditionValues:[4],_conditionTargetIDs:[41,46],_maxCumulativeCount:6});
  const ideal=createFormalSongCalculator(r,c,{scorePrecision:'screen'}).calculate(d,{includeTrace:true});
  assert.ok(ideal.skillScoreGain>0);
  const performance=createPerformanceTemplate(r,c); performance.skillOrder=ideal.bestOrder;
  const explicit=createPerformanceSongCalculator(r,c,{performance}).calculate(d,{includeTrace:true});
  assert.equal(explicit.expectedScore,ideal.maximumScore);
  const increments=explicit.skillTrace.filter(t=>t.action==='cumulative');
  assert.deepEqual(increments.map(t=>t.count),[1,2,3,4,5,6]);
  assert.equal(increments.at(-1).rate,Math.fround(1.2));
  assert.ok(explicit.skillPlayback.variants[0].commands.some(cmd=>cmd.ownerId===2&&cmd.general<0));
  assert.deepEqual(createPerformanceSongCalculator(r,c,{performance}).calculate(d).expectedScore,explicit.expectedScore);
  performance.judgements.forEach((n,i)=>{n.judgement=i%2?4:6;});
  const mixed=createPerformanceSongCalculator(r,c,{performance}).calculate(d,{includeTrace:true});
  assert.ok(mixed.skillTrace.filter(t=>t.action==='cumulative').length<increments.length);
  effect._skillCumulativeConditionID=99999;
  assert.throws(()=>createFormalSkillResolver(r)(d),/Cumulative/);
});

test('GOOD releases only the extra handle, using the last matching note timestamp and native state phases',()=>{
  const skill={slotIndex:0,liveEffects:[{id:1,type:2004,condition:{kind:'always',active:true},targets:[5,6],rate:.1,
    durationRawMs:5000,release:[3]},{id:2,type:2000,condition:{kind:'always',active:true},rate:1,durationRawMs:5000}],supportEffects:[]};
  const clock=createFrameClock({frameRate:60});
  const lifecycle=createOrdinarySkillLifecycle({skills:[skill,...Array.from({length:4},()=>({liveEffects:[],supportEffects:[]}))],
    skillTimes:[1000,2000,3000,4000,5000],skillOrder:[0,1,2,3,4],clock,life:{at:()=>1000},skillEndFrame});
  lifecycle.advance(60,[{judgement:3,timeMs:999}]);
  lifecycle.advance(61,[{judgement:3,timeMs:1010}]);
  lifecycle.advance(62,[{judgement:4,timeMs:1020},{judgement:2,timeMs:1021},{judgement:1,timeMs:1022}]);
  assert.equal(lifecycle.skillTrace.filter(t=>t.action==='release').length,0);
  lifecycle.advance(63,[{judgement:3,timeMs:1040},{judgement:3,timeMs:1041}]);
  const released=lifecycle.skillTrace.find(t=>t.action==='release');
  assert.equal(released.timeMs,1041);
  assert.equal(lifecycle.commands.filter(c=>c.perfect<0).length,1);
  lifecycle.advance(skillEndFrame(clock,1000,5000).frame);
  assert.equal(lifecycle.commands.filter(c=>c.perfect<0).length,1);
  assert.equal(lifecycle.commands.filter(c=>c.general===-1).length,1);
});

test('startup BAD/MISS conversion consumes successful matches once and never reactivates with member skills',()=>{
  const {r,c,d,effect}=ordinaryFixture();
  Object.assign(effect,{_skillEffectType:12006,_effectValue:3,_effectLimitCount:2,_activationTimeSecond:99999,
    _skillTriggerConditionGroup:990,_effectExecuteLimitCount:1,_skillTargetIDs:[44,45]});
  const p=createPerformanceTemplate(r,c);p.judgements.forEach((note,i)=>note.judgement=[4,1,5,2,1,2][i%6]);
  const result=createPerformanceSongCalculator(r,c,{performance:p}).calculate(d,{includeTrace:true});
  assert.deepEqual(result.bestOrderNotes.slice(0,6).map(n=>n.judgement),[4,3,5,3,1,2]);
  assert.equal(result.performance.convertedCount,2);
  assert.equal(result.skillTrace.filter(t=>t.effectId===990).length,1);
  assert.ok(result.stateTrace.at(-1).timeMs<20000,'99999 seconds must not extend simulation');
  effect._effectExecuteLimitResetConditionGroup=990;
  assert.throws(()=>createFormalSkillResolver(r,{dynamic:true})(d),/Reset/);
});

function conditionalLeaderFixture() {
  const {r,c,d}=ordinaryFixture();
  for(const row of r.tables.SupportCard)row._supportSkillId01=0;
  r.tables.MemberCard.forEach(row=>row._cardType=row._id===1?2:1);
  r.tables.SkillTarget.push({_id:990,_skillTargetType:3,_cardType:2,_characterID:0,_bandID:0,_tagID:0,_gekisouMissionType:0});
  r.tables.SkillCondition.push({_id:991,_conditionType:3000,_conditionValues:[],_conditionTargetIDs:[990],_isPositive:true});
  r.tables.SkillConditionSet.push({_id:991,_group:991,_conditionIds:[991]});
  r.tables.SkillCumulativeCondition.push({_id:991,_skillCumulativeConditionType:3000,_conditionValues:[1],_conditionTargetIDs:[990],_maxCumulativeCount:2});
  r.tables.MemberCard.find(row=>row._id===3)._leaderSkillID=991;
  r.tables.LeaderSkillEffect.push({_id:991,_leaderSkillID:991,_level:1,_skillEffectType:1501,_effectValue:2400,
    _skillConditionGroup:991,_skillCumulativeConditionID:991,_skillTargetIDs:[]});
  return {r,c,d};
}

test('leader cumulative counts members rather than distinct attributes and applies empty targets to the whole team',()=>{
  const {r,d}=conditionalLeaderFixture(), calc=createFormationCalculator(r);
  assert.deepEqual(calc.calculate(d).slots.map(s=>s.ratesBP.leader),Array(5).fill([0,2400,0]));
  r.tables.MemberCard.find(row=>row._id===2)._cardType=2;
  assert.deepEqual(calc.calculate(d).slots.map(s=>s.ratesBP.leader),Array(5).fill([0,4800,0]));
  r.tables.MemberCard.find(row=>row._id===4)._cardType=2;
  assert.equal(calc.calculate(d).slots[2].ratesBP.leader[1],4800);
  r.tables.MemberCard.forEach(row=>row._cardType=1);
  assert.equal(calc.calculate(d).breakdown.leader.total,0);
  assert.equal(calc.calculateSlotUpperBound(d,0).ratesBP.leader[1],4800);
});

test('conditional leader search keeps a genuine upper bound and agrees with exhaustive native-power evaluation',async()=>{
  const {r,d}=conditionalLeaderFixture(), calc=createFormationCalculator(r);
  const result=await optimizeInventory({rules:r,draft:d,scope:'owned',objective:'formation_power',topN:1,maxEvaluations:0,
    inventory:{memberCardIds:d.slots.map(s=>s.memberCardId),supportCardIds:d.slots.map(s=>s.supportCardId),growth:d.modifiers.growth},
    constraints:{leaderId:'member-card-3'},yieldControl:async()=>{}});
  assert.equal(result.topNComplete,true);
  const permutations = xs => xs.length ? xs.flatMap((x,i)=>permutations(xs.filter((_,j)=>i!==j)).map(tail=>[x,...tail])) : [[]];
  const expected = Math.max(...permutations(d.slots.map(s=>s.supportCardId)).map(supports=>calc.calculate({...d,slots:d.slots.map((s,i)=>({...s,supportCardId:supports[i]}))}).total.total));
  assert.equal(result.results[0].power,expected);
  assert.ok(result.evaluated>1,'an unattainable relaxed maximum is never treated as an exact team power');
});


test('conditional leader rates reproduce current 1.1.0 ARM64 count, cap and component samples',()=>{
  const native=JSON.parse(readFileSync(new URL('./fixtures/current-ordinary-native.json',import.meta.url)));
  const {r}=conditionalLeaderFixture();
  const cumulative=r.tables.SkillCumulativeCondition.find(row=>row._id===991);
  for(const row of native.leaders.filter(row=>row.maximum>0)){
    const formation=r.tables.MemberCard.slice(0,5).map((member,i)=>({member:{...member,_cardType:row.attributes[i]}}));
    cumulative._maxCumulativeCount=row.maximum;
    const rates=createFormationCalculator(r).effectRates(formation[0].member,[r.tables.LeaderSkillEffect.at(-1)],formation);
    assert.deepEqual(rates,[0,row.expected*2400,0]);
  }
  cumulative._maxCumulativeCount=2;
  for(const row of native.effects){
    const formation=r.tables.MemberCard.slice(0,5).map((member,i)=>({member:{...member,_cardType:i<row.count?2:1}}));
    const effect={...r.tables.LeaderSkillEffect.at(-1),_skillEffectType:row.kind};
    assert.deepEqual(createFormationCalculator(r).effectRates(formation[0].member,[effect],formation),row.expected);
  }
});

import { createGekisouSongCalculator } from '../../packages/scoring/scoring-rules/gekisou-song-score.mjs';
import { compilePairingModels, draftFromPairing } from '../src/lib/inventory-optimizer.mjs';
import { createOrdinaryScoreBound } from '../../packages/scoring/scoring-rules/ordinary-score-bound.mjs';
import { maximumPairing } from '../../packages/scoring/scoring-rules/maximum-pairing.mjs';

test('Gekisou ideal and explicit inputs both execute the ordinary cumulative lifecycle',()=>{
  const {r,c,d,effect}=ordinaryFixture();
  Object.assign(effect,{_skillEffectType:2001,_effectValue:1750,_maxEffectValue:21000,_skillCumulativeConditionID:990});
  r.tables.SkillCumulativeCondition.push({_id:990,_skillCumulativeConditionType:1000,_conditionValues:[2],_conditionTargetIDs:[41,46],_maxCumulativeCount:12});
  c.feverRanges=[{start:1,end:2},{start:2.5,end:3},{start:3.5,end:4}];
  for(const member of r.tables.MemberCard)member._gekisouSkillID=0;
  for(const support of r.tables.SupportCard)support._gekisouSupportSkillId01=support._gekisouSupportSkillId02=0;
  const run=performance=>createGekisouSongCalculator(r,c,{performance,scorePrecision:'screen'}).calculate(d,{includeTrace:true});
  const ideal=run(), explicit=run(createPerformanceTemplate(r,c));
  for(const result of [ideal,explicit]){
    const trace=result.skillPlayback.variants[0].ordinarySkillTrace;
    assert.ok(trace.some(t=>t.action==='cumulative'));
    assert.ok(result.expectedScore>0);
  }
});

test('homogeneous ordinary scores never turn relaxed leader weights into an exact subspace bound',async()=>{
  const {r,c,d}=conditionalLeaderFixture();
  const members=d.slots.map(s=>s.memberCardId),supports=d.slots.map(s=>s.supportCardId);
  const input={draft:d,inventory:{memberCardIds:members,supportCardIds:supports},constraints:{leaderId:'member-card-3'}};
  const [model]=await compilePairingModels(r,input);
  assert.equal(model.powerIsUpperBound,true);
  const solution=maximumPairing({edges:model.edges,requiredMembers:[model.leader]});
  const pairSkills=new Map(), resolve=createFormalSkillResolver(r);
  for(const member of members)for(const support of supports){
    const slots=d.slots.map(s=>({...s}));slots[0]={memberCardId:member,supportCardId:support};
    pairSkills.set(`${member}|${support}`,resolve({...d,slots})[0]);
  }
  const song=createFormalSongCalculator(r,c), bound=createOrdinaryScoreBound({song,pairSkills,legacyFactor:20,input,metric:'expectedScore'});
  const candidate=()=>draftFromPairing(input,model.leader,solution.edges);
  const upper=bound({leader:model.leader,required:[],forbidden:[]},model,solution,candidate);
  assert.equal(bound.stats.fullScoreCalculations,0);
  assert.ok(upper>=song.calculate(candidate()).expectedScore);
});
