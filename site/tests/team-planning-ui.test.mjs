import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPlanningKind,createPlanningSettings,planningSettingsValues,planningSummary,updatePlanningCardPreference} from '../src/lib/team-planning-scenario-ui.mjs';
import {recommendationScenarioLabel,visibleRecommendations} from '../src/lib/optimizer-results-ui.mjs';
const draft={slots:[{memberCardId:'member-card-1',supportCardId:'support-card-1'},...Array.from({length:4},()=>({}))],modifiers:{growth:{'member-card-1':{level:1}}}};
const context={sourceReleaseId:'test-release',draft};
const form=(patch={})=>({kind:'reference',profile:'steady',timingBiasMs:0,timingSpreadMs:'',missPercent:'',startSeconds:'',endSeconds:'',explicit:'',...patch});
test('new visitors can calculate reference teams without importing cards',()=>{
  assert.equal(defaultPlanningKind({},{}),'reference');
  assert.equal(defaultPlanningKind({},draft),'selected');
  assert.equal(defaultPlanningKind({memberCardIds:['member-card-2']},draft),'current');
  const result=createPlanningSettings(form(),context);
  assert.equal(result.planningScenario.scope,'reference');assert.equal(result.planningScenario.referenceGrowth,'maximum');
  assert.equal(result.performanceScenario.profile,'steady');assert.equal(result.performanceScenario.samples,3);
});
test('cultivation caps and independent skill goals stay in a plan, not actual growth',()=>{
  const before=structuredClone(draft);
  const result=createPlanningSettings(form({kind:'training',maxTrainedCards:2,growthMode:'current-cap',skillLevel:'',gekisouSkillLevel:5,allowedCardIds:['member-card-1']}),context);
  assert.deepEqual(draft,before);assert.equal(result.planningScenario.plan.mode,'current-cap');
  assert.equal(result.planningScenario.plan.skillLevel,undefined);assert.equal(result.planningScenario.plan.gekisouSkillLevel,5);
  assert.equal(result.planningScenario.plan.maxTrainedCards,2);
  assert.throws(()=>createPlanningSettings(form({kind:'training',maxTrainedCards:1.5}),context),/整数/);
});
test('trial must name a card and keeps ownership separate',()=>{
  assert.throws(()=>createPlanningSettings(form({kind:'trial'}),context),/先加入/);
  const trial={memberCardIds:['member-card-6'],supportCardIds:[]};
  const result=createPlanningSettings(form({kind:'trial',trialCardIds:trial}),context);
  assert.equal(result.planningScenario.scope,'trial');
  assert.deepEqual(result.planningScenario.selectedCardIds.memberCardIds,['member-card-1']);
  result.planningScenario.trialCardIds.memberCardIds.push('member-card-7');assert.equal(trial.memberCardIds.length,1);
});
test('specific card targets survive settings restoration without overwriting current state',()=>{
  const settings=createPlanningSettings(form({kind:'training',maxTrainedCards:1,allowedCardIds:['member-card-1'],targets:{'member-card-1':{level:70}}}),context);
  const values=planningSettingsValues(settings);
  assert.equal(values.kind,'training');assert.equal(settings.planningScenario.plan.mode,'current-cap');assert.equal(values.targets['member-card-1'].level,70);
  assert.deepEqual(createPlanningSettings(values,context),settings);
  assert.match(planningSummary(values),/最多练 1 张/);
});
test('timing and difficult section inputs use explicit units and reject incomplete ranges',()=>{
  const result=createPlanningSettings(form({profile:'practice',missPercent:2,startSeconds:10,endSeconds:20}),context);
  assert.equal(result.performanceScenario.missRate,.02);
  assert.deepEqual(result.performanceScenario.difficultRanges,[{startMs:10000,endMs:20000,spreadMultiplier:2}]);
  assert.throws(()=>createPlanningSettings(form({startSeconds:10,endSeconds:''}),context),/都需要/);
  assert.throws(()=>createPlanningSettings(form({startSeconds:20,endSeconds:10}),context),/晚于/);
  assert.throws(()=>createPlanningSettings(form({missPercent:101}),context),/漏按比例/);
});
test('explicit replay is saved as an explicit input and malformed JSON is actionable',()=>{
  assert.throws(()=>createPlanningSettings(form({explicit:'invalid'}),context),/JSON/);
  const settings=createPlanningSettings(form({explicit:'{"events":[]}'}),context);
  assert.equal(settings.performanceScenario.profile,'explicit');assert.equal(settings.performanceScenario.samples,1);
  assert.deepEqual(JSON.parse(planningSettingsValues(settings).explicit),{events:[]});
});
test('recommendation labels distinguish reference and training from actual inventory',()=>{
  assert.equal(recommendationScenarioLabel({draft:{modifiers:{planningScenario:{scope:'reference'}}}}),'参考队伍 · 满养成');
  assert.equal(recommendationScenarioLabel({draft:{modifiers:{planningScenario:{scope:'owned',plan:{enabled:true}}}}}),'培养计划');
  assert.equal(recommendationScenarioLabel({planning:{missingActual:true}}),'包含参考养成');
});
test('duplicate direction results do not fill all visible recommendation slots',()=>{
  const result=n=>({draft:{slots:[{memberCardId:`member-card-${n}`}],modifiers:{growth:{}}}});
  assert.equal(visibleRecommendations([result(1),result(1),result(2),result(3),result(4)]).length,3);
  assert.equal(visibleRecommendations([result(1),result(1)]).length,1);
});

test('simple keep and exclude controls preserve other constraints and never keep both',()=>{
  const original={bandId:1,requiredMemberIds:['member-card-1'],lockedPairs:[{memberCardId:'member-card-2',supportCardId:'support-card-2'}]};
  const excluded=updatePlanningCardPreference(original,{kind:'member',id:'member-card-1',preference:'exclude'});
  assert.equal(excluded.requiredMemberIds,undefined);assert.deepEqual(excluded.excludedMemberIds,['member-card-1']);
  assert.equal(excluded.bandId,1);assert.deepEqual(excluded.lockedPairs,original.lockedPairs);assert.deepEqual(original.requiredMemberIds,['member-card-1']);
  const clear=updatePlanningCardPreference(excluded,{kind:'member',id:'member-card-1',preference:''});assert.equal(clear.excludedMemberIds,undefined);
});

test('hand-selected cards can form an upgrade plan without an imported inventory',()=>{
  const before=structuredClone(draft);
  const settings=createPlanningSettings(form({kind:'training',trainingScope:'selected',maxTrainedCards:1,allowedCardIds:['member-card-1']}),context);
  assert.equal(settings.planningScenario.scope,'selected');
  assert.equal(settings.planningScenario.plan.maxTrainedCards,1);
  assert.deepEqual(settings.planningScenario.selectedCardIds,{memberCardIds:['member-card-1'],supportCardIds:['support-card-1']});
  assert.equal(settings.planningScenario.inventory,undefined);
  assert.equal(settings.planningScenario.unknownGrowth,'exclude');
  assert.deepEqual(draft,before);
  const restored=planningSettingsValues(settings);assert.equal(restored.kind,'training');assert.equal(restored.trainingScope,'selected');
  assert.deepEqual(createPlanningSettings(restored,context),settings);
});
