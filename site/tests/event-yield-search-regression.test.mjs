import test from 'node:test';
import assert from 'node:assert/strict';
import {eventYieldOracleFixture} from './helpers/event-yield-oracle-fixture.mjs';
import {optimizeEventYield} from '../src/lib/event-yield-optimizer.mjs';
import {proveEventYieldGroups} from '../src/lib/event-yield-group-proof.mjs';
import {createFormalSongCalculator} from '../../packages/scoring/scoring-rules/formal-song-score.mjs';
import {createFormalSkillResolver} from '../../packages/scoring/scoring-rules/formal-skills.mjs';
import {createOrdinaryScoreBound} from '../../packages/scoring/scoring-rules/ordinary-score-bound.mjs';
import {resolveSearchInput} from '../../packages/scoring/scoring-rules/formation-input.mjs';
import {createFormationCalculator} from '../../packages/scoring/scoring-rules/formation-power.mjs';

function fixture(){
 const f=eventYieldOracleFixture();
 f.chart.notes=Array.from({length:60},(_,i)=>({id:'n'+i,type:'tap',tick:i*480}));
 f.chart.skillTimings=[1,10,20,30,40];f.rules.tables.EventEffect=[];
 f.inventory.memberCardIds=['member-card-1','member-card-27','member-card-53','member-card-4','member-card-30'];
 f.draft.slots.forEach((slot,i)=>slot.memberCardId=f.inventory.memberCardIds[i]);
 for(const id of f.inventory.memberCardIds)f.inventory.growth[id]={level:1,rank:1,awake:1,skillLevel:1};
 f.draft.modifiers.growth=structuredClone(f.inventory.growth);
 for(const prefix of ['Live','ChallengeLive']){
  f.rules.tables[prefix+'EventPoint'].forEach(r=>r._value=r._scoreRank*100);
  f.rules.tables[prefix+'EventReward'].forEach(r=>r._resourceCount=r._scoreRank*100);
 }
 f.rules.tables.LiveScoreRank.forEach(r=>r._requiredScore=r._liveScoreRank===7?542713:(r._liveScoreRank-2)*10000);
 return {...f,mode:'ordinary',basis:'minimumScore',liveBoost:1,challengeCost:200,includeChallenge:false};
}
function* permutations(xs,n){if(!n){yield [];return;}for(let i=0;i<xs.length;i++)for(const rest of permutations(xs.filter((_,j)=>i!==j),n-1))yield [xs[i],...rest];}

test('minimum-score proof finishes without enumerating thousands of average-score false positives',async()=>{
 const f=fixture(),song=createFormalSongCalculator(f.rules,f.chart);let maxMinimum=0,count=0;
 // Independent native scoring oracle: all leaders and support pairings,
 // each scored over all 120 skill orders, with no production search/bounds.
 for(const leader of f.inventory.memberCardIds){
  const members=f.inventory.memberCardIds.filter(id=>id!==leader);members.splice(2,0,leader);
  for(const supports of permutations(f.inventory.supportCardIds,5)){
   const draft={...f.draft,slots:members.map((memberCardId,i)=>({memberCardId,supportCardId:supports[i]}))};
   maxMinimum=Math.max(maxMinimum,song.calculate(draft).minimumScore);count++;
  }
 }
 assert.equal(count,3600);assert.ok(maxMinimum<542713);
 const initial=await optimizeEventYield({...f,goal:'badges',witnessOnly:true}),controller=new AbortController();
 const result=await proveEventYieldGroups({rules:f.rules,eventId:1,input:f,candidates:[f.candidate],goal:'badges',initialRows:initial.results,
  loadChart:async()=>f.chart,getScoreCache:async()=>new Map(),signal:controller.signal,
  onProgress:p=>{if(p.visited>2000)controller.abort();}});
 assert.equal(result.proven,true,`proof still exceeds 2000 states: ${JSON.stringify(result.stats)}`);
 assert.equal(result.results[0].reward.scoreRank,6);
 assert.deepEqual(result.results[0].total,{badges:33000,eventPoints:33000});
 assert.ok(result.stats.visited<100,JSON.stringify(result.stats));
});

test('conditional minimum-score envelopes bound native scores for every pairing and forced-member subset',()=>{
 const f=fixture(),song=createFormalSongCalculator(f.rules,f.chart),power=createFormationCalculator(f.rules),resolver=createFormalSkillResolver(f.rules);
 const input=resolveSearchInput(f.rules,f.draft,{scope:'owned',inventory:f.inventory}),pairSkills=new Map();
 for(const member of f.inventory.memberCardIds)for(const support of f.inventory.supportCardIds)
  pairSkills.set(member+'|'+support,resolver({slots:[{memberCardId:member,supportCardId:support}],modifiers:f.draft.modifiers})[0]);
 const bound=createOrdinaryScoreBound({song,pairSkills,legacyFactor:Infinity,input,metric:'minimumScore',bonusConstraintBound:true});
 const threshold=542713,subsets=[[],...f.inventory.memberCardIds.map(id=>[id]),f.inventory.memberCardIds.slice(0,3),f.inventory.memberCardIds];
 const envelopes=subsets.map(ids=>bound.normalizedPowerEnvelope(threshold,ids));
 const witness=f.draft.slots.map(s=>({key:s.memberCardId+'|'+s.supportCardId,member:s.memberCardId,support:s.supportCardId}));
 const alternative=witness.map((e,i)=>({...e,support:witness[(i+1)%5].support,key:e.member+'|'+witness[(i+1)%5].support}));
 const conditions=[
  {members:f.inventory.memberCardIds,supports:[]},
  {members:[],supports:witness.map(e=>e.support)},
  {members:[f.inventory.memberCardIds[0]],supports:witness.slice(0,3).map(e=>e.support)},
 ];
 const conditional=conditions.map(c=>({...c,envelopes:[witness,alternative].map(w=>bound.normalizedPowerEnvelope(threshold,c.members,w,c.supports))}));
 let tightened=false;
 for(const supports of permutations(f.inventory.supportCardIds,5)){
  const draft={...f.draft,slots:f.inventory.memberCardIds.map((memberCardId,i)=>({memberCardId,supportCardId:supports[i]}))};
  const actual=song.calculate(draft).minimumScore/threshold,p=power.calculate(draft).total.total;
  const edges=draft.slots.map(s=>({key:s.memberCardId+'|'+s.supportCardId,member:s.memberCardId,support:s.supportCardId}));
  const values=envelopes.map(env=>p*(env.baseCoefficient+edges.reduce((sum,e)=>sum+env.gainFor(e),0)));
  for(const upper of values)assert.ok(upper>=actual,`${upper} < ${actual}`);
  for(const condition of conditional){
   if(!condition.supports.every(id=>supports.includes(id)))continue;
   const bounds=condition.envelopes.map(env=>p*(env.baseCoefficient+edges.reduce((sum,e)=>sum+env.gainFor(e),0)));
   for(const upper of [...bounds,(bounds[0]+bounds[1])/2])assert.ok(upper>=actual,`conditional order mixture: ${upper} < ${actual}`);
  }
  tightened||=values.at(-1)<values[0];
 }
 assert.equal(tightened,true,'minimum-score proof must be tighter than the mean envelope');
});
