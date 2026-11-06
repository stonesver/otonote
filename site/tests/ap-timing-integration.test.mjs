import test from 'node:test';
import assert from 'node:assert/strict';
import {timingFixture,fixedBoostTimingFixture} from './helpers/ap-timing-fixture.mjs';
import {estimateAPChart,applyAPBasis,withAPTimingBasis,eventToolSearch} from '../src/lib/ap-grade.mjs';
import {eventGradeEstimate,estimateEventSong} from '../src/lib/event-song-ranking.mjs';
import {eventYieldStageInput} from '../src/lib/event-yield-stage.mjs';
import {optimizeEventYield} from '../src/lib/event-yield-optimizer.mjs';
import {createEventEfficiency} from '../../packages/scoring/scoring-rules/event-efficiency.mjs';
import {createFormalSongCalculator} from '../../packages/scoring/scoring-rules/formal-song-score.mjs';
import {createApTimingCalculator} from '../../packages/scoring/scoring-rules/ap-timing-plan.mjs';
import {optimizePractical} from '../src/lib/practical-optimizer.mjs';
import {hasApTimingInstructions} from '../src/lib/ap-timing-presentation.mjs';
import {skillOrderModel} from '../src/lib/skill-order-summary.mjs';
import {calculateApWindowRange} from '../../packages/scoring/scoring-rules/ap-window-range.mjs';
import {createScenarioSongCalculator} from '../../packages/scoring/scoring-rules/performance-scenario-calculator.mjs';
import {createCandidateEvaluator} from '../src/lib/formation-candidate-evaluator.mjs';

const candidate=chart=>({id:chart.id,trackId:chart.trackId,difficulty:chart.difficulty,seconds:10,title:'timing fixture'});
const yieldControl=async()=>{};

test('rounding-only AP gains stay in the score range without becoming a recommended timing guide',()=>{
 const {rules,chart,draft}=fixedBoostTimingFixture();
 const baseline=createFormalSongCalculator(rules,chart).calculate(draft);
 const result=createApTimingCalculator(rules,chart).calculate(draft,{includeTrace:true});
 assert.ok(result.skills.every(skill=>skill.liveEffects.every(effect=>!effect.cumulative)));
 assert.equal(baseline.maximumScore,216813);
 assert.equal(result.expectedScore,216813);
 assert.equal(hasApTimingInstructions(result.apTimingPlan),false);
 assert.deepEqual(result.apTimingPlan.adjustments,[]);
 assert.deepEqual(result.bestOrder,baseline.bestOrder);
 assert.ok(result.apTimingPlan.rates.every(rate=>rate.referenceScore===rate.baselineScore));
 assert.ok(result.skillPlayback.variants.every(variant=>variant.notes.every(note=>note.judgement===5)));
 assert.equal(skillOrderModel(result).kind,'on_time');
 const range=calculateApWindowRange(rules,chart,draft,{order:result.bestOrder});
 assert.equal(range.minimum.score,216813);assert.equal(range.maximum.score,216814);
 const screen=createApTimingCalculator(rules,chart,{scorePrecision:'screen'}).calculate(draft);
 assert.equal(screen.expectedScore,result.expectedScore);
 assert.deepEqual(screen.apTimingScreen.adjustments,[]);
});

test('timing guides follow useful inputs, not the selected mode or a particular cumulative card',()=>{
 const cases=['ordinary','cumulative_without_gain','cumulative_with_gain'];
 for(const kind of cases){
  const {rules,chart,draft}=timingFixture();
  if(kind==='ordinary')rules.tables.SupportCard.find(row=>row._id===1)._supportSkillId01=0;
  if(kind==='cumulative_without_gain')chart.notes=[500,600,700].map((tick,i)=>({id:`before-skill-${i}`,type:'tap',tick,position:i*4,size:4}));
  const result=createApTimingCalculator(rules,chart).calculate(draft,{includeTrace:true});
  const useful=kind==='cumulative_with_gain';
  assert.equal(hasApTimingInstructions(result.apTimingPlan),useful);
  assert.equal(skillOrderModel(result).kind,useful?'timing':'on_time');
  assert.deepEqual(skillOrderModel(result).order,result.bestOrder);
  assert.ok(result.skillPlayback.variants.length>=2,'both frame-rate replays stay available');
  assert.ok(Number.isFinite(result.minimumScore)&&Number.isFinite(result.maximumScore));
  if(useful)assert.ok(result.apTimingPlan.rates.every(rate=>rate.referenceScore>rate.baselineScore));
  else {
   assert.deepEqual(result.apTimingPlan.adjustments,[]);
   assert.ok(result.apTimingPlan.rates.every(rate=>rate.referenceScore===rate.baselineScore));
   assert.doesNotMatch(result.performanceSummary,/微操|操作/);
  }
 }
});

test('scoring, candidate ranking and song grading share mechanism and benefit decisions for new card IDs',()=>{
 for(const kind of ['fixed','inactive','no_gain','new_card']){
  const {rules,chart,draft}=timingFixture();
  if(kind==='fixed')rules.tables.SupportCard.find(row=>row._id===1)._supportSkillId01=0;
  if(kind==='inactive')rules.tables.SkillCondition.find(row=>row._id===990)._isPositive=false;
  if(kind==='no_gain')chart.notes=[500,600,700].map((tick,i)=>({id:`before-skill-${i}`,type:'tap',tick,position:i*4,size:4}));
  if(kind==='new_card'){
   const card=rules.tables.SupportCard.find(row=>row._id===1);card._id=999;card._supportSkillId01=1990;
   for(const effect of rules.tables.SupportSkillEffect)if(effect._supportSkillID===990)effect._supportSkillID=1990;
   draft.slots[0].supportCardId='support-card-999';draft.modifiers.growth['support-card-999']=draft.modifiers.growth['support-card-1'];
  }
  draft.modifiers.performanceScenario={profile:'ap_timing'};
  const outputs=[
   createScenarioSongCalculator(rules,chart,{performanceScenario:{profile:'ap_timing'}}).calculate(draft,{includeTrace:true}),
   createCandidateEvaluator({rules,chart,objective:'maximum_song_score',performanceScenario:{profile:'ap_timing'}}).score(draft),
   estimateAPChart({rules,chart,draft,candidate:candidate(chart),basis:'ap_timing'}),
   estimateAPChart({rules,chart,draft,candidate:candidate(chart),basis:'ap_timing',mode:'challenge',eventId:1}),
  ];
  for(const result of outputs){
   assert.equal(hasApTimingInstructions(result.apTimingPlan),kind==='new_card',kind);
   assert.equal(result.apTimingPlan.order.length,5,kind);
   assert.ok(Number.isFinite(result.apTimingPlan.minimumScore)&&Number.isFinite(result.apTimingPlan.maximumScore),kind);
   if(kind==='new_card')assert.ok(result.apTimingPlan.score>result.apTimingPlan.onTimeMinimumScore);
   else assert.deepEqual(result.apTimingPlan.adjustments,[]);
  }
  assert.equal(outputs[0].expectedScore,outputs[1].value);
  assert.equal(outputs[0].expectedScore,outputs[2].estimatedScore);
 }
});

test('song grading retains original order scores while farming links carry the team without timing or its grade',()=>{
 const {rules,chart,draft}=timingFixture(),c=candidate(chart);
 rules.tables.LiveScoreRank.forEach((row,i)=>row._requiredScore=i===0?0:360000+(i-1)*100000);
 const original=structuredClone(draft),legacy=estimateAPChart({rules,chart,draft,candidate:c});
 const timing=estimateAPChart({rules,chart,draft,candidate:c,basis:'ap_timing'});
 for(const basis of ['expectedScore','minimumScore','maximumScore'])assert.deepEqual(applyAPBasis(timing,basis).estimatedScore,legacy[basis]);
 assert.deepEqual(timing.scoreDistribution,legacy.scoreDistribution);
 assert.equal(timing.estimatedScore,timing.apTimingPlan.score);assert.equal(timing.gradeProbabilities,null);
 assert.equal(applyAPBasis(timing,'maximumScore').scoreRank,2);assert.equal(timing.scoreRank,3);
 const model=createEventEfficiency({tables:rules.tables,sourceReleaseId:rules.sourceReleaseId,eventId:1});
 assert.throws(()=>eventGradeEstimate(model,100038,timing,'ap_timing'),/Invalid AP score basis/);
 assert.throws(()=>estimateEventSong({rules,model,chart,draft,candidate:c,options:{scoreBasis:'ap_timing'}}),/活动收益使用正拍估分/);
 assert.deepEqual(draft,original);
 const shared=withAPTimingBasis(draft,'ap_timing',timing.apTimingPlan);
 for(const options of [{basis:'ap_timing',scoreRank:3},{scoreRank:3}]){
  const params=new URLSearchParams(eventToolSearch(shared,options)),modifiers=JSON.parse(params.get('modifiers'));
  assert.equal(params.get('apBasis'),'expectedScore');assert.equal(params.has('scoreRank'),false);
  assert.equal(modifiers.performanceScenario,undefined);assert.equal(modifiers.apTimingPlan,undefined);
  for(const slot of draft.slots)for(const id of [slot.memberCardId,slot.supportCardId])assert.deepEqual(modifiers.growth[id],draft.modifiers.growth[id]);
  assert.equal(params.get('members'),draft.slots.map(s=>s.memberCardId).join(','));
 }
 assert.equal(new URLSearchParams(eventToolSearch(draft,{basis:'maximumScore',scoreRank:2})).get('scoreRank'),'2');
 assert.deepEqual(shared.modifiers.apTimingPlan,timing.apTimingPlan);
 assert.equal(withAPTimingBasis(shared,'expectedScore').modifiers.performanceScenario,undefined);
 assert.equal(withAPTimingBasis(shared,'expectedScore').modifiers.apTimingPlan,undefined);
});

test('both farming stages use on-time estimates even when applying a saved timing team',()=>{
 const {draft}=timingFixture();draft.modifiers.performanceScenario={profile:'ap_timing'};draft.modifiers.apTimingPlan={score:123};
 for(const [basis,challengeBasis] of [['maximumScore','expectedScore'],['expectedScore','minimumScore']]){
  const input={mode:'ordinary',draft,basis,challengeBasis,includeChallenge:true,scope:'selected',challengeScope:'owned'};
  for(const mode of ['ordinary','challenge']){
   const stage=eventYieldStageInput(input,mode);
   assert.equal(stage.basis,mode==='ordinary'?basis:challengeBasis);
   assert.equal(stage.scope,mode==='ordinary'?'selected':'owned');
   assert.equal(stage.draft.modifiers.performanceScenario,undefined);
   assert.equal(stage.draft.modifiers.apTimingPlan,undefined);
  }
 }
 assert.equal(draft.modifiers.apTimingPlan.score,123);
});

test('timing screening retains a weaker on-time team that beats two power alternatives after timing',async()=>{
 const {rules,chart,draft}=timingFixture();
 // Three legal alternatives, four locked pairs: two high-power no-skill cards
 // straddle the cumulative team's on-time score but lose to its timing plan.
 const powerCard=rules.tables.SupportCard.find(r=>r._id===6);powerCard._performancePowerMax=302187;
 rules.tables.SupportCard.push({...powerCard,_id:999,_performancePowerMax:301000});
 draft.modifiers.growth['support-card-999']={...draft.modifiers.growth['support-card-6']};
 const cumulative=structuredClone(draft);draft.slots[0].supportCardId='support-card-6';
 const inventory={memberCardIds:draft.slots.map(s=>s.memberCardId),supportCardIds:[1,2,3,4,5,6,999].map(i=>'support-card-'+i),growth:draft.modifiers.growth};
 const regular=createFormalSongCalculator(rules,chart),screen=createApTimingCalculator(rules,chart,{scorePrecision:'screen'});
 assert.ok(regular.calculate(cumulative).maximumScore<regular.calculate(draft).maximumScore);
 assert.ok(screen.calculate(cumulative).apTimingScreen.score>screen.calculate(draft).apTimingScreen.score);
 const result=await optimizePractical({rules,chart,draft,inventory,scope:'owned',performanceScenario:{profile:'ap_timing'},
  constraints:{lockedPairs:draft.slots.slice(1),leaderId:draft.slots[2].memberCardId},finalistLimit:2,yieldControl});
 assert.ok(result.practical.directions.some(row=>row.id==='cumulative'&&row.status==='generated'));
 assert.equal(result.results[0].draft.slots[0].supportCardId,'support-card-1');
 assert.ok(result.results[0].value>result.baseline);
 assert.equal(result.results[0].apTimingPlan.search.screenedOrders,120);
 assert.ok(result.results.every(row=>row.apTimingPlan&&!row.apTimingScreen));
});

test('saved timing plans do not change ordinary or challenge farming recommendations and certificates',async()=>{
 const {rules,chart,draft}=timingFixture();
 const shared=withAPTimingBasis(draft,'ap_timing',{score:9999999,adjustments:[{scoreIndex:0,timingOffsetMs:-25}]});
 for(const mode of ['ordinary','challenge'])for(const basis of ['expectedScore','minimumScore','maximumScore']){
  const options={rules,chart,draft,candidate:candidate(chart),eventId:1,scope:'selected',mode,basis,includeChallenge:false,yieldControl};
  const original=await optimizeEventYield(options),imported=await optimizeEventYield({...options,draft:shared});
  assert.ok(original.results.length);assert.deepEqual(imported.results,original.results,mode+':'+basis);
  assert.deepEqual(imported.certifiedSearch,original.certifiedSearch);
  for(const row of imported.results){assert.equal(row.apTimingPlan,undefined);assert.equal(row.draft.modifiers.apTimingPlan,undefined);}
 }
 assert.equal(shared.modifiers.apTimingPlan.score,9999999);
});

test('power-only recommendations ignore a saved AP timing scoring profile',async()=>{
 const {rules,chart,draft}=timingFixture(),options={rules,chart,draft,objective:'formation_power',yieldControl};
 const plain=await optimizePractical(options),timing=await optimizePractical({...options,performanceScenario:{profile:'ap_timing'}});
 assert.deepEqual(timing.results,plain.results);
});
