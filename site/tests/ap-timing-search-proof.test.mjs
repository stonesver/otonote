import test from 'node:test';
import assert from 'node:assert/strict';
import {timingFixture,fixedBoostTimingFixture} from './helpers/ap-timing-fixture.mjs';
import {createApTimingCalculator,apTimingPerformance,apTimingClocks} from '../../packages/scoring/scoring-rules/ap-timing-plan.mjs';
import {createPerformanceSongCalculator} from '../../packages/scoring/scoring-rules/formal-performance-replay.mjs';
import {createFormalSongCalculator} from '../../packages/scoring/scoring-rules/formal-song-score.mjs';
import {createFormalSkillResolver} from '../../packages/scoring/scoring-rules/formal-skills.mjs';
import {createApTimingScoreBound} from '../../packages/scoring/scoring-rules/ap-timing-score-bound.mjs';
import {calculateApWindowRange} from '../../packages/scoring/scoring-rules/ap-window-range.mjs';
import {createEventEfficiency} from '../../packages/scoring/scoring-rules/event-efficiency.mjs';
import {resolveSearchInput} from '../../packages/scoring/scoring-rules/formation-input.mjs';
import {maximumPairing,partitionPairing} from '../../packages/scoring/scoring-rules/maximum-pairing.mjs';
import {skillOrdersFor} from '../../packages/scoring/scoring-rules/skill-order-sampling.mjs';
import {compilePairingModels,draftFromPairing} from '../src/lib/inventory-optimizer.mjs';
import {optimizeChallenge} from '../src/lib/challenge-optimizer.mjs';

test('score-only AP replay equals the full frame-by-frame replay, including rollback and mixed early/late inputs',()=>{
  for(const make of [timingFixture,fixedBoostTimingFixture]){
    const {rules,chart,draft}=make();
    chart.notes.push({id:'hold',type:'long',nodes:[{tick:1000,position:0,size:4},{tick:2600,position:0,size:4}]});
    const timeline=createFormalSongCalculator(rules,chart).timeline;
    const empty={order:[0,1,2,3,4],adjustments:[]};
    const calculator=createPerformanceSongCalculator(rules,chart,{performance:apTimingPerformance(timeline,empty)});
    const prepared=calculator.prepare(draft);
    for(const frameRate of [60,120])for(const phaseMs of [0,1/6,frameRate===60?16.5:8.166666666666666]){
      for(const order of [[0,1,2,3,4],[4,3,2,1,0]])for(const offsets of [[0],[-40,20],[20,-20,0]]){
        const adjustments=timeline.events.filter(e=>e.type===1 && e.kind==='authored').map((e,i)=>({scoreIndex:e.scoreIndex,timingOffsetMs:offsets[i%offsets.length]}));
        const replay=calculator.withPerformance(apTimingPerformance(timeline,{order,adjustments},{frameRate,phaseMs}));
        assert.equal(replay.calculateScore(draft,prepared),replay.calculate(draft).expectedScore,`${make.name} ${frameRate} ${phaseMs} ${order} ${offsets}`);
      }
    }
  }
});

test('complete order/policy score covers independent native replay of every declared uniform policy',()=>{
  const {rules,chart,draft}=timingFixture();
  chart.notes=chart.notes.slice(0,6);
  const calculator=createApTimingCalculator(rules,chart),result=calculator.calculate(draft),timeline=calculator.timeline;
  const skills=createFormalSkillResolver(rules)(draft),engine=createPerformanceSongCalculator(rules,chart,{performance:apTimingPerformance(timeline,{order:[0,1,2,3,4],adjustments:[]})});
  // These phases include boundary changes and both nominal clocks. A separate
  // exhaustive replay of all 77 classes supplies the exact robust objective.
  for(const order of skillOrdersFor('full')){
    const cumulative=skills.flatMap((s,slot)=>s.liveEffects.filter(e=>e.active&&e.cumulative).map(e=>({start:timeline.skillTimes[order.indexOf(slot)],duration:e.durationMs})));
    for(const offset of [0,-20,-25,-30,-40,20]){
      const adjustments=offset===0?[]:timeline.events.filter(e=>e.type===1&&e.kind==='authored'&&cumulative.some(w=>e.timeMs>w.start+50&&e.timeMs<w.start+w.duration))
        .map(e=>({scoreIndex:e.scoreIndex,timingOffsetMs:offset}));
      let minimum=Infinity;
      for(const frameRate of [60,120]){
        for(const phaseMs of apTimingClocks(frameRate)){
          for(const biasMs of [-5,0,5]){
            minimum=Math.min(minimum,engine.withPerformance(apTimingPerformance(timeline,{order,adjustments},{frameRate,phaseMs,biasMs})).calculate(draft).expectedScore);
            if(minimum<=result.expectedScore)break;
          }
          if(minimum<=result.expectedScore)break;
        }
        if(minimum<=result.expectedScore)break;
      }
      assert.ok(result.expectedScore>=minimum);
    }
  }
  assert.equal(result.orderCount,120);assert.equal(result.apTimingPlan.search.optimality,'policy_order_proven');
});

test('AP pairing bounds and the completed certificate cover an independent complete small card library',async()=>{
  const {rules,chart,draft}=timingFixture();chart.notes=chart.notes.slice(0,8);
  draft.modifiers.performanceScenario={profile:'ap_timing'};
  draft.modifiers.event={id:1,sourceReleaseId:rules.sourceReleaseId};
  const inventory={memberCardIds:draft.slots.map(s=>s.memberCardId),supportCardIds:[...draft.slots.map(s=>s.supportCardId),'support-card-6'],growth:draft.modifiers.growth};
  const constraints={leaderId:draft.slots[2].memberCardId,lockedPairs:draft.slots.slice(2)};
  const input=resolveSearchInput(rules,draft,{scope:'owned',inventory,constraints});
  const event=createEventEfficiency({tables:rules.tables,sourceReleaseId:rules.sourceReleaseId,eventId:1});
  const eventAdapters=[event.challengeAdapter(rules)];
  const [model]=await compilePairingModels(rules,input,{eventAdapters}),resolver=createFormalSkillResolver(rules,{dynamic:true}),pairSkills=new Map();
  for(const edge of model.edges)pairSkills.set(edge.key,resolver({slots:[{memberCardId:edge.member,supportCardId:edge.support}],modifiers:input.draft.modifiers})[0]);
  const song=createFormalSongCalculator(rules,chart,{eventAdapters});
  const bound=createApTimingScoreBound({rules,song,pairSkills,input,legacyFactor:Infinity,jointPowerBound:true});
  const score=createApTimingCalculator(rules,chart,{eventAdapters});
  const rows=[];
  for(const a of [1,2,6])for(const b of [1,2,6])if(a!==b){
    const candidate=structuredClone(draft);candidate.slots[0].supportCardId=`support-card-${a}`;candidate.slots[1].supportCardId=`support-card-${b}`;
    rows.push({draft:candidate,value:score.calculate(candidate).expectedScore,keys:new Set(candidate.slots.map(s=>`${s.memberCardId}|${s.supportCardId}`))});
  }
  const root={leader:model.leader,required:constraints.lockedPairs.map(s=>`${s.memberCardId}|${s.supportCardId}`),forbidden:[]};
  const solve=state=>maximumPairing({edges:model.edges,requiredMembers:[model.leader],required:state.required,forbidden:state.forbidden});
  const solution=solve(root);
  for(const state of [root,...partitionPairing(root,solution)]){
    const solved=solve(state);if(!solved)continue;
    const exact=Math.max(...rows.filter(r=>state.required.every(k=>r.keys.has(k))&&state.forbidden.every(k=>!r.keys.has(k))).map(r=>r.value));
    const upper=bound(state,model,solved,()=>draftFromPairing(input,state.leader,solved.edges));
    assert.ok(upper>=exact,`${upper} < ${exact}`);
  }
  const result=await optimizeChallenge({rules,chart,draft,inventory,constraints,eventId:1,scope:'owned',maxEvaluations:0,yieldControl:async()=>{}});
  assert.equal(result.results[0].value,Math.max(...rows.map(r=>r.value)));
  assert.equal(result.certifiedSearch.bestProven,true);assert.equal(result.certifiedSearch.optimalityGap,0);
  assert.equal(result.certifiedSearch.scope,'team_for_chart_ap_policies');
  const unsupported=structuredClone(pairSkills);unsupported.values().next().value.liveEffects[0].release=[5];
  assert.equal(createApTimingScoreBound({rules,song,pairSkills:unsupported,input}),null);
});

test('AP upper bound covers exact independent key windows straddling skill activation',async()=>{
  const {rules,chart,draft}=timingFixture();
  chart.notes=[991,1007,1041].map((tick,i)=>({id:`edge-${i}`,type:'tap',tick,position:i*4,size:4}));
  rules.tables.LiveComboScoreBonus=[{_comboBonusType:0,_requiredComboCount:2,_bonusFactor:.3}];
  for(const row of rules.tables.LiveJudgementTiming)if(row._noteSimulateJudgement===5){row._beforeMs=17;row._afterMs=17;}
  for(const row of rules.tables.LiveSkillEffect){row._effectValue=3000;row._activationTimeSecond=.0401;}
  const constraints={leaderId:draft.slots[2].memberCardId,lockedPairs:draft.slots};
  const input=resolveSearchInput(rules,draft,{scope:'selected',constraints});
  const [model]=await compilePairingModels(rules,input),resolver=createFormalSkillResolver(rules,{dynamic:true});
  const pairSkills=new Map(model.edges.map(e=>[e.key,resolver({slots:[{memberCardId:e.member,supportCardId:e.support}],modifiers:draft.modifiers})[0]]));
  const solution=maximumPairing({edges:model.edges,required:constraints.lockedPairs.map(s=>`${s.memberCardId}|${s.supportCardId}`)});
  const song=createFormalSongCalculator(rules,chart),bound=createApTimingScoreBound({rules,song,pairSkills,input,legacyFactor:Infinity,jointPowerBound:true});
  const upper=bound({leader:model.leader,required:solution.edges.map(e=>e.key),forbidden:[]},model,solution,()=>draft);
  for(let position=0;position<5;position++){
    const order=[1,2,3,4];order.splice(position,0,0);
    const exact=calculateApWindowRange(rules,chart,draft,{order});
    assert.ok(upper>=exact.maximum.score,`${upper} < ${exact.maximum.score}`);
  }
});
