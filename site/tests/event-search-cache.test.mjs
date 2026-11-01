import test from 'node:test';
import assert from 'node:assert/strict';
import {eventSearchPartition,bindEventScoreCache,createEventScoreCacheBinding,createEventSearchStore,searchDigest,EVENT_SEARCH_VERSION} from '../src/lib/event-search-cache.mjs';
import {planEventSearch} from '../src/lib/event-search-plan.mjs';

test('persistent partition ignores yield knobs but isolates personal data, events and rules',async()=>{
 const rules={sourceReleaseId:'global',tables:{test:[1]}},input={draft:{selectedSongId:'a',selectedDifficulty:'expert',slots:[1],modifiers:{growth:{a:1}}},inventory:{memberCardIds:[1]},scope:'owned'};
 const key=await eventSearchPartition(rules,1,input);
 assert.equal(await eventSearchPartition(rules,1,{...input,goal:'grade',budget:100,basis:'minimumScore',eco:false,searchDepth:'full',draft:{...input.draft,selectedSongId:'b',selectedDifficulty:'easy'}}),key);
 for(const changed of [{...input,inventory:{memberCardIds:[2]}},{...input,draft:{...input.draft,slots:[2]}},{...input,draft:{...input.draft,modifiers:{growth:{a:2}}}},{...input,scope:'selected'}])assert.notEqual(await eventSearchPartition(rules,1,changed),key);
 assert.notEqual(await eventSearchPartition(rules,2,input),key);
 assert.notEqual(await eventSearchPartition({...rules,tables:{test:[2]}},1,input),key);
 assert.notEqual(await eventSearchPartition({...rules,sourceReleaseId:'jp'},1,input),key);
});
test('raw score binding invalidates chart, growth, difficulty, event and rule changes',async()=>{
 const args={rules:{tables:{a:1}},chart:{id:'one',notes:[1]},draft:{slots:[1],selectedDifficulty:'expert',modifiers:{growth:{a:1}}}};
 const cache=new Map();await bindEventScoreCache(cache,args);cache.set('score',100);
 await bindEventScoreCache(cache,args);assert.equal(cache.get('score'),100);
 for(const changed of [{...args,chart:{...args.chart,notes:[2]}},{...args,draft:{...args.draft,selectedDifficulty:'easy'}},{...args,draft:{...args.draft,modifiers:{event:{id:1}}}},{...args,draft:{...args.draft,modifiers:{growth:{a:2}}}},{...args,rules:{tables:{a:2}}}]){
  await bindEventScoreCache(cache,args);cache.set('score',100);await bindEventScoreCache(cache,changed);assert.equal(cache.has('score'),false);
 }
});
test('a chart job hashes its frozen context once but checks cache ownership on every access',async()=>{
 let serialized=0;
 const rules={tables:{}},draft={slots:[]},chart={toJSON(){serialized++;return {id:'one',notes:[1]};}};
 const bind=await createEventScoreCacheBinding({rules,chart,draft}),cache=new Map();
 bind(cache);cache.set('score',100);
 for(let i=0;i<100;i++)bind(cache);
 assert.equal(serialized,1);assert.equal(cache.get('score'),100);
 const other=await createEventScoreCacheBinding({rules,chart:{id:'two',notes:[2]},draft});
 other(cache);assert.equal(cache.has('score'),false);cache.set('score',200);
 bind(cache);assert.equal(cache.has('score'),false);assert.equal(serialized,1);
});
test('scores cached before model versioning are not reused with unchanged chart and Master data',async()=>{
 const args={rules:{tables:{a:1}},chart:{id:'one',notes:[1]},draft:{slots:[1]}};
 const legacy=await searchDigest({version:EVENT_SEARCH_VERSION,rules:await searchDigest(args.rules),chart:args.chart,draft:args.draft});
 const cache=new Map([['$context',legacy],['old-score',5925023]]);
 await bindEventScoreCache(cache,args);
 assert.equal(cache.has('old-score'),false);assert.notEqual(cache.get('$context'),legacy);
});
test('unavailable or refused local storage is a cache miss, not a failed calculation',async()=>{
 for(const indexedDB of [null,{open(){throw Error('denied');}}]){
  const store=createEventSearchStore({indexedDB});assert.equal(await store.get('key'),null);assert.equal(await store.put('key',[1]),false);
 }
});
test('quick charts respect the original filters and full search preserves every chart exactly once',()=>{
 const candidates=Array.from({length:20},(_,i)=>({id:'chart-'+i,trackId:'music-'+i,difficulty:'expert',level:20+i%8,seconds:100+i}));
 const rules={tables:{LiveMusic:candidates.map((c,i)=>({_id:i,_musicType:i%5}))}},draft={selectedSongId:'music-18',selectedDifficulty:'expert'};
 const plan=planEventSearch(candidates,rules,draft);
 assert.equal(plan.quick.length,6);assert.equal(plan.quick[0].trackId,'music-18');
 assert.equal(new Set(plan.full.map(c=>c.id)).size,20);assert.deepEqual([...plan.full].sort((a,b)=>a.id.localeCompare(b.id)),[...candidates].sort((a,b)=>a.id.localeCompare(b.id)));
 assert.equal(planEventSearch(candidates.slice(0,1),rules,draft).quick.length,1);
 assert.equal(planEventSearch([],rules,draft).full.length,0);
});
