import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {fixture} from './fixtures/gekisou-skill-fixture.mjs';
import {runPlaylistTeamBatch} from '../src/lib/playlist-team-batch.ts';
const candidates=[1,2,3].map(i=>({id:`c${i}`,trackId:`music-${i}`,title:`song ${i}`,difficulty:'expert',analysisDataUrl:`/${i}`}));
const payload={draft:{slots:[],modifiers:{}},rules:{sourceReleaseId:'test'},objective:'expected_song_score',calculationScope:{title:'test'}};
test('each chart receives independent draft and only requested charts load',async()=>{
 const loads=[],drafts=[],partials=[];const r=await runPlaylistTeamBatch({candidates:candidates.slice(0,2),payload,loadChart:async c=>{loads.push(c.id);return {};},optimize:async o=>{drafts.push(o.draft);return {status:'completed',results:[{draft:o.draft}]};},onPartial:r=>partials.push(r)});
 assert.deepEqual(loads,['c1','c2']);assert.deepEqual(drafts.map(d=>d.selectedSongId),['music-1','music-2']);assert.notEqual(drafts[0],drafts[1]);assert.equal(payload.draft.selectedSongId,undefined);assert.equal(r.coverageComplete,true);assert.equal(r.optimality,'per_chart_results_only');assert.deepEqual(partials.map(p=>p.done),[1,2]);
});
test('failed chart stays visible and is never substituted with a different chart',async()=>{
 const r=await runPlaylistTeamBatch({candidates,payload,loadChart:async c=>{if(c.id==='c2')throw Error('network');return {};},optimize:async()=>({status:'completed',results:[]})});assert.equal(r.rows.length,2);assert.equal(r.failures[0].id,'c2');assert.equal(r.coverageComplete,false);
});
test('cancel during load prevents optimize and all later loads; completed charts survive',async()=>{
 const controller=new AbortController(),loaded=[];const r=await runPlaylistTeamBatch({candidates,payload,signal:controller.signal,loadChart:async c=>{loaded.push(c.id);if(c.id==='c2')controller.abort();return {};},optimize:async()=>({status:'completed',results:[]})});assert.deepEqual(loaded,['c1','c2']);assert.equal(r.rows.length,1);assert.equal(r.status,'cancelled');assert.equal(r.coverageComplete,false);
});
test('empty and duplicate domains fail before expensive work',async()=>{
 await assert.rejects(runPlaylistTeamBatch({candidates:[],payload}),/范围为空/);await assert.rejects(runPlaylistTeamBatch({candidates:[candidates[0],candidates[0]],payload}),/重复/);
});

class ControlledWorker {
 constructor(){this.listeners={};this.jobs=[];}
 addEventListener(type,listener){this.listeners[type]=listener;}
 postMessage(job){this.jobs.push(job);}
 terminate(){this.terminated=true;}
 complete(){const {id,task}=this.jobs.at(-1);this.listeners.message({data:{id,type:'result',result:{status:'completed',results:[{draft:task.draft}]}}});}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('parallel charts cap active work and retain input order despite out-of-order completion',async()=>{
 const workers=[],loads=[],partials=[];
 const pending=runPlaylistTeamBatch({candidates,payload:{...payload,playlistCandidates:candidates},concurrency:8,
  createWorker:()=>{const w=new ControlledWorker();workers.push(w);return w;},
  loadChart:async c=>{loads.push(c.id);return {};},onPartial:r=>partials.push(r)});
 await tick();assert.equal(workers.length,2);assert.deepEqual(loads,['c1','c2']);
 assert.equal(workers[0].jobs[0].task.playlistCandidates,undefined);
 assert.equal(workers[0].jobs[0].task.concurrency,1);
 workers[1].complete();await tick();assert.deepEqual(loads,['c1','c2','c3']);
 workers[1].complete();workers[0].complete();const result=await pending;
 assert.deepEqual(result.rows.map(r=>r.candidate.id),['c1','c2','c3']);
 assert.deepEqual(partials.map(r=>r.done),[1,2,3]);assert.equal(result.coverageComplete,true);
 assert.ok(workers.every(w=>w.terminated));
});
test('parallel cancellation terminates in-flight work and retains completed charts',async()=>{
 const workers=[],loads=[],controller=new AbortController();
 const pending=runPlaylistTeamBatch({candidates,payload,concurrency:2,signal:controller.signal,
  createWorker:()=>{const w=new ControlledWorker();workers.push(w);return w;},loadChart:async c=>{loads.push(c.id);return {};},
  onPartial:()=>controller.abort()});
 await tick();workers[1].complete();const result=await pending;
 assert.equal(result.status,'cancelled');assert.equal(result.coverageComplete,false);
 assert.deepEqual(result.rows.map(r=>r.candidate.id),['c2']);assert.deepEqual(loads,['c1','c2']);
 assert.ok(workers.every(w=>w.terminated));
 workers[0].complete();assert.equal(result.rows.length,1);
});
test('worker failure retries unfinished charts serially without losing completed work',async()=>{
 const workers=[],serial=[],loads=[],progress=[];
 const pending=runPlaylistTeamBatch({candidates,payload,concurrency:2,
  createWorker:()=>{const w=new ControlledWorker();workers.push(w);return w;},loadChart:async c=>{loads.push(c.id);return {};},
  onProgress:p=>progress.push(p),optimize:async o=>{serial.push(o.draft.selectedSongId);return {status:'completed',results:[]};}});
 await tick();workers[1].complete();await tick();workers[0].listeners.error();
 const result=await pending;
 assert.deepEqual(serial,['music-1','music-3']);assert.deepEqual(loads,['c1','c2','c3']);
 assert.deepEqual(result.rows.map(r=>r.candidate.id),['c1','c2','c3']);assert.equal(result.coverageComplete,true);
 assert.equal(progress.filter(p=>p.phase==='fallback').length,1);
});

test('real chart workers reproduce serial scores, LUCK samples and growth comparisons',async()=>{
 const {rules,chart,draft}=fixture({missions:[1,2,3]});
 draft.modifiers.growth=Object.fromEntries(draft.slots.flatMap(s=>[
  [s.memberCardId,{level:1,rank:1,awake:1,skillLevel:1,gekisouSkillLevel:1}],
  [s.supportCardId,{level:1,rank:1}],
 ]));
 const second={...chart,id:'music-chart-10000203',trackId:'music-100002'};
 const third={...chart,id:'music-chart-10000303',trackId:'music-100003'};
 const charts=[chart,second,third],options={candidates:charts.map(c=>({id:c.id,trackId:c.trackId,difficulty:c.difficulty})),
  payload:{rules,draft,planningScenario:{scope:'selected'},mode:'gekisou',objective:'expected_song_score',
   performanceScenario:{profile:'steady',samples:1,seed:42},gekisouScenario:{ranks:[1,1,1],batches:1},
   constraints:{leaderId:draft.slots[2].memberCardId,lockedPairs:draft.slots}},
  loadChart:async c=>charts.find(chart=>chart.id===c.id)};
 const serial=await runPlaylistTeamBatch(options);
 let workers=0;
 const parallel=await runPlaylistTeamBatch({...options,concurrency:2,createWorker:()=>{
  workers++;const worker=new Worker(new URL('./helpers/browser-worker-host.mjs',import.meta.url),{
   workerData:{entry:new URL('../src/lib/playlist-team-task-worker.mjs',import.meta.url).href}});
  return {postMessage:data=>worker.postMessage(data),terminate:()=>worker.terminate(),
   addEventListener:(type,handler)=>worker.on(type,type==='message'?data=>handler({data}):handler)};
 }});
 assert.equal(workers,3);assert.equal(parallel.coverageComplete,true);assert.deepEqual(parallel,serial);
 for(const row of parallel.rows)for(const team of row.result.results)assert.equal(team.value,team.planning.plannedTeamCurrentValue);
});
