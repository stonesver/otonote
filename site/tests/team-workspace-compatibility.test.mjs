import test from 'node:test';
import assert from 'node:assert/strict';
import {createSharedTeamRules} from './fixtures/shared-team-rules.mjs';
import {checkTeamCompatibility,mergeTeamForTool} from '../src/lib/team-workspace-compatibility.mjs';
import {createTeamDraft} from '../src/lib/team-draft.mjs';
const rules=createSharedTeamRules();
const draft=()=>createTeamDraft({slots:[1,2,3,4,5].map(id=>({memberCardId:`member-card-${id}`,supportCardId:`support-card-${id}`}))});

test('only explicit restrictions disable cards; bonus metadata never becomes a ban',()=>{
 const d=draft();assert.equal(checkTeamCompatibility(d,{rules,bonusMemberIds:['member-card-1'],bonusBandIds:[99]}).compatible,true);
 const checked=checkTeamCompatibility(d,{rules,allowedMemberIds:new Set(['member-card-1']),allowedSupportIds:['support-card-1']});
 assert.equal(checked.compatible,false);assert.equal(checked.slots[0].compatible,true);assert.equal(checked.slots[1].compatible,false);
 assert.equal(checked.issues.length,8);assert.equal(checked.issues[0].slot,1);
 assert.equal(checkTeamCompatibility(d,{rules,allowedBandIds:[]}).issues.length,5);
 assert.equal(checkTeamCompatibility(d,{rules,allowedAttributes:[]}).issues.length,5);
});
test('actual-only tools reject unowned, reference, and trial scenarios without mutating saved teams',()=>{
 const d=draft(), inventory={memberCardIds:d.slots.map(s=>s.memberCardId),supportCardIds:d.slots.map(s=>s.supportCardId)};
 assert.equal(checkTeamCompatibility(d,{rules,inventory,requireOwned:true}).compatible,true);
 inventory.memberCardIds.pop();assert.equal(checkTeamCompatibility(d,{rules,inventory,requireOwned:true}).issues[0].code,'not_owned');
 d.modifiers.planningScenario={scope:'reference'};const before=structuredClone(d);
 assert.ok(checkTeamCompatibility(d,{rules,inventory,requireOwned:true,supportedScopes:['owned']}).issues.some(i=>i.code==='scope_unsupported'));
 assert.ok(checkTeamCompatibility(d,{rules,inventory,requireOwned:true}).issues.some(i=>i.code==='hypothetical_team'));assert.deepEqual(d,before);
});
test('song restrictions and duplicate characters are surfaced consistently per slot',()=>{
 const d=draft();d.selectedSongId='music-1';assert.equal(checkTeamCompatibility(d,{rules,allowedTrackIds:[]}).issues[0].code,'song_restricted');
 d.slots[1].memberCardId=d.slots[0].memberCardId;
 const checked=checkTeamCompatibility(d,{rules});assert.ok(checked.slots[1].issues.some(i=>i.code==='duplicate_character'));
 d.slots[0].supportCardId=null;assert.ok(checkTeamCompatibility(d,{rules}).issues.some(i=>i.code==='missing_card'));
});
test('applying a team preserves song, mode, event, account, and rank while replacing formation and growth semantics',()=>{
 const current=draft();current.selectedSongId='music-current';current.selectedDifficulty='hard';current.modifiers={event:{id:2},gekisouScenario:{ranks:[3,2,1]},tgwCardRank:2,performanceScenario:{kind:'current'},planningScenario:{scope:'owned'},planningResult:{old:true},growth:{old:{level:1}}};
 const incoming=draft();incoming.slots.reverse();incoming.selectedSongId='music-incoming';incoming.modifiers={event:{id:99},gekisouScenario:{ranks:[1,1,1]},tgwCardRank:21,performanceScenario:{kind:'incoming'},growth:{'member-card-1':{level:2}}};
 const original=structuredClone(current), merged=mergeTeamForTool(current,incoming);
 assert.deepEqual(current,original);assert.equal(merged.selectedSongId,'music-current');assert.equal(merged.selectedDifficulty,'hard');assert.deepEqual(merged.modifiers.event,{id:2});assert.equal(merged.modifiers.tgwCardRank,2);assert.deepEqual(merged.modifiers.gekisouScenario,{ranks:[3,2,1]});
 assert.deepEqual(merged.slots,incoming.slots);assert.deepEqual(merged.modifiers.growth,incoming.modifiers.growth);assert.equal(merged.modifiers.planningScenario,undefined);assert.equal(merged.modifiers.planningResult,undefined);assert.deepEqual(merged.modifiers.performanceScenario,{kind:'current'});
 assert.deepEqual(mergeTeamForTool(current,incoming,{includePerformance:true}).modifiers.performanceScenario,{kind:'incoming'});
 merged.slots[0].memberCardId=null;assert.ok(incoming.slots[0].memberCardId);
});

test('editing may apply an incomplete formation, but calculation checks still require ten cards',()=>{
 const d=createTeamDraft();assert.equal(checkTeamCompatibility(d,{rules,requireComplete:false}).compatible,true);
 assert.equal(checkTeamCompatibility(d,{rules}).issues.length,10);
});
