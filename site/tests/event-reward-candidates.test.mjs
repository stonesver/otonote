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

test('explicit reward growth overrides owned cards inside and outside the team without changing originals',()=>{
 const manager=createInventoryManager(rules);
 const rewards=[{resourceType:2,resourceId:1},{resourceType:3,resourceId:1},...rewardCards];
 const inventory={memberCardIds:['member-card-1','member-card-6'],supportCardIds:['support-card-1','support-card-70'],growth:{}};
 for(const kind of ['member','support'])for(const id of inventory[`${kind}CardIds`])inventory.growth[id]=manager.preset(id,kind);
 for(const scope of ['owned','selected'])for(const rewardGrowth of ['level','maximum']){
  const before=structuredClone({draft,inventory});
  const result=withEventRewardCandidates({rules,draft,scope,inventory,rewardCards:rewards,rewardGrowth,rewardGrowthOverride:true});
  for(const kind of ['member','support'])for(const id of inventory[`${kind}CardIds`]){
   assert.deepEqual(result.inventory.growth[id],manager.preset(id,kind,rewardGrowth));
   assert.deepEqual(result.draft.modifiers.growth[id],manager.preset(id,kind,rewardGrowth));
   assert.deepEqual(result.draft.modifiers.planningResult.actualGrowth[id],inventory.growth[id]);
   assert.ok(result.draft.modifiers.planningResult.rewardGrowthCardIds.includes(id));
  }
  if(scope==='selected')assert.equal(result.inventory.growth['member-card-2'].skillLevel,1);
  assert.deepEqual({draft,inventory},before);assert.deepEqual(result.temporaryCardIds,[]);
 }
});

test('override has a distinct cache partition and is ignored when rewards are absent or scope is reference',async()=>{
 const input={draft,scope:'selected',rewardCards,rewardGrowth:'maximum'};
 assert.equal(await eventSearchPartition(rules,1,input),await eventSearchPartition(rules,1,{...input,rewardGrowthOverride:false}));
 assert.notEqual(await eventSearchPartition(rules,1,input),await eventSearchPartition(rules,1,{...input,rewardGrowthOverride:true}));
 for(const options of [{scope:'selected',rewardCards:[]},{scope:'reference',rewardCards}]){
  const result=withEventRewardCandidates({rules,draft,...options,rewardGrowthOverride:true});
  assert.equal(result.draft,draft);assert.deepEqual(result.temporaryCardIds,[]);
 }
 assert.throws(()=>withEventRewardCandidates({rules,draft,scope:'selected',rewardCards,rewardGrowthOverride:'true'}),/覆盖选项/);
});

test('reward result cards display the explicit assumption even with an owned planning scenario',async()=>{
 const {resolveTeamCardGrowth}=await import('../src/lib/team-card-view.mjs');
 const {eventRewardGrowthNote}=await import('../src/lib/event-reward-options.mjs');
 const manager=createInventoryManager(rules),inventory={memberCardIds:['member-card-6'],supportCardIds:['support-card-70'],growth:{'member-card-6':manager.preset('member-card-6','member'),'support-card-70':manager.preset('support-card-70','support')}};
 const selected=structuredClone(draft);selected.modifiers={planningScenario:{scope:'owned'}};
 const result=withEventRewardCandidates({rules,draft:selected,scope:'owned',inventory,rewardCards,rewardGrowth:'maximum',rewardGrowthOverride:true});
 for(const kind of ['member','support'])for(const id of inventory[`${kind}CardIds`]){
  const display=resolveTeamCardGrowth({card:{id,kind},draft:result.draft,inventory,rules});
  assert.equal(display.source,'selected');assert.deepEqual(display.growth,manager.preset(id,kind,'maximum'));
 }
 assert.match(eventRewardGrowthNote('maximum',true),/包含已持有卡/);
 assert.match(eventRewardGrowthNote('maximum',false),/实际养成/);
});
