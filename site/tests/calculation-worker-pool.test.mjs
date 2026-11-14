import test from 'node:test';
import assert from 'node:assert/strict';
import {createCalculationWorkerPool,eventYieldParallelism} from '../src/lib/calculation-worker-pool.mjs';
class WorkerStub{
 constructor(){this.listeners={};this.requests=[];}
 addEventListener(k,fn){this.listeners[k]=fn;}
 postMessage(v){this.requests.push(v);}
 terminate(){this.terminated=true;}
 reply(result){this.listeners.message({data:{id:this.requests.at(-1).id,type:'result',result}});}
}
test('complete search uses a bounded hardware budget; limited internal jobs stay serial',()=>{
 const full={searchDepth:'full'};
 assert.equal(eventYieldParallelism(full,{cores:16,memory:8}),4);
 assert.equal(eventYieldParallelism(full,{cores:10,memory:32}),8);
 assert.equal(eventYieldParallelism(full,{cores:10,memory:16}),6);
 assert.equal(eventYieldParallelism(full,{cores:4,memory:32}),3);
 assert.equal(eventYieldParallelism(full,{cores:16,memory:4}),2);
 assert.equal(eventYieldParallelism(full,{cores:16}),4);
 assert.equal(eventYieldParallelism(full,{cores:8}),4);
 assert.equal(eventYieldParallelism(full,{cores:4}),2);
 assert.equal(eventYieldParallelism(full,{cores:2,memory:8}),1);
 assert.equal(eventYieldParallelism(full,{cores:NaN,memory:8}),1);
 assert.equal(eventYieldParallelism({...full,searchDepth:'quick'},{cores:16,memory:8}),1);
});
test('bounded workers keep job identities across out-of-order results and progress',async()=>{
 const workers=[],progress=[],pool=createCalculationWorkerPool({size:2,createWorker:()=>{const w=new WorkerStub();workers.push(w);return w;}});
 const jobs=[0,1,2,3].map(i=>pool.run({i},p=>progress.push([i,p])));
 assert.equal(workers.length,2);assert.equal(workers[0].requests.length,1);
 workers[1].listeners.message({data:{id:2,type:'progress',progress:7}});assert.deepEqual(progress,[[1,7]]);
 workers[1].reply('b');workers[1].reply('c');workers[0].reply('a');workers[1].reply('d');
 assert.deepEqual(await Promise.all(jobs),['a','b','c','d']);pool.close();assert.ok(workers.every(w=>w.terminated));
});
test('a worker crash rejects active and queued work instead of losing search coverage',async()=>{
 const workers=[],pool=createCalculationWorkerPool({size:2,createWorker:()=>{const w=new WorkerStub();workers.push(w);return w;}});
 const jobs=Promise.allSettled([0,1,2,3].map(i=>pool.run({i})));
 workers[0].listeners.error();assert.ok((await jobs).every(r=>r.status==='rejected'));assert.ok(workers.every(w=>w.terminated));
 await assert.rejects(pool.run({i:4}));
});
test('cancellation rejects queued work and ignores late progress/results',async()=>{
 const worker=new WorkerStub(),pool=createCalculationWorkerPool({size:1,createWorker:()=>worker});let progress=0;
 const pending=Promise.allSettled([pool.run({},()=>progress++),pool.run({})]);pool.close();
 worker.listeners.message({data:{id:1,type:'progress'}});worker.reply('late');
 assert.equal(progress,0);assert.ok((await pending).every(r=>r.status==='rejected'));
});
