import test from 'node:test';
import assert from 'node:assert/strict';
import {createCalculationScheduler} from '../src/lib/calculation-scheduler.mjs';
test('full speed spends at least 90 percent of slices computing even with a 4 ms timer clamp',async()=>{
 let time=0,waited=0,pauses=0;
 const yieldControl=createCalculationScheduler({eco:false,now:()=>time,sleep:async()=>{waited+=4;time+=4;pauses++;}});
 for(let i=0;i<240;i++){time++;await yieldControl();}
 assert.ok(pauses>0,'must still service the event loop');assert.ok(pauses<=5,`too many timer waits: ${pauses}`);
 assert.ok(240/(240+waited)>=.9);
});
test('eco keeps short slices and proportional rest',async()=>{
 let time=0;const waits=[];
 const yieldControl=createCalculationScheduler({eco:true,now:()=>time,sleep:async ms=>{waits.push(ms);time+=ms;}});
 time=12;await yieldControl();assert.deepEqual(waits,[24]);
 time+=11;await yieldControl();assert.deepEqual(waits,[24]);
});

test('omitting eco uses full speed but continues to yield',async()=>{
 let time=0;const waits=[];
 const yieldControl=createCalculationScheduler({now:()=>time,sleep:async ms=>waits.push(ms)});
 time=12;await yieldControl();assert.deepEqual(waits,[]);
 time=48;await yieldControl();assert.deepEqual(waits,[0]);
});
