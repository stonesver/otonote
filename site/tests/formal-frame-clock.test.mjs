import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameClock, gekisouReleaseFrames, skillEndFrame, executingSkillEnd, nativeSkillDuration } from '../src/lib/scoring-rules/formal-frame-clock.mjs';
import { replayScoreTimeline, liveSkillCommands } from '../src/lib/scoring-rules/formal-score-replay.mjs';

test('compact phase clocks match the corresponding explicit audio timestamps',()=>{
  for(const frameRate of [60,120])for(const phaseMs of [0,.5,2+1/6,1000/frameRate-.5]){
    const frames=Array.from({length:500},(_,i)=>({timeMs:Math.floor(i*1000/frameRate+phaseMs),deltaSeconds:1/frameRate}));
    const compact=createFrameClock({frameRate,phaseMs}),explicit=createFrameClock({frameRate,frames});
    for(let time=0;time<3000;time++)assert.equal(compact.indexAt(time),explicit.indexAt(time));
  }
});

test('f32 stopwatch changes the completion frame at 120 FPS', () => {
  const actual = gekisouReleaseFrames(createFrameClock({frameRate:120}), 0, 200);
  assert.deepEqual(actual, {endFrame:0,settleFrame:24,releaseFrame:85});
  assert.equal(gekisouReleaseFrames(createFrameClock({frameRate:60}),0,200).releaseFrame,42);
});

test('music time and delta time stay independent on an explicit clock', () => {
  const clock = createFrameClock({frames:[{timeMs:0,deltaSeconds:0},{timeMs:100,deltaSeconds:.05},
    {timeMs:200,deltaSeconds:.15},{timeMs:200,deltaSeconds:.49},{timeMs:400,deltaSeconds:.01},{timeMs:401,deltaSeconds:.001} ]});
  assert.deepEqual(gekisouReleaseFrames(clock,0,200),{endFrame:0,settleFrame:2,releaseFrame:4});
  assert.equal(clock.indexAt(200),2);
  assert.throws(()=>clock.indexAt(402),/尾帧/);
});

test('short ExecuteFrame expiry uses current frame; Executing waits past equality and backdates ceil', () => {
  const clock=createFrameClock({frameRate:60});
  assert.deepEqual(skillEndFrame(clock,0,0.4),{startFrame:0,frame:1,timeMs:16});
  assert.deepEqual(skillEndFrame(clock,0,5000),{startFrame:0,frame:301,timeMs:5000});
  assert.equal(executingSkillEnd({startMs:100,nowMs:5100,seconds:5}),null);
  assert.equal(executingSkillEnd({startMs:100,nowMs:5101,seconds:5}),5100);
  assert.equal(executingSkillEnd({startMs:100,nowMs:300,seconds:5,force:true,musicLengthMs:250}),250);
  assert.equal(nativeSkillDuration(5.0004),Math.fround(Math.fround(5.0004)*1000));
});

test('explicit delayed frames preserve factor arrival and score rollback', () => {
  const clock=createFrameClock({frames:[0,10,100,101,200].map(timeMs=>({timeMs,deltaSeconds:.02}))});
  const skills=[{liveEffects:[{type:2000,active:true,rate:1,durationMs:50}]}];
  const commands=liveSkillCommands([0],skills,[0],60,skills,clock);
  assert.equal(commands[1].timeMs,50);assert.equal(commands[1].arrivalFrame,2);
  const result=replayScoreTimeline({clock,events:[{timeMs:40},{timeMs:60}],commands,scoreNote:(e,s)=>({score:s.general*100})});
  assert.equal(result.score,300);
});

test('invalid or insufficient clocks fail instead of silently reverting to ideal time',()=>{
  assert.throws(()=>createFrameClock({frames:[{timeMs:10,deltaSeconds:0},{timeMs:9,deltaSeconds:.1}]}),/第 1 帧/);
  assert.throws(()=>createFrameClock({frames:[{timeMs:0,deltaSeconds:-1}]}),/第 0 帧/);
  assert.throws(()=>gekisouReleaseFrames(createFrameClock({frames:[{timeMs:0,deltaSeconds:0}]}),0,200),/尾帧/);
});
