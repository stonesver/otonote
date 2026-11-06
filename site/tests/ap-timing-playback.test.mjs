import test from 'node:test';
import {timingPracticeGroups} from '../src/lib/ap-timing-view.mjs';
import assert from 'node:assert/strict';
test('practice cues preserve separate inputs, simultaneous notes, direction changes and distant sections',()=>{
  const notes=[{timeMs:1000,timingOffsetMs:-25},{timeMs:1000,timingOffsetMs:-25},{timeMs:1400,timingOffsetMs:-25},
    {timeMs:1500,timingOffsetMs:20},{timeMs:4000,timingOffsetMs:20}],original=structuredClone(notes);
  assert.deepEqual(timingPracticeGroups(notes),[
    {startMs:1000,endMs:1400,offset:-25,count:3},{startMs:1500,endMs:1500,offset:20,count:1},{startMs:4000,endMs:4000,offset:20,count:1}]);
  assert.deepEqual(notes,original);assert.deepEqual(timingPracticeGroups([]),[]);
});
import {createTimingPlayback,exportTimingPlayback,importTimingPlayback,timingPlaybackDuration} from '../src/lib/ap-timing-playback.mjs';
import {normalizeAutoTimeline} from '../src/lib/auto-timeline.mjs';
import {createAutoScene} from '../src/lib/auto-stage-scene.mjs';
import {createAutoStageFrame} from '../src/lib/auto-stage-layout.mjs';

test('timing demo keeps chart positions, moves hit effects and follows actual frame scores in both seek directions',()=>{
  const chart={id:'test',duration:2,notes:[{id:'a',type:'tap',time:1,position:2,size:6},{id:'b',type:'tap',time:1.1,position:12,size:6}]};
  const notes=[{noteId:'a',kind:'authored',timeMs:1000,inputTimeMs:980,timingOffsetMs:-20,score:120},
    {noteId:'b',kind:'authored',timeMs:1100,inputTimeMs:1133,timingOffsetMs:20,score:100}];
  const variant={order:[0,1,2,3,4],score:220,notes,commands:[],stateTrace:[{timeMs:980,score:100,combo:1},{timeMs:1000,score:120,combo:1},{timeMs:1133,score:220,combo:2}]};
  const playback={skills:Array.from({length:5},()=>({})),skillTimes:[1000,1200,1400,1600,1800],variants:[variant]};
  const performance=createTimingPlayback(playback,variant),timeline=normalizeAutoTimeline(chart),frame=createAutoStageFrame({width:500,height:320});
  const early=createAutoScene(timeline,frame,.981,{performance});
  assert.equal(early.hitEffects[0].sourceId,'a');assert.equal(early.score,100);
  assert.ok(!early.markers.some(note=>note.sourceId==='a'));
  assert.equal(createAutoScene(timeline,frame,1.02,{performance}).score,120,'score changes without a new input');
  const waiting=createAutoScene(timeline,frame,1.12,{performance});assert.ok(waiting.markers.some(note=>note.sourceId==='b'));
  assert.equal(waiting.combo,1);assert.equal(createAutoScene(timeline,frame,1.134,{performance}).combo,2);
  assert.equal(createAutoScene(timeline,frame,.981,{performance}).score,100);
  timeline.gekisouRanges=[{start:0,end:2}];
  assert.equal(createAutoScene(timeline,frame,1,{performance}).activeGekisou,null,'ordinary AP plans do not activate Gekisou sections');
  const exported=exportTimingPlayback(chart,{apTimingPlan:{rates:[{frameRate:60}]},skillPlayback:playback});
  assert.deepEqual(importTimingPlayback(JSON.parse(JSON.stringify(exported)),chart),exported);
  assert.throws(()=>importTimingPlayback(exported,{...chart,notes:[]}),/不匹配/);
});


test('playback waits for late last input and clears cumulative stacks at expiry',()=>{
  const skill={liveEffects:[{id:1,cumulative:{},durationRawMs:500}]};
  const variant={order:[0],score:90,notes:[{kind:'authored',noteId:'a',timeMs:2000,inputTimeMs:2033,score:90}],commands:[],timingCondition:{frameRate:60,phaseMs:0},
    skillTrace:[{action:'cumulative',slotIndex:0,effectId:1,timeMs:1100,count:1}],stateTrace:[{timeMs:0,score:0},{timeMs:2033,score:90}]};
  const playback={skills:[skill],skillTimes:[1000],variants:[variant]},performance=createTimingPlayback(playback,variant);
  assert.equal(timingPlaybackDuration({duration:2},playback),2.033);
  assert.equal(performance.clock.at(2000).score,0);assert.equal(performance.clock.at(2033).score,90);
  assert.equal(performance.stacksAt(1200)[0].count,1);assert.deepEqual(performance.stacksAt(1600),[]);
});
