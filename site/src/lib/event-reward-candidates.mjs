import {createInventoryManager} from './inventory-manager.mjs';
import {createFormationCalculator} from './scoring-rules/formation-power.mjs';

/** Expand a calculation copy only. Stored ownership and actual growth never change. */
export function withEventRewardCandidates({rules,draft,scope,inventory,rewardCards=[],rewardGrowth='level',rewardGrowthOverride=false}) {
 if(!rewardCards.length||scope==='reference')return {draft,scope,inventory,temporaryCardIds:[]};
 if(typeof rewardGrowthOverride!=='boolean')throw Error('无效的活动奖励卡养成覆盖选项');
 if(!['level','maximum'].includes(rewardGrowth))throw Error('无效的活动奖励卡养成基准');
 const next=structuredClone(draft),manager=createInventoryManager(rules),calculator=createFormationCalculator(rules);
 if(scope==='owned'&&!inventory)throw Error('请先导入实际卡库');
 const pool=scope==='owned'?manager.validate(inventory):{schemaVersion:1,sourceReleaseId:rules.sourceReleaseId,
  memberCardIds:[...new Set(draft.slots.map(s=>s.memberCardId).filter(Boolean))],supportCardIds:[...new Set(draft.slots.map(s=>s.supportCardId).filter(Boolean))],growth:{}};
 if(!pool)throw Error('请先导入实际卡库');
 pool.growth??={};next.modifiers??={};next.modifiers.growth??={};
 for(const kind of ['member','support'])for(const id of pool[`${kind}CardIds`]){
  const supplied={...pool.growth[id],...next.modifiers.growth[id]};
  const resolved=calculator.resolveGrowth(calculator.card(id,kind),kind==='member'?'Member':'Support',supplied);
  pool.growth[id]={level:resolved.level,rank:resolved.rank,...(kind==='member'?{awake:resolved.awake,skillLevel:supplied.skillLevel??1,gekisouSkillLevel:supplied.gekisouSkillLevel??1}:{})};
 }
 const temporaryCardIds=[],assumedCardIds=[],rewardGrowthCardIds=[],actualGrowth={};
 for(const card of rewardCards){
  const kind=card.resourceType===2?'member':card.resourceType===3?'support':null;
  if(!kind)continue;
  const id=`${kind}-card-${card.resourceId}`;calculator.card(id,kind);
  const included=pool[`${kind}CardIds`].includes(id),owned=inventory?.[`${kind}CardIds`]?.includes(id);
  if(included&&!rewardGrowthOverride)continue;
  if(!included)pool[`${kind}CardIds`].push(id);
  if(owned&&!rewardGrowthOverride){
   const actual=manager.validate(inventory).growth[id];pool.growth[id]=structuredClone(actual);next.modifiers.growth[id]=structuredClone(actual);continue;
  }
  if(!included&&!owned)temporaryCardIds.push(id);
  assumedCardIds.push(id);
  actualGrowth[id]=owned?structuredClone(inventory.growth[id]):null;
  if(rewardGrowthOverride)rewardGrowthCardIds.push(id);
  pool.growth[id]=manager.preset(id,kind,rewardGrowth);
  // The explicit reward assumption wins over both saved and current-team growth.
  next.modifiers.growth[id]=structuredClone(pool.growth[id]);
 }
 Object.assign(next.modifiers.growth,pool.growth);
 const previous=next.modifiers.planningResult??={schemaVersion:1,sourceReleaseId:rules.sourceReleaseId,actualGrowth:{}};
 previous.actualGrowth??={};Object.assign(previous.actualGrowth,actualGrowth);
 if(rewardGrowthCardIds.length)previous.rewardGrowthCardIds=[...new Set([...(previous.rewardGrowthCardIds??[]),...rewardGrowthCardIds])];
 previous.referenceCardIds=[...new Set([...(previous.referenceCardIds??[]),...assumedCardIds])];
 return {draft:next,scope:'owned',inventory:pool,temporaryCardIds};
}
