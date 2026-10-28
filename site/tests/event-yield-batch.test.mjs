import test from 'node:test';
import assert from 'node:assert/strict';
import {runEventYieldBatch} from '../src/lib/event-yield-batch.mjs';
const candidates=Array.from({length:8},(_,i)=>({id:'c'+i,trackId:'music-'+i,seconds:10+i,level:20}));
const rules={tables:{LiveMusic:candidates.map((c,i)=>({_id:i,_musicType:1}))}};
const input={mode:'ordinary',goal:'both',searchDepth:'full',basis:'expectedScore',draft:{modifiers:{}}};
const row=(c,goal,amount=10)=>({id:c.id+goal,song:c,expectedScore:100,reward:{scoreRank:6},total:{badges:amount,eventPoints:amount}});
const result=(c,goal,{proven=false,upper=10,amount=10}={})=>({results:[row(c,goal,amount)],practical:{scoreCacheHits:0,scoreCalculations:1},certifiedSearch:{bestProven:proven,globalUpperCandidate:{scoreRank:6,total:{badges:upper,eventPoints:upper}}}});
const run=options=>runEventYieldBatch({rules,eventId:1,candidates,input,loadChart:async c=>({id:c.id}),yieldControl:async()=>{},...options});
test('global objective ceiling covers every legal chart while keeping skipped charts separate',async()=>{
 const calls=[];const output=await run({optimizer:async o=>{calls.push(o);return result(o.candidate,o.goal,{proven:true});}});
 assert.equal(output.coverageComplete,true);assert.equal(output.allProven,false);
 assert.equal(output.fullyOptimizedCharts,1);assert.equal(output.prunedCharts,7);assert.equal(calls.length,2);
 assert.ok(Object.values(output.globalProofs).every(c=>c.bestProven));
 assert.ok(calls.every(c=>c.maxEvaluations===0&&c.witnessOnly));
});
test('an unattained global vector falls back to complete individual proofs for every chart',async()=>{
 const calls=[];const output=await run({optimizer:async o=>{calls.push(o);return result(o.candidate,o.goal,{proven:!o.witnessOnly,upper:20});}});
 assert.equal(calls.length,32);assert.equal(output.coverageComplete,true);assert.equal(output.allProven,true);assert.equal(output.prunedCharts,0);
 assert.equal(new Set(calls.filter(c=>!c.witnessOnly).map(c=>c.candidate.id)).size,8);
});
test('shorter duration remains part of the global first-place objective',async()=>{
 const output=await run({candidates:[...candidates].reverse(),optimizer:async o=>result(o.candidate,o.goal,{proven:true})});
 assert.equal(output.rows[0].song.id,'c0');assert.equal(output.prunedCharts,7);
});
test('a group certificate covers the collection without claiming individual chart optima',async()=>{
 let grouped=0;const output=await run({optimizer:async o=>result(o.candidate,o.goal,{upper:20}),proveGroup:async o=>{
   grouped++;assert.equal((await o.getScoreCache(candidates[0],'ordinary',input,{})) instanceof Map,true);
   return {proven:true,results:[row(candidates[0],o.goal,15)],certificate:{proof:'independent_group_upper_bound'}};
 }});
 assert.equal(grouped,2);assert.equal(output.coverageComplete,true);assert.equal(output.fullyOptimizedCharts,0);assert.equal(output.prunedCharts,8);assert.equal(output.allProven,false);
 assert.equal(output.globalProofs.badges.proof,'independent_group_upper_bound');
});
test('quick, explicit score ties, performance scenarios and practical searches retain their own fallback',async()=>{
 for(const change of [{searchDepth:'quick'},{refineScoreTies:true},{searchMethod:'practical'},{draft:{modifiers:{performanceScenario:{}}}}]){
  const calls=[];const output=await run({input:{...input,...change},optimizer:async o=>{calls.push(o);return result(o.candidate,o.goal,{proven:true});},proveGroup:async()=>{throw Error('unsupported group');}});
  assert.ok(calls.every(c=>!c.witnessOnly));
  if(change.searchDepth==='quick'){assert.ok(calls.length<16);assert.ok(calls.every(c=>c.maxEvaluations===24));assert.equal(output.complete,false);}
 }
});
test('a failed group optimization falls back to the complete chart domain',async()=>{
 const output=await run({optimizer:async o=>result(o.candidate,o.goal,{proven:!o.witnessOnly,upper:20}),proveGroup:async()=>{throw Error('unsupported envelope');}});
 assert.equal(output.allProven,true);assert.equal(output.fullyOptimizedCharts,8);assert.equal(output.failures.length,0);
});
test('practical seeds never substitute for a complete proof or narrow the chart domain',async()=>{
 const calls=[];let seedRows=0;
 const output=await run({optimizer:async o=>{calls.push(o);return result(o.candidate,o.goal,{proven:!o.witnessOnly,upper:20});},
 proveGroup:async o=>{seedRows=o.initialRows.filter(r=>r.id).length;assert.equal(o.candidates.length,8);return {proven:false};}});
 const seeds=calls.filter(c=>c.searchMethod==='practical');assert.equal(seeds.length,12);assert.ok(seeds.every(c=>!c.witnessOnly));
 assert.ok(seedRows>=16);assert.equal(calls.filter(c=>c.searchMethod!=='practical'&&!c.witnessOnly).length,16);
 assert.equal(output.allProven,true);
});
test('failed charts cannot become a complete global certificate',async()=>{
 const output=await run({optimizer:async o=>{if(o.candidate.id==='c2')throw Error('unavailable');return result(o.candidate,o.goal,{proven:true,upper:20});}});
 assert.equal(output.coverageComplete,false);assert.equal(output.failures.length,1);assert.deepEqual(output.globalProofs,{});
});
test('cancellation preserves a legal partial result without a global proof',async()=>{
 const controller=new AbortController();
 const output=await run({signal:controller.signal,optimizer:async o=>{controller.abort();return result(o.candidate,o.goal,{upper:20});},proveGroup:async()=>{throw Error('must not start a cancelled proof');}});
 assert.equal(output.rows.length,1);assert.equal(output.coverageComplete,false);assert.equal(output.allProven,false);
 assert.deepEqual(output.globalProofs,{});assert.equal(output.failures.length,0);
});
test('challenge cycle stages keep their independent constraints and shared score cache',async()=>{
 const calls=[];const challenge={id:'challenge',trackId:'music-0',seconds:5,level:20};
 const output=await run({input:{...input,includeChallenge:true,scope:'selected',challengeScope:'owned',challengeBasis:'minimumScore'},challengeCandidates:[challenge],
 optimizer:async o=>{calls.push(o);return result(o.candidate,o.goal,{proven:true});}});
 assert.equal(calls[0].mode,'challenge');assert.equal(calls[0].scope,'owned');assert.equal(calls[0].basis,'minimumScore');
 const challengeCalls=calls.filter(o=>o.mode==='challenge');
 assert.equal(calls[0].includeChallenge,false);assert.ok(challengeCalls.every(o=>o.scoreCache===challengeCalls[0].scoreCache));
 assert.equal(calls.find(o=>o.mode==='ordinary'&&o.searchMethod!=='practical').challengeRows.length,2);assert.equal(output.coverageComplete,true);
 assert.equal(output.globalProofs.badges.scope,'all_selected_charts_given_challenge_rows');
});

test('parallel phase failures replay complete serial domains without claiming missing coverage',async()=>{
 const challenge={id:'challenge',trackId:'music-0',seconds:5,level:20},calls=[];let grouped=0;
 const output=await run({input:{...input,includeChallenge:true},challengeCandidates:[challenge],
 runChallengeJobs:async()=>{throw Error('worker crashed');},runGroupProofs:async()=>{throw Error('worker missing coverage');},
 optimizer:async o=>{calls.push(o);return result(o.candidate,o.goal,{proven:o.mode==='challenge'||!o.witnessOnly,upper:20});},
 proveGroup:async()=>{grouped++;return {proven:false};}});
 assert.equal(calls.filter(c=>c.mode==='challenge'&&c.searchMethod!=='practical').length,2);assert.equal(grouped,2);
 assert.equal(output.done,9);assert.equal(output.allProven,true);assert.equal(output.coverageComplete,true);assert.deepEqual(output.failures,[]);
});

test('parallel live improvements update candidates without prematurely certifying them',async()=>{
 const messages=[];
 const output=await run({onMessage:m=>messages.push(structuredClone(m)),optimizer:async o=>result(o.candidate,o.goal,{upper:20}),
 proveGroup:async()=>{throw Error('successful parallel proof should be used');},
 runGroupProofs:async({goals,onCandidate})=>{
  for(const goal of goals)onCandidate(goal,row(candidates[0],goal,15));
  const previews=messages.filter(m=>m.type==='partial'&&m.rows.some(r=>r.total.badges===15));
  assert.ok(previews.length);assert.ok(previews.every(m=>!m.coverageComplete&&Object.keys(m.globalProofs).length===0));
  return new Map(goals.map(goal=>[goal,{proven:true,results:[row(candidates[0],goal,15)],certificate:{bestProven:true}}]));
 }});
 assert.equal(output.coverageComplete,true);assert.equal(output.rows[0].total.badges,15);
 assert.equal(output.rows[0].search.bestProven,true);
});

test('a full challenge cycle publishes a legal income plan before waiting for challenge proofs',async()=>{
 const messages=[],calls=[],challenge={id:'challenge',trackId:'music-0',seconds:5,level:20};
 const output=await run({input:{...input,includeChallenge:true},challengeCandidates:[challenge],onMessage:m=>messages.push(structuredClone(m)),
 optimizer:async o=>{
  calls.push(o);
  if(o.mode==='challenge'&&o.searchMethod!=='practical'){
   const previews=messages.filter(m=>m.type==='partial'&&m.rows.length);
   assert.ok(previews.length,'the first legal income plan must precede the potentially unbounded challenge proof');
   assert.ok(previews.every(m=>!m.coverageComplete&&m.done===0));
  }
  return result(o.candidate,o.goal,{proven:o.searchMethod!=='practical'});
 }});
 assert.ok(calls.some(o=>o.mode==='challenge'&&o.searchMethod==='practical'));
 assert.equal(new Set(calls.filter(o=>o.mode==='ordinary'&&o.searchMethod!=='practical').map(o=>o.candidate.id)).size,1);
 assert.equal(output.coverageComplete,true);
 assert.ok(output.rows.every(r=>r.search.bestProven));
});

test('cancelling at the first income preview retains it without starting an exact challenge proof',async()=>{
 const controller=new AbortController(),calls=[];
 const output=await run({input:{...input,includeChallenge:true},challengeCandidates:[{id:'challenge',trackId:'music-0',seconds:5,level:20}],
 signal:controller.signal,onMessage:m=>{if(m.type==='partial'&&m.rows.length)controller.abort();},
 optimizer:async o=>{calls.push(o);o.onProgress?.({phase:'practical-result',bestCandidate:row(o.candidate,o.goal)});return result(o.candidate,o.goal);}});
 assert.ok(output.rows.length);assert.equal(output.done,0);assert.equal(output.coverageComplete,false);
 assert.deepEqual(output.globalProofs,{});assert.deepEqual(output.failures,[]);
 assert.ok(calls.every(o=>o.searchMethod==='practical'));
});
