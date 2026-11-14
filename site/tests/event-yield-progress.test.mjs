import test from 'node:test';
import assert from 'node:assert/strict';
import {eventYieldWorkerProgress} from '../src/lib/event-yield-progress.mjs';
import {workerHarness,delayedFetch} from './helpers/event-yield-worker-network.mjs';
test('long proofs expose groups, leaders, live frontier and elapsed time without a false total',()=>{
 const message=eventYieldWorkerProgress({type:'progress',stage:'验证跨谱面收益上界',done:3,total:93,goal:'eventPoints',
  detail:{phase:'event-group-proof',group:2,groups:26,groupsCompleted:1,leader:7,leaderTotal:70,visited:134058,frontier:18}},1800000);
 assert.equal(message.done,3);assert.equal(message.total,93);
 assert.equal(message.label,'验证最优收益 · 已检查 134,058 个分支');
 for(const value of ['活动 pt','搜索组 2 / 26','已完成 1 组','队长 7 / 70','134,058','待检查 18','1,800 秒','仍在证明最优性'])assert.ok(message.detail.includes(value),message.detail);
 assert.ok(!message.detail.includes('/ …'));
});
test('actual worker throttles alternating proof labels as one phase and always delivers the result',async()=>{
 const {fetchImpl}=delayedFetch({delay:0,jsonDelay:0});
 const progressMessages=Array.from({length:200},(_,i)=>({type:'progress',stage:i%2?'验证跨谱面收益上界':'验证跨谱面收益第一名',
  detail:{phase:'event-group-proof',visited:i,completed:i}}));
 const {messages}=await workerHarness({count:1,fetchImpl,inputOverrides:{progressMessages}});
 const progress=messages.filter(m=>m.type==='progress');
 assert.ok(progress.length<10,`alternating labels bypassed throttling: ${progress.length}`);
 assert.equal(messages.at(-1).type,'result');
});

test('parallel goal progress keeps both proof domains visible without inventing percentages',()=>{
 const m=eventYieldWorkerProgress({stage:'event-group-proof',parallelism:2,parallelGoals:[{goal:'badges',groups:26,groupsCompleted:26,visited:1800},{goal:'eventPoints',groups:26,groupsCompleted:12,visited:3000}]},10000);
 assert.match(m.detail,/2 个计算线程/);assert.match(m.detail,/道具：26 \/ 26/);assert.match(m.detail,/活动 pt：12 \/ 26/);
 assert.doesNotMatch(m.detail,/%/);
});
