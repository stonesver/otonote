import test from 'node:test';
import assert from 'node:assert/strict';
import {timingFixture} from './helpers/ap-timing-fixture.mjs';
import { createApTimingCalculator, apTimingPerformance } from '../../packages/scoring/scoring-rules/ap-timing-plan.mjs';
import { createPerformanceSongCalculator } from '../../packages/scoring/scoring-rules/formal-performance-replay.mjs';
import { parseTeamDraftSearch, serializeTeamDraftSearch } from '../src/lib/team-draft.mjs';
import { optimizeChallenge } from '../src/lib/challenge-optimizer.mjs';
import { createScenarioSongCalculator } from '../../packages/scoring/scoring-rules/performance-scenario-calculator.mjs';
import {hasApTimingInstructions} from '../src/lib/ap-timing-presentation.mjs';


test('AP timing plan compares both frame rates, replays displayed scores and rescores stored/share plans',()=>{
  const {rules,chart,draft}=timingFixture();
  const calculator=createApTimingCalculator(rules,chart);
  const result=calculator.calculate(draft,{includeTrace:true}),plan=result.apTimingPlan;
  assert.deepEqual(plan.rates.map(r=>r.frameRate),[60,120]);
  assert.equal(result.expectedScore,Math.min(...plan.rates.map(r=>r.minimumScore)));
  assert.ok(plan.adjustments.length>0);
  assert.ok(plan.adjustments.every(row=>row.apMarginMs>=plan.toleranceMs));
  for(const rate of plan.rates){
    const replay=createPerformanceSongCalculator(rules,chart,{performance:apTimingPerformance(calculator.timeline,plan,{frameRate:rate.frameRate})}).calculate(draft);
    assert.equal(replay.expectedScore,rate.referenceScore);
    assert.equal(replay.performance.allPerfect,true);
    assert.equal(replay.performance.convertedCount,0);
    for(const kind of ['minimum','maximum']){
      const extreme=createPerformanceSongCalculator(rules,chart,{performance:apTimingPerformance(calculator.timeline,plan,{frameRate:rate.frameRate,...rate[`${kind}Condition`]})}).calculate(draft);
      assert.equal(extreme.expectedScore,rate[`${kind}Score`]);assert.ok(extreme.performance.allPerfect);
    }
  }
  assert.equal(result.skillPlayback.variants[0].score,plan.rates[0].referenceScore);
  assert.equal(result.maximumScore,Math.max(...plan.rates.map(rate=>rate.maximumScore)));
  const saved=structuredClone(draft);saved.modifiers.apTimingPlan=structuredClone(plan);
  const replayed=calculator.calculate(saved).apTimingPlan;
  assert.deepEqual({...replayed,search:plan.search},plan);
  assert.equal(replayed.search.optimality,'saved_witness','imported search claims are not evidence');
  saved.modifiers.apTimingPlan.score=1; saved.modifiers.apTimingPlan.rates[0].referenceScore=1;
  assert.equal(calculator.calculate(saved).expectedScore,plan.score,'stored derived scores are never trusted');
  saved.modifiers.performanceScenario={profile:'ap_timing'};
  const search=serializeTeamDraftSearch(saved);assert.ok(search.length<30000);
  const parsed=parseTeamDraftSearch(search,{memberCardIds:new Set(draft.slots.map(s=>s.memberCardId)),supportCardIds:new Set(draft.slots.map(s=>s.supportCardId)),musicTrackIds:new Set([chart.trackId])});assert.deepEqual(parsed.issues,[]);
  const shared=calculator.calculate(parsed.draft);assert.equal(shared.expectedScore,plan.score);
  assert.deepEqual(shared.apTimingPlan.adjustments,plan.adjustments);
  saved.modifiers.apTimingPlan.context='changed';
  assert.equal(calculator.calculate(saved).apTimingPlan.context,plan.context);
  assert.throws(()=>createScenarioSongCalculator(rules,chart,{mode:'gekisou',performanceScenario:{profile:'ap_timing'}}),/普通/);
});


test('AP policies leave automatic long events on time and preserve all-perfect judgements',()=>{
  const {rules,chart,draft}=timingFixture();
  chart.notes.push({id:'hold',type:'long',nodes:[{tick:1000,position:0,size:4},{tick:2600,position:0,size:4}]});
  const calculator=createApTimingCalculator(rules,chart),result=calculator.calculate(draft,{includeTrace:true});
  const automatic=calculator.timeline.events.filter(event=>event.kind!=='authored');
  assert.ok(automatic.length>0);
  for(const event of automatic)assert.ok(!result.apTimingPlan.adjustments.some(row=>row.scoreIndex===event.scoreIndex));
  for(const rate of result.apTimingPlan.rates){
    const replay=createPerformanceSongCalculator(rules,chart,{performance:apTimingPerformance(calculator.timeline,result.apTimingPlan,{frameRate:rate.frameRate})}).calculate(draft);
    assert.equal(replay.performance.allPerfect,true);
  }
});

test('saved offsets without a mechanism or a score benefit return to the same on-time order',()=>{
  for(const kind of ['fixed','inactive','no_gain']){
    const {rules,chart,draft}=timingFixture();
    if(kind==='fixed')rules.tables.SupportCard.find(row=>row._id===1)._supportSkillId01=0;
    if(kind==='inactive')rules.tables.SkillCondition.find(row=>row._id===990)._isPositive=false;
    if(kind==='no_gain')chart.notes=[500,600,700].map((tick,i)=>({id:`before-skill-${i}`,type:'tap',tick,position:i*4,size:4}));
    const calculator=createApTimingCalculator(rules,chart),original=calculator.calculate(draft);
    const saved=structuredClone(original.apTimingPlan);
    saved.adjustments=[{scoreIndex:0,timingOffsetMs:-20}];
    saved.onTimeMinimumScore=0; // A saved benefit is derived data, not trusted input.
    draft.modifiers.apTimingPlan=saved;
    const result=calculator.calculate(draft,{includeTrace:true});
    assert.equal(result.expectedScore,original.expectedScore,kind);
    assert.deepEqual(result.bestOrder,original.bestOrder,kind);
    assert.deepEqual(result.apTimingPlan.adjustments,[],kind);
    assert.equal(result.apTimingPlan.onTimeMinimumScore,result.expectedScore,kind);
    assert.equal(hasApTimingInstructions(result.apTimingPlan),false,kind);
    assert.equal(result.skillPlayback.variants.length,2,kind);
    assert.ok(Number.isFinite(result.minimumScore)&&Number.isFinite(result.maximumScore),kind);
  }
});

test('challenge AP recommendations carry a separate complete policy/formation certificate',async()=>{
  const {rules,chart,draft}=timingFixture();draft.modifiers.performanceScenario={profile:'ap_timing'};
  const result=await optimizeChallenge({rules,chart,draft,eventId:1,scope:'selected',maxEvaluations:0,yieldControl:async()=>{}});
  assert.equal(result.searchMethod,'certified');assert.equal(result.certifiedSearch.bestProven,true);
  assert.equal(result.certifiedSearch.scope,'team_for_chart_ap_policies');
  assert.equal(result.certifiedSearch.optimalityGap,0);
  assert.ok(result.results.length>0);
  for(const [index,row] of result.results.entries()){
    assert.equal(row.value,row.apTimingPlan.score);assert.deepEqual(row.draft.modifiers.apTimingPlan,row.apTimingPlan);
    assert.equal(row.apTimingPlan.search.optimality,'policy_order_proven');
    assert.equal(row.orderCount,120);
    if(index)assert.ok(result.results[index-1].value>=row.value);
  }
});
