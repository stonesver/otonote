import test from 'node:test';
import assert from 'node:assert/strict';
import {eventYieldOracleFixture} from './helpers/event-yield-oracle-fixture.mjs';
import {proveEventYieldGroups} from '../src/lib/event-yield-group-proof.mjs';
import {optimizeEventYield} from '../src/lib/event-yield-optimizer.mjs';
import {createFormalSongCalculator} from '../src/lib/scoring-rules/formal-song-score.mjs';
import {createEventEfficiency} from '../src/lib/scoring-rules/event-efficiency.mjs';
import {resolveTeamCardGrowth} from '../src/lib/team-card-view.mjs';
import {materializeTeamAssumptions} from '../src/lib/workbench-team-input.mjs';
function* permutations(xs,n){if(!n){yield [];return;}for(let i=0;i<xs.length;i++)for(const rest of permutations(xs.filter((_,j)=>j!==i),n-1))yield [xs[i],...rest];}
const compare=(a,b,goal)=>(goal==='grade'?b.rank-a.rank:0)||b.total[goal==='eventPoints'?'eventPoints':'badges']-a.total[goal==='eventPoints'?'eventPoints':'badges']||b.total[goal==='eventPoints'?'badges':'eventPoints']-a.total[goal==='eventPoints'?'badges':'eventPoints']||a.seconds-b.seconds;
test('cross-chart first proof matches independent 7200-team native oracle including duration and nonmonotone ranks',async()=>{
 const f=eventYieldOracleFixture(),input={...f,mode:'ordinary',basis:'expectedScore',liveBoost:1,challengeCost:200,includeChallenge:false};
 const second=structuredClone(f.chart);second.id='music-chart-90000103';second.trackId='music-900001';second.skillTimings=[.5,1.5,2.5,3.5,4.5];second.notes=second.notes.filter((_,i)=>i%3!==0);
 f.rules.tables.LiveMusicScore.push({...f.rules.tables.LiveMusicScore.find(r=>r._id===10003803),_id:90000103});
 f.rules.tables.LiveMusic.push({...f.rules.tables.LiveMusic.find(r=>r._id===100038),_id:900001});
 const candidates=[{...f.candidate,seconds:110},{...f.candidate,id:second.id,trackId:second.trackId,seconds:90}],charts=new Map([[f.chart.id,f.chart],[second.id,second]]);
 const model=createEventEfficiency({tables:f.rules.tables,sourceReleaseId:f.rules.sourceReleaseId,eventId:1}),all=[];
 for(const c of candidates){
  const calculator=createFormalSongCalculator(f.rules,charts.get(c.id)),draft=structuredClone(f.draft);draft.selectedSongId=c.trackId;draft.selectedDifficulty=c.difficulty;
  for(const leader of f.inventory.memberCardIds){const members=f.inventory.memberCardIds.filter(id=>id!==leader);members.splice(2,0,leader);
   for(const supports of permutations(f.inventory.supportCardIds,5)){
    draft.slots=members.map((memberCardId,i)=>({memberCardId,supportCardId:supports[i]}));
    const score=calculator.calculate(draft),bonuses=model.teamBonus(draft.slots.map(s=>({memberId:Number(s.memberCardId.split('-').at(-1)),supportId:Number(s.supportCardId.split('-').at(-1)),memberRank:1,supportRank:1})));
    const rank=model.scoreRank(Number(c.trackId.split('-').at(-1)),score.expectedScore),reward=model.rewards({mode:'ordinary',scoreRank:rank,...bonuses,liveBoost:1,challengeCost:200});
    all.push({rank,total:{badges:11*reward.badges,eventPoints:11*reward.eventPoints},seconds:c.seconds,score,bonuses,trackId:c.trackId});
   }
  }
 }
 assert.equal(all.length,7200);
 for(const basis of ['expectedScore','minimumScore','maximumScore'])for(const goal of ['badges','eventPoints','grade']){
  input.basis=basis;
  const exact=all.map(row=>{const rank=model.scoreRank(Number(row.trackId.split('-').at(-1)),row.score[basis]);const reward=model.rewards({mode:'ordinary',scoreRank:rank,...row.bonuses,liveBoost:1,challengeCost:200});return {...row,rank,total:{badges:11*reward.badges,eventPoints:11*reward.eventPoints}};});
  const seed=await optimizeEventYield({...input,candidate:candidates[0],chart:f.chart,goal,witnessOnly:true});
  // A legal old result with inflated totals must be re-evaluated, never
  // trusted as an incumbent that could prune the true winner.
  seed.results.forEach(row=>row.total={badges:900000000,eventPoints:800000000});
  const caches=new Map();
  const result=await proveEventYieldGroups({rules:f.rules,eventId:1,input,candidates,goal,initialRows:seed.results,loadChart:async c=>charts.get(c.id),getScoreCache:async c=>{if(!caches.has(c.id))caches.set(c.id,new Map());return caches.get(c.id);}});
  assert.equal(result.proven,true,JSON.stringify(result));
  const best=exact.toSorted((a,b)=>compare(a,b,goal))[0],actual=result.results[0];
  assert.equal(compare({rank:actual.reward.scoreRank,total:actual.total,seconds:actual.song.seconds},best,goal),0,`${basis} ${goal}`);
  assert.equal(result.certificate.coveredChartIds.length,2);
 }
});
test('cross-chart proof explicitly refuses unsupported tie refinement',async()=>{
 const f=eventYieldOracleFixture();const result=await proveEventYieldGroups({rules:f.rules,eventId:1,input:{...f,mode:'ordinary',refineScoreTies:true},candidates:[f.candidate],goal:'badges'});
 assert.equal(result.proven,false);assert.equal(result.certificate.coverageComplete,false);
});

test('cross-chart owned results keep actual growth despite a prior full-reference team',async()=>{
 const f=eventYieldOracleFixture();f.inventory.supportCardIds=f.inventory.supportCardIds.slice(0,5);
 const input={...f,mode:'ordinary',basis:'expectedScore',liveBoost:1,challengeCost:200,includeChallenge:false,
  constraints:{leaderId:'member-card-3',lockedPairs:f.draft.slots.map(s=>({...s}))}};
 input.draft.modifiers.planningScenario={scope:'reference',unknownGrowth:'reference',referenceGrowth:'maximum'};
 const before=structuredClone(input),result=await proveEventYieldGroups({rules:f.rules,eventId:1,input,candidates:[f.candidate],goal:'badges',
  initialRows:[{draft:f.draft,song:f.candidate,orderCount:120,reward:{mode:'ordinary'},total:{badges:0,eventPoints:0}}],
  loadChart:async()=>f.chart,getScoreCache:async()=>new Map()});
 assert.equal(result.proven,true,JSON.stringify(result));assert.ok(result.results.length);
 const data={rules:f.rules,...Object.fromEntries(['member','support'].map(kind=>[`${kind}Cards`,f.inventory[`${kind}CardIds`].map(id=>({id,kind}))]))};
 for(const row of result.results){
  const applied=materializeTeamAssumptions(row.draft,data,f.inventory);
  assert.deepEqual(applied.modifiers.growth,row.draft.modifiers.growth);
  for(const slot of row.draft.slots)for(const kind of ['member','support']){
   const id=slot[`${kind}CardId`];
   assert.deepEqual(resolveTeamCardGrowth({card:{id,kind},draft:row.draft,inventory:f.inventory,rules:f.rules}),{growth:f.inventory.growth[id],source:'actual'});
  }
 }
 assert.deepEqual(input,before);
});

test('equal rewards keep the faster chart in the proven first-place domain',async()=>{
 const f=eventYieldOracleFixture();f.inventory.supportCardIds=f.inventory.supportCardIds.slice(0,5);
 f.rules.tables.LiveScoreRank.forEach(r=>r._requiredScore=1);
 const chart={...structuredClone(f.chart),id:'music-chart-10003802',difficulty:'hard'};
 const short={...f.candidate,id:chart.id,difficulty:'hard',seconds:90},long={...f.candidate,seconds:110};
 const constraints={leaderId:'member-card-1',lockedPairs:f.draft.slots.map(s=>({...s}))};
 const input={...f,mode:'ordinary',basis:'expectedScore',liveBoost:1,challengeCost:200,includeChallenge:false,constraints};
 const initial=await optimizeEventYield({...input,candidate:long,goal:'badges'});
 const options={rules:f.rules,eventId:1,input,candidates:[long,short],goal:'badges',initialRows:initial.results,loadChart:async c=>c.id===short.id?chart:f.chart,getScoreCache:async()=>new Map()};
 const result=await proveEventYieldGroups(options);
 assert.equal(result.proven,true);assert.equal(result.results[0].song.id,short.id);
 assert.deepEqual(result.results[0].total,initial.results[0].total);
 const controller=new AbortController();
 const cancelled=await proveEventYieldGroups({...options,signal:controller.signal,onProgress:p=>{if(p.phase==='event-group-proof')controller.abort();}});
 assert.equal(cancelled.proven,false);assert.equal(cancelled.certificate.reason,'cancelled');
});
