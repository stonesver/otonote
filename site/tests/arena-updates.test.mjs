import test from 'node:test';
import assert from 'node:assert/strict';
import {createContentUpdateCheck,installArenaUpdates,nextArenaDailyCheck} from '../src/lib/arena-updates.mjs';

test('pointer checks coalesce, retain pinned content and detect same-ID revisions or offline failure',async()=>{
 const root='/content/releases/'+'a'.repeat(24)+'/',pointer={schemaVersion:1,manifest:root+'manifest.json',sha256:'b'.repeat(64)};
 let reads=0,release;const pinned={root};
 const check=createContentUpdateCheck({region:'jp',pinned,pointer,fetcher:async url=>{assert.equal(url,'/content/jp/current.json');reads++;await new Promise(r=>release=r);return new Response(JSON.stringify(pointer));}});
 const a=check(),b=check();assert.equal(a,b);release();assert.equal((await a).status,'current');assert.equal(reads,1);assert.deepEqual(pinned,{root});
 const hotfix=createContentUpdateCheck({region:'global',pinned,pointer,fetcher:async()=>new Response(JSON.stringify({...pointer,sha256:'c'.repeat(64)}))});
 assert.equal((await hotfix()).status,'changed');
 const offline=createContentUpdateCheck({region:'global',pinned,fetcher:async()=>{throw Error('offline');}});assert.equal((await offline()).status,'unknown');
 const invalid=createContentUpdateCheck({region:'global',pinned,fetcher:async()=>new Response('{}')});assert.equal((await invalid()).status,'unknown');
});
test('exact boundary, background pause, recovery, periodic checks, time jump and cleanup',()=>{
 const document=new EventTarget(),window=new EventTarget();document.visibilityState='visible';
 let now=0,mono=0,boundary=1000,calls=0,checks=0,jumps=0,next=null;
 const stop=installArenaUpdates({document,window,clock:()=>now,monotonic:()=>mono,getNextBoundary:()=>boundary,
  onBoundary:()=>{calls++;boundary=Infinity;},onCheck:()=>checks++,onClockJump:()=>jumps++,
  setTimer:(fn,delay)=>{next={fn,delay};return 1;},clearTimer:()=>{next=null;}});
 assert.equal(next.delay,1001);now=1001;mono=1001;next.fn();assert.equal(calls,1);assert.equal(checks,1);
 document.visibilityState='hidden';document.dispatchEvent(new Event('visibilitychange'));assert.equal(next,null);
 now+=300000;mono+=300000;document.visibilityState='visible';document.dispatchEvent(new Event('visibilitychange'));assert.equal(checks,2);
 now+=300000;mono+=300000;next.fn();assert.equal(checks,3);
 now+=200000;next.fn();assert.equal(jumps,1);
 stop();assert.equal(next,null);window.dispatchEvent(new Event('focus'));assert.equal(next,null);
});

test('Beijing 03:00 is a check boundary, without inventing next missions',()=>{
 const boundary=Date.parse('2026-10-28T19:00:00Z');
 assert.equal(nextArenaDailyCheck(boundary-1),boundary);
 assert.equal(nextArenaDailyCheck(boundary),boundary+86400000);
});
