import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {eventYieldOracleFixture} from './helpers/event-yield-oracle-fixture.mjs';
import {createEventYieldParallel} from '../src/lib/event-yield-parallel.mjs';
import {runEventYieldBatch} from '../src/lib/event-yield-batch.mjs';
import {proveEventYieldGroups} from '../src/lib/event-yield-group-proof.mjs';
import {optimizeEventYield} from '../src/lib/event-yield-optimizer.mjs';
const host=new URL('./helpers/browser-worker-host.mjs',import.meta.url),entry=new URL('../src/lib/event-yield-task-worker.mjs',import.meta.url).href;
function createWorker(){
 const worker=new Worker(host,{workerData:{entry}});
 return {postMessage:data=>worker.postMessage(data),terminate:()=>worker.terminate(),addEventListener:(type,fn)=>worker.on(type,data=>fn(type==='message'?{data}:data))};
}
function fixture(){
 const f=eventYieldOracleFixture();f.inventory.supportCardIds=f.inventory.supportCardIds.slice(0,5);
 const second={...structuredClone(f.chart),id:'music-chart-10003802',difficulty:'hard'};
 const charts=new Map([[f.chart.id,f.chart],[second.id,second]]);
 const candidates=[f.chart,second].map((chart,i)=>({...f.candidate,id:chart.id,difficulty:chart.difficulty,seconds:100+i,analysisDataUrl:'data:application/json,'+encodeURIComponent(JSON.stringify(chart))}));
 const input={draft:f.draft,inventory:f.inventory,scope:'owned',mode:'ordinary',basis:'expectedScore',goal:'both',searchDepth:'full',liveBoost:1,budget:11,challengeCost:200,startingCP:0,includeChallenge:true,challengeScope:'same',challengeBasis:'expectedScore'};
 return {...f,input,candidates,charts};
}
const leaders=result=>Object.fromEntries(['badges','eventPoints'].map(goal=>[goal,result.rows.filter(r=>r.recommendationGoals.includes(goal)).map(r=>[r.song.id,r.total]).sort((a,b)=>a[0].localeCompare(b[0]))]));
test('real CPU workers preserve complete cycle results for every score basis',async()=>{
 const f=fixture();
 for(const basis of ['expectedScore','minimumScore','maximumScore']){
  const input={...f.input,basis,challengeBasis:basis},options={rules:f.rules,eventId:1,input,candidates:f.candidates,challengeCandidates:f.candidates,loadChart:async c=>f.charts.get(c.id),yieldControl:async()=>{},proveGroup:proveEventYieldGroups};
  const serial=await runEventYieldBatch(options),parallel=createEventYieldParallel({...options,onMessage:()=>{},size:2,createWorker});
  try{const concurrent=await runEventYieldBatch({...options,...parallel});
   assert.deepEqual(leaders(concurrent),leaders(serial),basis);assert.equal(concurrent.coverageComplete,true);assert.equal(concurrent.allProven,true);assert.equal(concurrent.done,4);assert.deepEqual(concurrent.failures,[]);
   for(const rows of Object.values(leaders(concurrent)))assert.equal(rows.length,f.candidates.length);
  }finally{parallel.close();}
 }
});
test('real parallel group proofs cover the identical complete chart domain',async()=>{
 const f=fixture(),input={...f.input,includeChallenge:false},initialRows=[];
 for(const goal of ['badges','eventPoints'])initialRows.push(...(await optimizeEventYield({...f,...input,candidate:f.candidates[0],chart:f.chart,goal,witnessOnly:true})).results);
 const options={rules:f.rules,eventId:1,input,candidates:f.candidates,initialRows,challengeRows:[]},parallel=createEventYieldParallel({...options,onMessage:()=>{},size:2,createWorker});
 try{
  const proofs=await parallel.runGroupProofs({...options,goals:['badges','eventPoints'],done:0,total:2,individualProofs:true});
  for(const goal of ['badges','eventPoints']){
   const serial=await proveEventYieldGroups({...options,goal,individualProofs:true,loadChart:async c=>f.charts.get(c.id),getScoreCache:async()=>new Map()});
   assert.equal(proofs.get(goal).proven,true);assert.deepEqual(proofs.get(goal).results[0].total,serial.results[0].total);
   assert.equal(proofs.get(goal).results[0].song.id,serial.results[0].song.id);
   assert.deepEqual(new Set(proofs.get(goal).certificate.coveredChartIds),new Set(f.candidates.map(c=>c.id)));
   assert.equal(proofs.get(goal).certificate.perChartBestProven,true);
   for(const c of f.candidates)assert.deepEqual(proofs.get(goal).results.find(r=>r.song.id===c.id).total,serial.results.find(r=>r.song.id===c.id).total);
  }
 }finally{parallel.close();}
});
test('missing remote coverage is rejected so the batch can use serial fallback',async()=>{
 const f=fixture();
 const createWorker=()=>{const listeners={};return {addEventListener:(k,fn)=>listeners[k]=fn,terminate(){},postMessage({id}){queueMicrotask(()=>listeners.message({data:{id,type:'result',result:{proven:true,certificate:{bestProven:true,coveredChartIds:[]}}}}));}};};
 const parallel=createEventYieldParallel({rules:f.rules,eventId:1,input:f.input,onMessage:()=>{},size:2,createWorker});
 await assert.rejects(parallel.runGroupProofs({input:f.input,candidates:f.candidates,goals:['badges'],initialRows:[],challengeRows:[],done:0,total:2}),/Incomplete/);
 parallel.close();
});

function multipleContexts(){
 const f=fixture(),music=f.rules.tables.LiveMusic.find(r=>r._id===100038),score=f.rules.tables.LiveMusicScore.find(r=>r._id===10003803);
 const second={...structuredClone(f.chart),id:'music-chart-90000103',trackId:'music-900001'};
 f.rules.tables.LiveMusic.push({...music,_id:900001,_musicType:music._musicType%5+1});
 f.rules.tables.LiveMusicScore.push({...score,_id:90000103});
 f.charts=new Map([[f.chart.id,f.chart],[second.id,second]]);
 f.candidates=[f.chart,second].map((chart,i)=>({...f.candidate,id:chart.id,trackId:chart.trackId,seconds:100+i,
  analysisDataUrl:'data:application/json,'+encodeURIComponent(JSON.stringify(chart))}));
 return f;
}

test('spare workers prove separate complete music groups using rescored cross-shard seeds',async()=>{
 const f=multipleContexts(),input={...f.input,includeChallenge:false},initialRows=[];
 for(const goal of ['badges','eventPoints'])initialRows.push(...(await optimizeEventYield({...f,...input,candidate:f.candidates[0],chart:f.chart,goal,witnessOnly:true})).results);
 // Only the first shard has an original row. Every other shard must rebuild
 // that formation and prove its own charts, never reuse the source score.
 const jobs=[],spawn=()=>{const worker=createWorker();return {...worker,postMessage:data=>{if(data.task.kind==='group')jobs.push(data.task);worker.postMessage(data);}};};
 const options={rules:f.rules,eventId:1,input,candidates:f.candidates,initialRows,challengeRows:[]};
 const parallel=createEventYieldParallel({...options,onMessage:()=>{},size:4,createWorker:spawn});
 try{
  const proofs=await parallel.runGroupProofs({...options,goals:['badges','eventPoints'],done:0,total:2,individualProofs:true});
  assert.equal(jobs.length,4,'two music groups per goal must use four independent jobs');
  for(const goal of ['badges','eventPoints']){
   const serial=await proveEventYieldGroups({...options,goal,individualProofs:true,loadChart:async c=>f.charts.get(c.id),getScoreCache:async()=>new Map()});
   const actual=proofs.get(goal);assert.equal(actual.proven,true);assert.equal(actual.certificate.perChartBestProven,true);
   assert.deepEqual(new Set(actual.certificate.coveredChartIds),new Set(f.candidates.map(c=>c.id)));
   assert.equal(actual.results.length,2);assert.equal(actual.stats.groupsCompleted,2);
   for(const c of f.candidates)assert.deepEqual(actual.results.find(r=>r.song.id===c.id).total,serial.results.find(r=>r.song.id===c.id).total);
  }
 }finally{parallel.close();}
});

test('a shard cannot claim charts outside its assigned proof domain',async()=>{
 const f=multipleContexts(),ids=f.candidates.map(c=>c.id);
 const spawn=()=>{const listeners={};return {addEventListener:(k,fn)=>listeners[k]=fn,terminate(){},postMessage({id}){
  queueMicrotask(()=>listeners.message({data:{id,type:'result',result:{proven:true,certificate:{bestProven:true,perChartBestProven:true,coveredChartIds:ids},results:ids.map(id=>({song:{id}}))}}}));
 }};};
 const parallel=createEventYieldParallel({rules:f.rules,eventId:1,input:f.input,onMessage:()=>{},size:4,createWorker:spawn});
 try{await assert.rejects(parallel.runGroupProofs({input:f.input,candidates:f.candidates,goals:['badges','eventPoints'],initialRows:[],challengeRows:[],done:0,total:2,individualProofs:true}),/Incomplete/);}
 finally{parallel.close();}
});
