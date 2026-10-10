import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {SearchQueue} from '../src/lib/scoring-rules/search-queue.mjs';
import {optimizerReadiness,recommendedWorkerCount} from '../src/lib/optimizer-guidance.mjs';
import {createFormationWorkerPool} from '../src/lib/formation-worker-pool.mjs';
import {createCandidateEvaluator} from '../src/lib/formation-candidate-evaluator.mjs';
import {optimizeInventory} from '../src/lib/inventory-optimizer.mjs';
import {createTeamDraft} from '../src/lib/team-draft.mjs';
const rules=JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json',import.meta.url)));
const original={id:'music-chart-10000103',trackId:'music-100001',difficulty:'expert',sourceReleaseId:rules.sourceReleaseId};
const chart={...original,feverRanges:[],bpmEvents:[{tick:0,bpm:125}],skillTimings:[0,1,2,3,4],notes:[0,10,500,1000,1010,2000,5000].map((tick,i)=>({id:`batch${i}`,type:'tap',tick}))};
const draft=()=>createTeamDraft({slots:[1,2,3,4,5].map(i=>({memberCardId:`member-card-${i}`,supportCardId:`support-card-${i}`})),selectedSongId:chart.trackId,selectedDifficulty:chart.difficulty});
const context={rules,chart,mode:'ordinary',objective:'expected_song_score'};
class BrowserWorkerAdapter {
 constructor(){this.worker=new Worker(new URL('./helpers/browser-worker-host.mjs',import.meta.url),{workerData:{entry:new URL('../src/lib/formation-evaluation-worker.mjs',import.meta.url).href}});this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.(error));}
 postMessage(value){this.worker.postMessage(value);} terminate(){this.worker.terminate();}
}
test('heap ordering matches sorted exhaustive order through interleaved push/pop',()=>{
 const compare=(a,b)=>b.priority-a.priority||a.id-b.id, queue=new SearchQueue([],compare), expected=[];
 for(let i=0;i<200;i++){const value={priority:(i*31)%97,id:i};queue.push(value);expected.push(value);if(i%3===0){expected.sort(compare);assert.deepEqual(queue.pop(),expected.shift());}}
 expected.sort(compare);assert.deepEqual(queue.snapshot().sort(compare),expected);while(expected.length)assert.deepEqual(queue.pop(),expected.shift());assert.equal(queue.length,0);
});
test('guide distinguishes missing song, selected cards, owned cards and full inventory',()=>{
 const d=createTeamDraft();assert.equal(optimizerReadiness({draft:d}).songReady,false);
 d.selectedSongId=chart.trackId;d.selectedDifficulty=chart.difficulty;
 assert.equal(optimizerReadiness({draft:d}).ready,false);assert.equal(optimizerReadiness({draft:d,scope:'theoretical'}).ready,true);
 assert.equal(optimizerReadiness({draft:d,scope:'owned',inventory:{memberCardIds:[1],supportCardIds:[]}}).cardsReady,false);
 assert.equal(optimizerReadiness({draft:draft()}).ready,true);
 assert.equal(optimizerReadiness({draft:draft(),characterFor:()=>1}).ready,false);
 const duplicate=draft();duplicate.slots[1].supportCardId=duplicate.slots[0].supportCardId;assert.equal(optimizerReadiness({draft:duplicate}).ready,false);
 assert.deepEqual([undefined,1,2,4,8,32].map(recommendedWorkerCount),[1,1,1,2,4,4]);
});
test('persistent worker batch returns the same exact scores as local evaluation',async()=>{
 const evaluator=createCandidateEvaluator(context),pool=await createFormationWorkerPool(context,2,{createWorker:()=>new BrowserWorkerAdapter()});
 try {const a=draft(),b=draft();[b.slots[0],b.slots[2]]=[b.slots[2],b.slots[0]];
   const actual=await pool.evaluateBatch([a,b]);assert.deepEqual(actual,await Promise.all([a,b].map(d=>evaluator.evaluate(d))));
   assert.deepEqual(await pool.evaluateBatch([b]),[await evaluator.evaluate(b)]);
 }finally{pool.close();}
});
test('batched frontier and resumed budget converge to the serial exhaustive optimum',async()=>{
 const evaluator=createCandidateEvaluator(context),opts={...context,draft:draft(),maxEvaluations:0,topN:5,yieldControl:async()=>{}};
 const serial=await optimizeInventory(opts);
 const evaluateBatch=ds=>Promise.all(ds.map(d=>evaluator.evaluate(d)));
 // A one-candidate budget cannot fill a top-five result, even when the tighter
 // homogeneous-skill bound now proves the old seven-candidate fixture early.
 const partial=await optimizeInventory({...opts,batchSize:4,evaluateBatch,maxEvaluations:1});assert.equal(partial.evaluated,1);assert.equal(partial.optimality,'incomplete');
 const resumed=await optimizeInventory({...opts,batchSize:4,evaluateBatch,checkpoint:partial.checkpoint});
 assert.equal(resumed.optimality,'proven_within_model');assert.deepEqual(resumed.results.map(r=>r.value),serial.results.map(r=>r.value));
});
test('aborted batches retain every unresolved state; pool init failure cleans up workers',async()=>{
 const controller=new AbortController();const partial=await optimizeInventory({...context,draft:draft(),batchSize:4,yieldControl:async()=>{},signal:controller.signal,
   evaluateBatch:async ds=>{controller.abort();return ds.map(()=>null);}});
 assert.equal(partial.evaluated,0);assert.equal(partial.status,'cancelled');assert.equal(partial.checkpoint.frontier.length,5);
 let closed=0;await assert.rejects(createFormationWorkerPool(context,2,{createWorker:()=>({terminate(){closed++;},postMessage(){queueMicrotask(()=>this.onmessage({data:{type:'error',error:'init failed'}}));}})}),/init failed/);assert.equal(closed,2);
});
