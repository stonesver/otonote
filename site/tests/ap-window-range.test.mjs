import test from 'node:test';
import assert from 'node:assert/strict';
import {timingFixture,fixedBoostTimingFixture} from './helpers/ap-timing-fixture.mjs';
import {calculateApWindowRange,apWindowChoices} from '../../packages/scoring/scoring-rules/ap-window-range.mjs';
import {apTimingPerformance} from '../../packages/scoring/scoring-rules/ap-timing-plan.mjs';
import {prepareFormalChart} from '../../packages/scoring/scoring-rules/formal-song-score.mjs';
import {createPerformanceSongCalculator} from '../../packages/scoring/scoring-rules/formal-performance-replay.mjs';
import {createFrameClock} from '../../packages/scoring/scoring-rules/formal-frame-clock.mjs';
import {createScoreReplay} from '../../packages/scoring/scoring-rules/formal-score-replay.mjs';

test('fixed boosts keep chart-time coverage while AP inputs can avoid a one-point float32 rollback loss',()=>{
 const {rules,chart,draft}=fixedBoostTimingFixture(),order=[0,1,2,3,4];
 const timeline=prepareFormalChart(rules,chart);
 for(const frameRate of [60,120]){
  const baseline=createPerformanceSongCalculator(rules,chart,{performance:apTimingPerformance(timeline,{order,adjustments:[]},{frameRate})}).calculate(draft,{includeTrace:true});
  const range=calculateApWindowRange(rules,chart,draft,{order,frameRate});
  assert.equal(baseline.expectedScore,216813);assert.equal(range.minimum.score,216813);assert.equal(range.maximum.score,216814);
  const before=baseline.bestOrderNotes,after=range.maximum.variant.notes;
  assert.deepEqual(before.map(note=>note.combo),after.map(note=>note.combo));
  assert.equal(before[0].scoreUpFactor,Math.fround(1-Math.pow(2,-24)));
  assert.equal(after[0].scoreUpFactor,1);
  assert.equal(before[1].scoreUpFactor,after[1].scoreUpFactor,'the same note receives the same ordinary boost');
  assert.ok(after.every(note=>note.judgement===5));
 }
});

test('ordinary fixed boosts cannot gain AP coverage by moving inputs across activation or expiry',()=>{
  for(const type of [2000,2004])for(const rate of [3000,7000,13000,15500])
    for(const ticks of [[979,991,1007,1041],[1030,1040,1050,1060],[999,1000,1001,1002]]){
      const {rules,chart,draft}=timingFixture(),order=[0,1,2,3,4];
      rules.tables.SupportCard.find(row=>row._id===1)._supportSkillId01=0;
      chart.notes=ticks.map((tick,i)=>({id:`boundary-${i}`,type:'tap',tick,position:i*4,size:4}));
      const perfectTarget=rules.tables.SkillTarget.find(row=>row._skillTargetType===4&&row._judgement===5)._id;
      for(const row of rules.tables.LiveSkillEffect){row._skillEffectType=type;row._effectValue=rate;row._activationTimeSecond=.0401;row._skillConditionGroup=0;row._skillTargetIDs=type===2004?[perfectTarget]:[];}
      const timeline=prepareFormalChart(rules,chart);
      for(const frameRate of [60,120]){
        const baseline=createPerformanceSongCalculator(rules,chart,{performance:apTimingPerformance(timeline,{order,adjustments:[]},{frameRate})}).calculate(draft);
        assert.ok(baseline.skillScoreGain>0,'the boundary contains an active score boost');
        const range=calculateApWindowRange(rules,chart,draft,{order,frameRate});
        assert.equal(range.minimum.score,baseline.expectedScore);
        assert.equal(range.maximum.score,baseline.expectedScore);
        assert.deepEqual(range.maximum.adjustments,[]);
      }
    }
});

test('full AP window extrema match exhaustive independent input-frame enumeration, including combo and skill boundaries',()=>{
  const {rules,chart,draft}=timingFixture(),order=[0,1,2,3,4];
  chart.notes=[991,1007,1041].map((tick,i)=>({id:`key-${i}`,type:'tap',tick,position:4*i,size:4}));
  rules.tables.LiveComboScoreBonus=[{_comboBonusType:0,_requiredComboCount:2,_bonusFactor:.3}];
  for(const row of rules.tables.LiveJudgementTiming)if(row._noteSimulateJudgement===5){row._beforeMs=17;row._afterMs=17;}
  for(const row of rules.tables.LiveSkillEffect){row._effectValue=3000;row._activationTimeSecond=.0401;}
  const timeline=prepareFormalChart(rules,chart);
  for(const frameRate of [60,120])for(const phaseMs of [0,2.5]){
    const engine=createPerformanceSongCalculator(rules,chart,{performance:apTimingPerformance(timeline,{order,adjustments:[]},{frameRate,phaseMs})});
    const choices=apWindowChoices(rules,timeline,createFrameClock({frameRate,phaseMs}));
    let minimum=Infinity,maximum=-Infinity,count=0;
    function visit(index,adjustments){
      if(index<choices.length){for(const timingOffsetMs of choices[index].frames.values())visit(index+1,[...adjustments,{scoreIndex:index,timingOffsetMs}]);return;}
      const replay=engine.withPerformance(apTimingPerformance(timeline,{order,adjustments},{frameRate,phaseMs})).calculate(draft);
      assert.ok(replay.performance.allPerfect);minimum=Math.min(minimum,replay.expectedScore);maximum=Math.max(maximum,replay.expectedScore);count++;
    }
    visit(0,[]);assert.ok(count>20);
    const result=calculateApWindowRange(rules,chart,draft,{order,frameRate,phaseMs});
    assert.equal(result.status,'exact');assert.equal(result.minimum.score,minimum);assert.equal(result.maximum.score,maximum);
    for(const witness of [result.minimum,result.maximum]){
      assert.equal(witness.variant.notes.reduce((sum,n)=>sum+n.score,0),witness.score);
      assert.ok(witness.variant.notes.every(n=>n.judgement===5));
    }
  }
});

test('long and guide manual endpoints vary, automatic ticks stay fixed, and an incomplete search publishes no extrema',()=>{
  const {rules,chart,draft}=timingFixture();
  chart.notes=[{id:'hold',type:'long',nodes:[{tick:1000,position:2,size:4,operateType:'flick'},{tick:1010,position:2,size:4},{tick:1020,position:4,size:4,operateType:'flick'}]}];
  const timeline=prepareFormalChart(rules,chart),choices=apWindowChoices(rules,timeline,createFrameClock({frameRate:120}));
  assert.equal(choices[0].late,choices[1].event.timeMs-choices[0].event.timeMs-1);assert.ok(choices.at(-1).frames.size>1);
  assert.ok(choices.filter(c=>c.event.kind!=='authored'||![1,20,40,41,42,101,102].includes(c.event.type)).every(c=>[...c.frames.values()].every(offset=>offset===0)));
  assert.throws(()=>calculateApWindowRange(rules,chart,draft,{order:[0,1,2,3,4],maxTransitions:1}),/预算/);
  const result=calculateApWindowRange(rules,chart,draft,{order:[0,1,2,3,4],frameRate:120});
  for(const witness of [result.minimum,result.maximum])assert.ok(witness.variant.notes.every((note,index,notes)=>!index||note.inputFrame>=notes[index-1].inputFrame));
});

test('forked and sealed score replay preserves native rollback float history and isolates branches',()=>{
  const scoreNote=(_,state)=>({score:Math.floor(Math.fround(state.general*100000))});
  const original=createScoreReplay({musicLengthMs:1000,scoreNote,retainNotes:false});
  original.addFactor({timeMs:10,ownerId:1,general:Math.fround(.3)});original.addNote({timeMs:20,scoreIndex:0});original.calculate(50);
  const branch=original.fork(),closed=branch.sealBefore(50),sibling=branch.fork();
  for(const replay of [original,branch]){
    replay.addNote({timeMs:81,scoreIndex:1});replay.calculate(100);
    replay.addFactor({timeMs:70,ownerId:1,general:-Math.fround(.3)});replay.calculate(100);
  }
  assert.equal(branch.score+closed,original.score);assert.deepEqual(branch.state,original.state);
  assert.notEqual(sibling.state.general,branch.state.general);assert.equal(sibling.score,0);
});
