/** Aggregate inputs are allowed only when every item in a band has identical linear effects. */
const cache=new WeakMap();
// Rule tables are immutable within a release. Index rows, not mutable account
// settings: every call must still observe and validate the current item levels.
const lookupCache=new WeakMap();
function bandItemLookup(rules){
  if(lookupCache.has(rules))return lookupCache.get(rules);
  const byBand=new Map(),byItem=new Map(),byLevel=new Map();
  for(const group of bandItemGroups(rules)){
    byBand.set(String(group.bandId),group);
    for(const item of group.items)if(!byItem.has(String(item.id)))byItem.set(String(item.id),group);
  }
  for(const row of rules.tables.BandItemSkillEffect){
    const id=row._bandItemId,level=row._level;
    if(id!==id||level!==level)continue; // Preserve strict-equality lookup semantics.
    if(!byLevel.has(id))byLevel.set(id,new Map());
    const levels=byLevel.get(id);
    if(!levels.has(level))levels.set(level,[]);
    levels.get(level).push(row); // Preserve all rows and their original order.
  }
  const result={byBand,byItem,byLevel};lookupCache.set(rules,result);return result;
}
const signature=r=>JSON.stringify([r._skillEffectType,[...r._skillTargetIDs].sort((a,b)=>a-b),r._skillConditionGroup??0,r._skillCumulativeConditionID??0]);
export function bandItemGroups(rules){
  if(cache.has(rules))return cache.get(rules);
  const groups=new Map();
  for(const item of rules.tables.BandItem){
    const effects=rules.tables.BandItemSkillEffect.filter(e=>e._bandItemId===item._id);
    const maxLevel=Math.max(0,...effects.map(e=>e._level)),units=effects.filter(e=>e._level===1).sort((a,b)=>signature(a).localeCompare(signature(b)));
    const unitKey=JSON.stringify(units.map(e=>[signature(e),e._effectValue]));
    const group=groups.get(item._bandId)??{bandId:item._bandId,items:[],maxTotal:0,supported:true,units,unitKey};
    group.supported&&=maxLevel>0&&units.length>0&&group.unitKey===unitKey;
    for(let level=1;level<=maxLevel;level++){
      const rows=effects.filter(e=>e._level===level).sort((a,b)=>signature(a).localeCompare(signature(b)));
      group.supported&&=rows.length===units.length&&rows.every((e,i)=>signature(e)===signature(units[i])&&Number.isFinite(e._effectValue)&&e._effectValue===units[i]._effectValue*level&&!e._skillConditionGroup&&!e._skillCumulativeConditionID);
    }
    group.items.push({id:item._id,maxLevel});group.maxTotal+=maxLevel;groups.set(item._bandId,group);
  }
  const result=[...groups.values()];cache.set(rules,result);return result;
}
export function validateBandItemTotals(rules,totals){
  if(!totals||typeof totals!=='object'||Array.isArray(totals))throw Error('乐队总等级格式无效');
  const {byBand}=bandItemLookup(rules),result={};
  for(const [id,total] of Object.entries(totals)){
    const group=byBand.get(id);
    if(!group?.supported)throw Error(`乐队 ${id} 暂不支持按总等级填写`);
    if(!Number.isSafeInteger(total)||total<0||total>group.maxTotal)throw Error(`乐队 ${id} 总等级须为 0–${group.maxTotal}`);
    result[id]=total;
  }
  return result;
}
export function bandItemEffects(rules,modifiers){
  const totals=validateBandItemTotals(rules,modifiers.bandItemTotals??{}),{byBand,byItem,byLevel}=bandItemLookup(rules),effects=[];
  for(const [id,total] of Object.entries(totals))for(const unit of byBand.get(id).units)effects.push({...unit,_effectValue:unit._effectValue*total});
  for(const [id,level] of Object.entries(modifiers.bandItems??{})){
    const group=byItem.get(id);
    if(!group)throw Error(`Unknown instrument ${id}`);
    if(Object.hasOwn(totals,group.bandId))continue; // Aggregate replaces this band's detail; never add both.
    const rows=byLevel.get(Number(id))?.get(level)??[];
    if(!Number.isSafeInteger(level)||level<0||(level>0&&!rows.length))throw Error(`Unknown instrument/level ${id}/${level}`);
    if(level)effects.push(...rows);
  }
  return effects;
}
