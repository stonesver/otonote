import test from 'node:test';
import assert from 'node:assert/strict';
import {filterTeamCards,teamCardFilterOptions} from '../src/lib/team-card-filters.mjs';
const cards=[
 {id:'member-card-1',displayName:'First stage',relationLabel:'Alpha Band',attributeCode:1,bandIds:['band-1'],characterIds:['character-1'],rarity:2,rarityLabel:'SR'},
 {id:'support-card-2',displayName:'Second stage',attributeCode:2,bandIds:['band-1','band-2'],featuredCharacterIds:['character-1','character-2'],rarity:4,rarityLabel:'SSR'},
 {id:'member-card-3',displayName:'Third',attributeCode:1,bandIds:['band-2'],characterIds:['character-3'],rarity:4,rarityLabel:'SSR'}
];
test('all facets intersect using canonical or numeric IDs, including multi-character snaps',()=>{
 assert.deepEqual(filterTeamCards(cards,{band:1,character:'character-1',rarity:'4'}).map(card=>card.id),['support-card-2']);
 assert.deepEqual(filterTeamCards(cards,{query:'alpha stage',attribute:'1',ownership:'owned',owned:new Set(['member-card-1'])}).map(card=>card.id),['member-card-1']);
 assert.deepEqual(filterTeamCards(cards,{ownership:'unowned',owned:['member-card-1','member-card-3']}).map(card=>card.id),['support-card-2']);
});
test('sorting is stable and immutable; unknown levels sort after known records',()=>{
 const original=structuredClone(cards);assert.deepEqual(filterTeamCards(cards,{sort:'level-desc',growth:{'member-card-1':{level:1},'member-card-3':{level:20}}}).map(card=>card.id),['member-card-3','member-card-1','support-card-2']);
 assert.equal(filterTeamCards(cards,{sort:'rarity-desc'})[0].rarity,4);assert.deepEqual(cards,original);assert.notEqual(filterTeamCards(cards),cards);
});
test('filter options reuse real labels and icon mappings without duplicate canonical identities',()=>{
 const options=teamCardFilterOptions(cards,{filterVisualOptions:{band:[{value:'1',id:'band-1',label:'Alpha',icon:'/band1.png'}]},bands:[{id:2,name:'Beta'}],characters:[{id:1,name:'One'}]});
 assert.deepEqual(options.band,[{value:'1',label:'Alpha',icon:'/band1.png'},{value:'2',label:'Beta'}]);assert.equal(options.character[0].label,'One');assert.equal(options.rarity[0].label,'SR');
});
