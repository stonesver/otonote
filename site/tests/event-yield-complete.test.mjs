import test from 'node:test';
import assert from 'node:assert/strict';
import {runEventYieldBatch} from '../src/lib/event-yield-batch.mjs';

const candidates=Array.from({length:13},(_,i)=>({id:`chart-${i}`,trackId:`music-${i}`,seconds:90+i,level:25}));
const rules={tables:{LiveMusic:candidates.map((c,i)=>({_id:i,_musicType:1}))}};
const input={mode:'ordinary',goal:'both',searchDepth:'full',basis:'expectedScore',draft:{modifiers:{}}};
const result=(candidate,goal,proven=true)=>({
 results:[{id:`team-${goal}`,song:candidate,expectedScore:100,reward:{scoreRank:proven?5:4},
  total:{badges:proven?1000-Number(candidate.id.split('-').at(-1)):100,eventPoints:100}}],
 practical:{scoreCacheHits:0,scoreCalculations:1},
 certifiedSearch:{bestProven:proven,globalUpperCandidate:{scoreRank:5,total:{badges:1000,eventPoints:100}}}
});
const run=options=>runEventYieldBatch({rules,eventId:1,candidates,input,loadChart:async c=>({id:c.id}),yieldControl:async()=>{},...options});

test('full comparison proves and retains every chart for both goals, even below the global winner',async()=>{
 const calls=[];
 const output=await run({optimizer:async o=>{calls.push(o);return result(o.candidate,o.goal,!o.witnessOnly);},
  proveGroup:async()=>{throw Error('a global first-place proof cannot replace individual results');}});
 assert.equal(output.allProven,true);
 assert.equal(output.fullyOptimizedCharts,candidates.length);
 assert.equal(output.prunedCharts,0);
 for(const goal of ['badges','eventPoints']){
  const rows=output.rows.filter(r=>r.recommendationGoals.includes(goal));
  assert.deepEqual(new Set(rows.map(r=>r.song.id)),new Set(candidates.map(c=>c.id)));
  assert.ok(rows.every(r=>r.reward.scoreRank===5&&r.search.bestProven));
  assert.equal(calls.filter(c=>c.goal===goal&&!c.witnessOnly&&c.searchMethod!=='practical').length,candidates.length);
 }
});

test('unfinished challenge proofs prevent a complete cycle certificate',async()=>{
 const challenge={...candidates[0],id:'challenge'};
 const output=await run({input:{...input,includeChallenge:true},challengeCandidates:[challenge],
  optimizer:async o=>result(o.candidate,o.goal,o.mode!=='challenge')});
 assert.equal(output.coverageComplete,false);
 assert.equal(output.allProven,false);
 assert.deepEqual(output.globalProofs,{});
});

test('an incomplete goal or failed chart never becomes a complete per-chart result set',async()=>{
 for(const failure of ['incomplete','throw']){
  const output=await run({optimizer:async o=>{
   if(o.candidate.id==='chart-12'&&o.goal==='eventPoints'){
    if(failure==='throw')throw Error('chart unavailable');
    return result(o.candidate,o.goal,false);
   }
   return result(o.candidate,o.goal);
  }});
  assert.equal(output.complete,false);
  assert.equal(output.allProven,false);
 }
});

test('a global-only group certificate cannot bypass the per-chart fallback',async()=>{
 const exact=[];
 const output=await run({optimizer:async o=>{
  const proven=!o.witnessOnly&&o.searchMethod!=='practical';
  if(proven)exact.push(o.candidate.id+':'+o.goal);
  return result(o.candidate,o.goal,proven);
 },proveGroup:async({goal})=>({proven:true,certificate:{bestProven:true,coveredChartIds:candidates.map(c=>c.id)},
  results:result(candidates[0],goal).results})});
 assert.equal(output.allProven,true);
 assert.equal(exact.length,candidates.length*2);
 assert.equal(new Set(output.rows.map(r=>r.song.id)).size,candidates.length);
});

test('parallel witness rows remain seeds until all per-chart proofs finish',async()=>{
 const messages=[],calls=[];let witnessJobs=0;
 const output=await run({onMessage:m=>messages.push(structuredClone(m)),optimizer:async o=>{calls.push(o);return result(o.candidate,o.goal);},
  runWitnessJobs:async({candidates:selected})=>{
   witnessJobs++;assert.deepEqual(selected,candidates);
   return selected.flatMap(c=>['badges','eventPoints'].map(goal=>({candidateId:c.id,goal,result:result(c,goal)})));
  },proveGroup:async({goal,candidates:selected,initialRows})=>{
   assert.deepEqual(selected,candidates);assert.ok(initialRows.length>candidates.length*2,'representative seeds retain the earlier per-chart witnesses');
   assert.ok(messages.filter(m=>m.type==='partial').every(m=>m.done===0&&!m.complete));
   return {proven:true,results:selected.flatMap(c=>result(c,goal).results),
    certificate:{bestProven:true,perChartBestProven:true,coveredChartIds:selected.map(c=>c.id)}};
  }});
 assert.equal(witnessJobs,1);assert.ok(calls.every(c=>!c.witnessOnly));
 assert.equal(output.allProven,true);assert.equal(output.fullyOptimizedCharts,candidates.length);
 assert.equal(output.prunedCharts,0);assert.deepEqual(output.failures,[]);
});

test('a failed witness worker falls back to the original complete seed and proof domains',async()=>{
 const calls=[];
 const output=await run({runWitnessJobs:async()=>{throw Error('worker failed');},
  optimizer:async o=>{calls.push(o);return result(o.candidate,o.goal,!o.witnessOnly&&o.searchMethod!=='practical');},
  proveGroup:async()=>({proven:false})});
 for(const goal of ['badges','eventPoints']){
  assert.equal(calls.filter(c=>c.goal===goal&&c.witnessOnly).length,candidates.length);
  assert.equal(calls.filter(c=>c.goal===goal&&!c.witnessOnly&&c.searchMethod!=='practical').length,candidates.length);
 }
 assert.equal(output.allProven,true);assert.deepEqual(output.failures,[]);
});
