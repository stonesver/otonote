import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {optimizeChallenge} from '../src/lib/challenge-optimizer.mjs';
import {createEventEfficiency} from '../src/lib/scoring-rules/event-efficiency.mjs';
import {createFormalSongCalculator} from '../src/lib/scoring-rules/formal-song-score.mjs';
import {createTeamDraft} from '../src/lib/team-draft.mjs';

function fixture(){
  const rules=JSON.parse(readFileSync(new URL('../src/data/formal-scoring-rules.json',import.meta.url)));
  const chart=JSON.parse(readFileSync(new URL('../public/data/music-charts/music-chart-10003803.json',import.meta.url)));
  chart.sourceReleaseId=rules.sourceReleaseId;
  const musicId=Number(chart.trackId.split('-').at(-1));
  rules.tables.Event=[{_id:1,_eventType:1}];
  rules.tables.ChallengeMusic=[{_eventId:1,_liveMusicId:musicId,_musicType:2,_gekisouMission1:0,_gekisouMission2:0,_gekisouMission3:0}];
  rules.tables.EventEffect=[2,3].map((type,i)=>({_id:i+1,_eventId:1,_resourceTypeConstraint:type,_eventBonusType:2,
    ...Object.fromEntries([1,2,3,4,5].map(rank=>[`_rank${rank}EffectValue`,10000]))}));
  const draft=createTeamDraft({selectedSongId:chart.trackId,selectedDifficulty:chart.difficulty,
    slots:[1,2,3,4,5].map(i=>({memberCardId:`member-card-${i}`,supportCardId:`support-card-${i}`}))});
  const inventory={memberCardIds:draft.slots.map(s=>s.memberCardId),supportCardIds:draft.slots.map(s=>s.supportCardId),growth:{}};
  for(const s of draft.slots){inventory.growth[s.memberCardId]={level:1,rank:1,awake:1,skillLevel:1,gekisouSkillLevel:1};inventory.growth[s.supportCardId]={level:1,rank:1};}
  return {rules,chart,draft,inventory,eventId:1,yieldControl:async()=>{}};
}
test('challenge search keeps actual growth and compares full event-aware scores against baseline',async()=>{
  const input=fixture(),original=structuredClone(input.draft);
  const result=await optimizeChallenge(input);
  assert.equal(result.status,'completed');assert.equal(result.mode,'challenge');assert.ok(result.results[0].value>=result.baseline);
  assert.deepEqual(input.draft,original);assert.equal(result.optimality,'proven_within_model');
  assert.equal(result.certifiedSearch.frontier,0);
  const model=createEventEfficiency({tables:input.rules.tables,sourceReleaseId:input.rules.sourceReleaseId,eventId:1});
  const calc=createFormalSongCalculator(input.rules,input.chart,{eventAdapters:[model.challengeAdapter(input.rules)]});
  for(const r of result.results){
    assert.equal(r.orderCount,120);assert.equal(r.value,calc.calculate(r.draft).maximumScore);
    assert.deepEqual(r.draft.modifiers.growth,input.inventory.growth);
    assert.equal(new Set(r.draft.slots.map(s=>s.supportCardId)).size,5);
  }
  const ordinaryDraft=structuredClone(result.results[0].draft);delete ordinaryDraft.modifiers.event;
  assert.ok(result.results[0].value>createFormalSongCalculator(input.rules,input.chart).calculate(ordinaryDraft).maximumScore);
  assert.throws(()=>calc.upperBound(100000,2),/independently audited/);
});
test('reward bonuses cannot change the challenge high-score recommendation',async()=>{
  const input=fixture(),first=await optimizeChallenge(input);
  input.rules.tables.EventEffect.push(...[0,1].map((bonus,i)=>({_id:3+i,_eventId:1,_resourceTypeConstraint:2,_eventBonusType:bonus,
    ...Object.fromEntries([1,2,3,4,5].map(rank=>[`_rank${rank}EffectValue`,99900]))})));
  const second=await optimizeChallenge(input);
  assert.deepEqual(second.results.map(r=>[r.id,r.value]),first.results.map(r=>[r.id,r.value]));
});
test('challenge search rejects other songs, chart releases and missing actual growth',async()=>{
  const input=fixture();
  await assert.rejects(optimizeChallenge({...input,draft:{...input.draft,selectedSongId:'music-1'}}),/本期挑战歌曲/);
  await assert.rejects(optimizeChallenge({...input,chart:{...input.chart,sourceReleaseId:'global-wrong'}}),/release_mismatch/);
  await assert.rejects(optimizeChallenge({...input,inventory:{...input.inventory,growth:{}}}),/实际等级与养成/);
  const controller=new AbortController();controller.abort();
  assert.equal((await optimizeChallenge({...input,signal:controller.signal})).status,'cancelled');
});

test('saved player performance flows through challenge scoring with event power kept separate',async()=>{
  const input=fixture();
  Object.assign(input.chart,{bpmEvents:[{tick:0,bpm:125}],skillTimings:[1,2,3,4,5],feverRanges:[],
    notes:[100,200,1100,1200].map((tick,i)=>({id:`note-${i}`,type:'tap',tick,position:0,size:1}))});
  input.draft.modifiers.performanceScenario={profile:'ideal',missRate:1,samples:1};
  const result=await optimizeChallenge(input);
  assert.ok(result.results.length);
  for(const row of result.results){
    assert.equal(row.expectedScore,0);assert.equal(row.maximumScore,0);
    assert.equal(row.performanceScenario.missRate,1);
    assert.ok(row.power>0);assert.equal(row.scenario.performanceScenario.missRate,1);
  }
});

function* arrangements(values,n=values.length){
  if(!n){yield [];return;}
  for(let i=0;i<values.length;i++)for(const rest of arrangements(values.filter((_,j)=>j!==i),n-1))yield [values[i],...rest];
}

test('certified challenge optimum matches exhaustive pairings with member and support event power',async()=>{
  const input=fixture();
  Object.assign(input.chart,{bpmEvents:[{tick:0,bpm:125}],skillTimings:[1,2,3,4,5],feverRanges:[],
    notes:Array.from({length:12},(_,i)=>({id:`note-${i}`,type:'tap',tick:i*383+1}))});
  input.inventory.supportCardIds.push('support-card-6');input.inventory.growth['support-card-6']={level:1,rank:1};
  input.rules.tables.EventEffect[0]._memberCardId=3;input.rules.tables.EventEffect[1]._supportCardId=6;
  const model=createEventEfficiency({tables:input.rules.tables,sourceReleaseId:input.rules.sourceReleaseId,eventId:1});
  const calculator=createFormalSongCalculator(input.rules,input.chart,{eventAdapters:[model.challengeAdapter(input.rules)]});
  const maxima={expectedScore:0,maximumScore:0};
  for(const leader of input.inventory.memberCardIds){
    const members=input.inventory.memberCardIds.filter(id=>id!==leader);members.splice(2,0,leader);
    for(const supports of arrangements(input.inventory.supportCardIds,5)){
      const draft={...input.draft,slots:members.map((memberCardId,i)=>({memberCardId,supportCardId:supports[i]})),
        modifiers:{growth:input.inventory.growth,event:{id:1,sourceReleaseId:input.rules.sourceReleaseId}}};
      const result=calculator.calculate(draft);
      for(const key of Object.keys(maxima))maxima[key]=Math.max(maxima[key],result[key]);
    }
  }
  for(const [objective,key] of [['expected_song_score','expectedScore'],['maximum_song_score','maximumScore']]){
    const result=await optimizeChallenge({...input,objective,maxEvaluations:0});
    assert.equal(result.optimality,'proven_within_model');assert.equal(result.results[0].value,maxima[key]);
  }
});

test('full catalog reference searches beyond selected cards without claiming actual growth or gains',async()=>{
 const input=fixture();
 input.rules.tables.MemberCard=input.rules.tables.MemberCard.slice(0,6);
 input.rules.tables.SupportCard=input.rules.tables.SupportCard.slice(0,6);
 input.draft.modifiers.tgwCardRank=20;
 const original=structuredClone(input.draft);
 const result=await optimizeChallenge({...input,scope:'reference',inventory:undefined});
 assert.equal(result.searchScope,'reference');assert.equal(result.status,'completed');assert.ok(result.results.length);
 assert.equal(result.baseline,null);assert.equal(result.baselineResult,null);
 for(const row of result.results){
  assert.equal(row.delta,null);assert.equal(row.comparison,null);
  assert.equal(row.draft.modifiers.planningScenario.scope,'reference');
  assert.equal(row.draft.modifiers.planningScenario.referenceGrowth,'maximum');
  assert.equal(row.draft.modifiers.tgwCardRank,20);
  assert.ok(row.draft.modifiers.growth['member-card-6']);
  assert.ok(row.draft.modifiers.growth['support-card-6']);
  assert.equal(row.draft.modifiers.growth['member-card-6'].skillLevel,5);
  assert.equal(row.orderCount,120);
 }
 assert.deepEqual(input.draft,original);
});
