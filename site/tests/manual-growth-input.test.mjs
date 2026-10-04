import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmManualGrowth,incompleteManualGrowth} from '../src/lib/manual-growth-input.mjs';
import {resolveGrowthScenario,prepareGrowthCandidate} from '../src/lib/scoring-rules/growth-scenarios.mjs';
import {resolveSearchInput} from '../src/lib/scoring-rules/formation-input.mjs';
function fixture(){
 const rates={_performanceRate:10000,_technicRate:10000,_visualRate:10000};
 const rules={schemaVersion:1,sourceReleaseId:'manual-growth-test',verificationStatus:'code_audited',tables:{
  MemberCard:[],SupportCard:[],Character:[],SkillTarget:[],LiveSkill:[],GekisouSkill:[],Parameter:[],
  MemberCardRank:[{_group:1,_rank:1,...rates}],SupportCardRank:[{_group:1,_rank:1,_limitLevel:20,...rates}],
  MemberCardAwake:[{_group:1,_awakeCount:1,...rates}],MemberCardLevelLimit:[{_rarity:4,_awakeCount:1,_limitLevel:20}],
  MemberCardLevel:Array.from({length:20},(_,i)=>({_group:1,_level:i+1,...rates})),SupportCardLevel:Array.from({length:20},(_,i)=>({_group:1,_level:i+1,...rates}))
 }};
 const draft={slots:[],modifiers:{growth:{}}};
 for(let i=51;i<=55;i++){
  rules.tables.Character.push({_id:i,_bandID:1});
  rules.tables.MemberCard.push({_id:i,_characterID:i,_rarity:4,_cardType:1,_memberCardRankGroup:1,_memberCardLevelGroup:1,_memberCardAwakeGroup:1,_performancePowerMax:100,_technicPowerMax:100,_visualPowerMax:100});
  rules.tables.SupportCard.push({_id:i,_cardType:1,_supportCardRankGroup:1,_supportCardLevelGroup:1,_performancePowerMax:100,_technicPowerMax:100,_visualPowerMax:100});
  const memberCardId=`member-card-${i}`,supportCardId=`support-card-${i}`;draft.slots.push({memberCardId,supportCardId});
  draft.modifiers.growth[memberCardId]={level:10};draft.modifiers.growth[supportCardId]={level:10};
 }
 return {rules,draft};
}
test('explicit slot confirmation makes partial manual inputs usable without inventing ownership',()=>{
 const {rules,draft}=fixture(),before=structuredClone(draft),ids=draft.slots.flatMap(s=>[s.memberCardId,s.supportCardId]);
 const scenario={scope:'selected',unknownGrowth:'exclude',plan:{mode:'current-cap',maxTrainedCards:1}};
 assert.equal(incompleteManualGrowth(draft,ids).length,10);
 assert.equal(resolveGrowthScenario(rules,draft,scenario).excludedCardIds.length,10);
 assert.throws(()=>resolveSearchInput(rules,draft,{planningScenario:scenario}),/至少五位/);
 let confirmed=draft;
 for(const slot of draft.slots)confirmed=confirmManualGrowth(rules,confirmed,[slot.memberCardId,slot.supportCardId]);
 assert.deepEqual(draft,before);assert.equal(incompleteManualGrowth(confirmed,ids).length,0);
 const input=resolveSearchInput(rules,confirmed,{planningScenario:scenario});
 assert.equal(input.inventory.memberCardIds.length,5);assert.equal(input.inventory.supportCardIds.length,5);
 const prepared=prepareGrowthCandidate(rules,input.growthScenario,confirmed,{trainedCardIds:['member-card-51']});
 assert.equal(prepared.comparison.actualAvailable,true);assert.equal(prepared.comparison.actualTeamAvailable,false);
 assert.equal(prepared.comparison.unknownOwnershipIds.length,10);assert.equal(prepared.comparison.trainedCardCount,1);
 assert.equal(confirmed.modifiers.growth['member-card-51'].skillLevel,1);
});
test('confirmation reads displayed form values even when change or blur has not fired',()=>{
 const {rules,draft}=fixture();draft.modifiers.growth['member-card-51']={};
 const confirmed=confirmManualGrowth(rules,draft,['member-card-51'],{displayedGrowth:{'member-card-51':{level:12,rank:1,awake:1,skillLevel:3,gekisouSkillLevel:2}}});
 assert.equal(confirmed.modifiers.growth['member-card-51'].level,12);assert.equal(confirmed.modifiers.growth['member-card-51'].skillLevel,3);
 assert.deepEqual(draft.modifiers.growth['member-card-51'],{});
});
test('blank and out-of-range levels cannot be confirmed as actual',()=>{
 const {rules,draft}=fixture();delete draft.modifiers.growth['member-card-51'].level;
 assert.throws(()=>confirmManualGrowth(rules,draft,['member-card-51']),/实际等级/);
 assert.throws(()=>confirmManualGrowth(rules,draft,['member-card-51'],{displayedGrowth:{'member-card-51':{level:21}}}),/level/);
 assert.throws(()=>confirmManualGrowth(rules,draft,['member-card-999']),/当前队伍/);
});
test('only explicit confirmation refreshes a saved plan actual baseline',()=>{
 const {rules,draft}=fixture();draft.modifiers.planningResult={schemaVersion:1,sourceReleaseId:rules.sourceReleaseId,actualGrowth:{'member-card-51':null}};
 assert.equal(incompleteManualGrowth(draft,['member-card-51']).length,1);
 const confirmed=confirmManualGrowth(rules,draft,['member-card-51']);
 assert.equal(confirmed.modifiers.planningResult.actualGrowth['member-card-51'].level,10);
 assert.equal(draft.modifiers.planningResult.actualGrowth['member-card-51'],null);
});
