import test from 'node:test';
import assert from 'node:assert/strict';
import {maximizeAccount,tgwBonusRanges} from '../src/lib/workbench-account-model.mjs';
import {pairingRelations} from '../src/lib/workbench-team-view.mjs';
import {bandItemEffects} from '../../packages/scoring/scoring-rules/band-item-totals.mjs';
import {createSharedTeamRules} from './fixtures/shared-team-rules.mjs';

test('TGW choices group equal formation bonuses despite changing other VIP perks',()=>{
 const rows=[{rank:1,bonuses:[]},{rank:2,bonuses:[{type:7,rawValue:500}]},{rank:3,bonuses:[{type:7,rawValue:500},{type:1,rawValue:20}]},{rank:4,bonuses:[{type:7,rawValue:1000}]}];
 assert.deepEqual(tgwBonusRanges(rows).map(r=>[r.min,r.max]),[[1,1],[2,3],[4,4]]);assert.equal(tgwBonusRanges(rows)[1].bonuses.length,1);
});
test('max all derives caps, replaces aggregates, preserves memories and never mutates profile inputs',()=>{
 const rules=createSharedTeamRules(),input={bandItemTotals:{1:1},memoryPoints:{1:123},growth:{'member-card-1':{rank:1}},characterRanks:{1:1}},before=structuredClone(input);
 const next=maximizeAccount(input,rules,[{rank:1},{rank:4}]);assert.deepEqual(input,before);assert.deepEqual(next.memoryPoints,input.memoryPoints);assert.deepEqual(next.growth,input.growth);assert.deepEqual(next.bandItemTotals,{});assert.equal(next.tgwCardRank,4);
 for(const character of rules.tables.Character)assert.equal(next.characterRanks[character._id],Math.max(...rules.tables.CharacterRank.map(r=>r._rank)));
 assert.ok(bandItemEffects(rules,next).length);assert.deepEqual(maximizeAccount(input,rules,[],'tgw'),input);
});
test('pair identity badges intersect canonical band/attribute IDs and do not imply a numeric bonus',()=>{
 const member={attributeCode:1,bandIds:['band-2']},support={attributeCode:1,bandIds:['band-1','band-2']};
 assert.deepEqual(pairingRelations(member,support).map(r=>r.kind),['attribute','band']);assert.deepEqual(pairingRelations(member,{attributeCode:2,bandIds:['band-3']}),[]);assert.deepEqual(pairingRelations(null,support),[]);
});
