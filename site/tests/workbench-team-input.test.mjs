import test from 'node:test';
import assert from 'node:assert/strict';
import {materializeTeamAssumptions} from '../src/lib/workbench-team-input.mjs';
import {resolveTeamCardGrowth} from '../src/lib/team-card-view.mjs';
import {createSharedTeamRules} from './fixtures/shared-team-rules.mjs';
import {createTeamDraft} from '../src/lib/team-draft.mjs';
const rules=createSharedTeamRules(),card={id:'member-card-1',kind:'member'},data={formalRules:rules,memberCards:[card],supportCards:[]};
test('direct tools execute explicit reference growth and preserve its missing actual baseline',()=>{
 const draft=createTeamDraft({slots:[{memberCardId:card.id}],modifiers:{planningScenario:{scope:'selected',unknownGrowth:'reference',referenceGrowth:'maximum'}}}),before=structuredClone(draft);
 const next=materializeTeamAssumptions(draft,data);assert.deepEqual(draft,before);assert.notEqual(next,draft);
 assert.equal(next.modifiers.growth[card.id].level,70);assert.equal(next.modifiers.growth[card.id].rank,5);
 assert.equal(next.modifiers.planningResult.actualGrowth[card.id],null);assert.deepEqual(next.modifiers.planningResult.referenceCardIds,[card.id]);
 assert.equal(resolveTeamCardGrowth({card,draft:next,rules}).source,'reference');assert.equal(materializeTeamAssumptions(next,data),next);
});
test('ordinary defaults, exclusion policies and known actual input are not maximized',()=>{
 const draft=createTeamDraft({slots:[{memberCardId:card.id}]});assert.equal(materializeTeamAssumptions(draft,data),draft);
 draft.modifiers.planningScenario={scope:'selected',unknownGrowth:'exclude'};assert.equal(materializeTeamAssumptions(draft,data),draft);
 const inventory={memberCardIds:[card.id],growth:{[card.id]:{level:1,rank:1,awake:1,skillLevel:1,gekisouSkillLevel:1}}},before=structuredClone(inventory);
 draft.modifiers.planningScenario.unknownGrowth='reference';assert.equal(materializeTeamAssumptions(draft,data,inventory),draft);assert.deepEqual(inventory,before);
});
