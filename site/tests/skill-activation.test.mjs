import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFormalSongCalculator} from '../../packages/scoring/scoring-rules/formal-song-score.mjs';
import {createGekisouSongCalculator} from '../../packages/scoring/scoring-rules/gekisou-song-score.mjs';
import {createPerformanceSongCalculator,createPerformanceTemplate} from '../../packages/scoring/scoring-rules/formal-performance-replay.mjs';
import {calculateSongSkillReplay} from '../src/lib/song-skill-replay.mjs';
import {activationRows,noteDensity,createReplayClock} from '../src/lib/skill-activation-model.mjs';
const rules=JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json',import.meta.url)));
const chart={id:'music-chart-10000103',trackId:'music-100001',difficulty:'expert',sourceReleaseId:rules.sourceReleaseId,
  bpmEvents:[{tick:0,bpm:125}],skillTimings:[1,3,5,7,9],duration:15,gekisouRanges:[{start:0,end:4},{start:5,end:9},{start:10,end:14}],
  notes:Array.from({length:70},(_,i)=>({id:`tap-${i}`,type:'tap',tick:i*200,position:0,size:6}))};
const draft={selectedSongId:chart.trackId,selectedDifficulty:chart.difficulty,slots:[1,2,3,4,5].map(i=>({memberCardId:`member-card-${i}`,supportCardId:`support-card-${i}`})),modifiers:{}};

test('optional ordinary traces reproduce both extrema without changing score results',()=>{
 const calculator=createFormalSongCalculator(rules,chart),plain=calculator.calculate(draft),detailed=calculator.calculate(draft,{includeTrace:true});
 assert.equal(plain.skillPlayback,undefined);assert.equal(plain.expectedScore,detailed.expectedScore);assert.deepEqual(plain.scoreDistribution,detailed.scoreDistribution);
 for(const [i,key] of ['maximumScore','minimumScore'].entries()){
   const variant=detailed.skillPlayback.variants[i];assert.equal(variant.score,plain[key]);
   assert.equal(variant.notes.reduce((s,n)=>s+n.score,0)+variant.fixedScore,variant.score);
   const clock=createReplayClock(detailed.skillPlayback,variant);assert.equal(clock.at(clock.duration).score,variant.score);
   assert.equal(activationRows(detailed.skillPlayback,variant).length,5);
 }
});
test('coverage uses half-open windows, counts overlap once and excludes inactive skills',()=>{
 const skills=Array.from({length:5},(_,slotIndex)=>({slotIndex,liveEffects:[]}));
 const commands=[{timeMs:100,ownerId:1,general:.5},{timeMs:300,ownerId:1,general:-.5},{timeMs:200,ownerId:1,perfect:.3},{timeMs:400,ownerId:1,perfect:-.3}];
 const notes=[99,100,199,200,299,300,399,400].map(timeMs=>({timeMs}));
 const playback={skills,skillTimes:[100,500,600,700,800]},variant={order:[0,1,2,3,4],commands,notes};
 const rows=activationRows(playback,variant);assert.deepEqual(rows[0].covered.map(n=>n.timeMs),[100,199,200,299,300,399]);assert.equal(rows[1].covered.length,0);
 assert.equal(noteDensity(notes,400).reduce((a,b)=>a+b,0),notes.length);
});
test('ranking exact profiles retain matching highest and lowest traces including zero effects',()=>{
 for(const percent of [0,130]){
   const result=calculateSongSkillReplay({rules,chart,skills:[1,2,3,4,5].map(i=>({percent:percent*i,seconds:5})),includeTrace:true});
   assert.equal(result.skillPlayback.variants[0].score,result.distribution.maximum);assert.equal(result.skillPlayback.variants[1].score,result.distribution.minimum);
   if(!percent)assert.ok(activationRows(result.skillPlayback,result.skillPlayback.variants[0]).every(r=>!r.windows.length));
 }
});
test('explicit performance returns one matching trace with actual condition decisions',()=>{
 const performance=createPerformanceTemplate(rules,chart);
 const result=createPerformanceSongCalculator(rules,chart,{performance}).calculate(draft,{includeTrace:true});
 assert.equal(result.skillPlayback.variants.length,1);const v=result.skillPlayback.variants[0];assert.equal(v.kind,'explicit');assert.equal(v.score,result.expectedScore);
 assert.equal(v.notes.reduce((s,n)=>s+n.score,0),v.score);assert.ok(v.skillTrace.length>0);
});
test('Gekisou extrema are reproducible samples and traced scores include section awards',()=>{
 const r=structuredClone(rules);Object.assign(r.tables.LiveMusic.find(m=>m._id===100001),{_gekisouMission1:1,_gekisouMission2:2,_gekisouMission3:3});
 const calculator=createGekisouSongCalculator(r,chart,{scenario:{seed:123,batches:2}});
 const plain=calculator.calculate(draft),a=calculator.calculate(draft,{includeTrace:true}),b=calculator.calculate(draft,{includeTrace:true});
 assert.equal(a.expectedScore,plain.expectedScore);assert.equal(a.skillPlayback.randomSampling,true);
 for(const [i,key] of ['maximumScore','minimumScore'].entries()){
   const variant=a.skillPlayback.variants[i];assert.equal(variant.score,a[key]);assert.equal(variant.seed,b.skillPlayback.variants[i].seed);
   assert.equal(variant.notes.reduce((s,n)=>s+n.score,0)+variant.rankingBonus+variant.eventFixedScore,variant.score);
   const clock=createReplayClock(a.skillPlayback,variant);assert.equal(clock.at(clock.duration).score,variant.score);
   assert.deepEqual(variant.skillTransitions,b.skillPlayback.variants[i].skillTransitions);
 }
});

test('replay clock seeks both ways, excludes end boundaries and settles rewards only when a section ends',()=>{
 const playback={skills:Array.from({length:5},(_,slotIndex)=>({slotIndex})),skillTimes:[100,500,600,700,800],ranges:[{index:1,startMs:100,endMs:400}]};
 const variant={order:[0,1,2,3,4],score:175,notes:[{timeMs:100,score:40,scoreUpFactor:1.5},{timeMs:200,score:60,scoreUpFactor:1.5},{timeMs:500,score:50,scoreUpFactor:1}],sections:[{index:1,rankingBonus:20}],commands:[{timeMs:100,ownerId:1,general:.5},{timeMs:200,ownerId:1,general:-.5}]};
 const clock=createReplayClock(playback,variant,{stateTrace:[{timeMs:100,life:700,combo:1},{timeMs:200,life:900,combo:2}]});
 assert.equal(clock.at(99).score,0);assert.equal(clock.at(100).score,40);assert.equal(clock.at(100).active.length,1);
 assert.equal(clock.at(200).active.length,0);assert.equal(clock.at(399).rewards,0);assert.equal(clock.at(400).rewards,20);
 assert.equal(clock.at(500).score,170);assert.equal(clock.at(clock.duration).score,175);
 assert.equal(clock.at(100).life,700);assert.equal(clock.at(99).life,undefined);assert.equal(clock.at(200).count,2);
 assert.equal(clock.next(100),500);assert.equal(clock.at(100).section.index,1);assert.equal(clock.at(400).section,undefined);
 assert.equal(variant.score,175);assert.equal(variant.notes[0].score,40);
});

test('detail worker preserves challenge scoring, rejects missing charts and resolves conditions only on request',async()=>{
 const {createEventEfficiency}=await import('../src/lib/scoring-rules/event-efficiency.mjs');
 let handle,reply;const previous=globalThis.self;
 globalThis.self={addEventListener:(event,callback)=>{handle=callback;},postMessage:value=>{reply=value;}};
 try{
   await import('../src/lib/skill-activation-worker.mjs');
   const r=structuredClone(rules);r.tables.Event=[{_id:1,_eventType:1}];
   r.tables.ChallengeMusic=[{_eventId:1,_liveMusicId:100001,_musicType:2,_gekisouMission1:0,_gekisouMission2:0,_gekisouMission3:0}];
   r.tables.EventEffect=[2,3].map((type,i)=>({_id:i+1,_eventId:1,_resourceTypeConstraint:type,_eventBonusType:2,
     ...Object.fromEntries([1,2,3,4,5].map(rank=>[`_rank${rank}EffectValue`,10000]))}));
   const model=createEventEfficiency({tables:r.tables,sourceReleaseId:r.sourceReleaseId,eventId:1});
   const d=structuredClone(draft);d.modifiers.event={id:1,sourceReleaseId:r.sourceReleaseId};
   const expected=createFormalSongCalculator(r,chart,{eventAdapters:[model.challengeAdapter(r)]}).calculate(d);
   await handle({data:{rules:r,chart,draft:structuredClone(draft),mode:'challenge',eventId:1}});
   assert.equal(reply.error,undefined);assert.equal(reply.result.expectedScore,expected.expectedScore);
   assert.equal(reply.result.skillPlayback.variants[0].score,expected.maximumScore);
   await handle({data:{rules:r,draft:structuredClone(draft)}});assert.match(reply.error,/未找到对应谱面/);
   await handle({data:{rules:r,draft:structuredClone(draft),conditionsOnly:true}});assert.equal(reply.error,undefined);assert.equal(reply.result.skills.length,5);
 }finally{globalThis.self=previous;}
});

test('Gekisou section views reconcile final notes and rewards for each selected sample',async()=>{
 const {gekisouSections,gekisouEffectTrack}=await import('../src/lib/gekisou-playback-model.mjs');
 const r=structuredClone(rules);Object.assign(r.tables.LiveMusic.find(m=>m._id===100001),{_gekisouMission1:1,_gekisouMission2:2,_gekisouMission3:3});
 const result=createGekisouSongCalculator(r,chart,{scenario:{seed:42}}).calculate(draft,{includeTrace:true});
 assert.deepEqual(result.skillPlayback.ranges.map(s=>s.missionType),[1,2,3]);
 assert.ok(result.skillPlayback.effects.every(e=>e.missionType && ['member','support'].includes(e.kind)));
 for(const variant of result.skillPlayback.variants){
   const sections=gekisouSections(result.skillPlayback,variant);
   assert.equal(sections.reduce((sum,s)=>sum+s.contribution,0)+variant.outsideScore+variant.eventFixedScore,variant.score);
   for(const s of sections){
     assert.ok(s.displayStartMs<=s.startMs&&s.displayEndMs>=s.endMs);
     assert.ok(s.events.every(e=>e.sectionIndex===s.index));
     assert.equal(s.luckEvents.length,s.luckCounts.reduce((sum,n)=>sum+n,0));
     for(const e of result.skillPlayback.effects.filter(e=>e.missionType===s.missionType)){
       const track=gekisouEffectTrack(e,s);assert.ok(track.events.every(ev=>ev.source===e.source));
     }
   }
 }
});
test('Gekisou factor tracks retain steps, gaps, repeated activations and zero-factor releases',async()=>{
 const {gekisouEffectTrack}=await import('../src/lib/gekisou-playback-model.mjs');
 const effect={source:'support:0:1',type:2000,active:true};
 const section={events:[{source:'other',timeMs:1,action:'factor',value:5},
   ...[[100,.1],[200,.2],[300,0],[500,.3],[600,0]].map(([timeMs,value])=>({source:effect.source,timeMs,frame:timeMs,action:'factor',value}))]};
 const track=gekisouEffectTrack(effect,section);
 assert.deepEqual(track.windows,[{startMs:100,endMs:200,value:.1},{startMs:200,endMs:300,value:.2},{startMs:500,endMs:600,value:.3}]);
 assert.equal(track.peakFactor,.3);assert.equal(track.changes,3);assert.equal(track.starts,0);
});
test('Gekisou converters show discrete triggers, not invented continuous lifetimes',async()=>{
 const {gekisouEffectTrack}=await import('../src/lib/gekisou-playback-model.mjs');
 const effect={source:'member:0:1',type:13005,active:true};
 const section={events:[100,200,300].map(timeMs=>({source:effect.source,timeMs,action:'start',frame:timeMs}))};
 const track=gekisouEffectTrack(effect,section);assert.equal(track.starts,3);assert.deepEqual(track.windows,[]);
 assert.equal(gekisouEffectTrack({...effect,source:'missing'},section).status,'not_triggered');
 assert.equal(gekisouEffectTrack({...effect,source:'missing',active:false},section).status,'condition_unmet');
});

test('conditional skill branches are grouped by the scored trace; simultaneous effects stay visible',async()=>{
 const {partitionActivationEffects}=await import('../src/lib/skill-activation-model.mjs');
 const skill={liveEffects:[{id:1,active:false,rate:1.2},{id:2,active:true,rate:1.4},{id:3,active:true,rate:.2}],supportEffects:[{id:4,active:true,type:15000}]};
 const result=partitionActivationEffects(skill);
 assert.deepEqual(result.active.map(e=>e.effect.id),[2,3,4]);assert.deepEqual(result.inactive.map(e=>e.effect.id),[1]);
 const traced=partitionActivationEffects(skill,[{effectId:1,active:true},{effectId:2,active:false}]);
 assert.deepEqual(traced.active.map(e=>e.effect.id),[1,3,4]);assert.deepEqual(traced.inactive.map(e=>e.effect.id),[2]);
});
