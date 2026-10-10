import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {withEventRewardCandidates} from '../src/lib/event-reward-candidates.mjs';
import {createInventoryManager} from '../src/lib/inventory-manager.mjs';
import {createTeamDraft} from '../src/lib/team-draft.mjs';
import {resolveSearchInput} from '../src/lib/scoring-rules/formation-input.mjs';
import {eventSearchPartition} from '../src/lib/event-search-cache.mjs';
const rules=JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json',import.meta.url)));
const draft=createTeamDraft({slots:[1,2,3,4,5].map(i=>({memberCardId:`member-card-${i}`,supportCardId:`support-card-${i}`}))});
const rewardCards=[{resourceType:2,resourceId:6},{resourceType:3,resourceId:70}];
test('both reward card kinds enter the real candidate pool without changing input ownership',()=>{
 const original=structuredClone(draft),result=withEventRewardCandidates({rules,draft,scope:'selected',rewardCards});
 assert.deepEqual(draft,original);assert.equal(result.scope,'owned');
 assert.ok(result.inventory.memberCardIds.includes('member-card-6'));assert.ok(result.inventory.supportCardIds.includes('support-card-70'));
 assert.deepEqual(result.temporaryCardIds,['member-card-6','support-card-70']);
 const input=resolveSearchInput(rules,result.draft,result);
 assert.equal(input.inventory.memberCardIds.length,6);assert.equal(input.inventory.supportCardIds.length,6);
 assert.equal(result.inventory.growth['member-card-6'].skillLevel,1);
 assert.equal(result.draft.modifiers.planningResult.actualGrowth['member-card-6'],null);
});
test('owned rewards keep their actual growth, even when maximum temporary growth is requested',()=>{
 const manager=createInventoryManager(rules),inventory={memberCardIds:['member-card-6'],supportCardIds:['support-card-70'],growth:{'member-card-6':manager.preset('member-card-6','member'),'support-card-70':manager.preset('support-card-70','support')}};
 const before=structuredClone(inventory),result=withEventRewardCandidates({rules,draft,scope:'owned',inventory,rewardCards,rewardGrowth:'maximum'});
 assert.deepEqual(inventory,before);assert.deepEqual(result.inventory.growth,inventory.growth);assert.deepEqual(result.temporaryCardIds,[]);
});
test('reward assumptions are validated and get distinct calculation cache partitions',async()=>{
 assert.throws(()=>withEventRewardCandidates({rules,draft,scope:'owned',inventory:{memberCardIds:['member-card-1'],supportCardIds:[],growth:{}},rewardCards}),/等级|养成/);
 assert.throws(()=>withEventRewardCandidates({rules,draft,scope:'selected',rewardCards:[{resourceType:2,resourceId:999999}]}),/Unknown/);
 const plain={draft,scope:'selected'},temp={...plain,rewardCards,rewardGrowth:'level'};
 assert.notEqual(await eventSearchPartition(rules,1,plain),await eventSearchPartition(rules,1,temp));
 assert.notEqual(await eventSearchPartition(rules,1,temp),await eventSearchPartition(rules,1,{...temp,rewardGrowth:'maximum'}));
 assert.deepEqual(withEventRewardCandidates({rules,draft,scope:'reference',rewardCards}).temporaryCardIds,[]);
});
test('current-team expansion uses saved actual growth for an unselected reward card',()=>{
 const manager=createInventoryManager(rules),actual=manager.preset('member-card-6','member'),inventory={memberCardIds:['member-card-6'],supportCardIds:[],growth:{'member-card-6':actual}};
 const result=withEventRewardCandidates({rules,draft,scope:'selected',inventory,rewardCards,rewardGrowth:'maximum'});
 assert.deepEqual(result.inventory.growth['member-card-6'],actual);
 assert.deepEqual(result.temporaryCardIds,['support-card-70']);
});
