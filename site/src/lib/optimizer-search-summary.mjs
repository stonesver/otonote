import {selectedControlValues} from './filter-controls.mjs';
// Counts a conservative space before mandatory/locked-pair constraints.
// Distinct-character selection is counted exactly by the elementary symmetric sum.
export function summarizeSearchSpace(rules,input) {
  const rows=new Map(rules.tables.MemberCard.map(r=>[`member-card-${r._id}`,r])),groups=new Map();
  for(const id of input.inventory.memberCardIds){const character=rows.get(id)._characterID;groups.set(character,(groups.get(character)??0)+1);}
  const dp=[1n,0n,0n,0n,0n,0n];
  for(const count of groups.values())for(let n=5;n>=1;n--)dp[n]+=dp[n-1]*BigInt(count);
  const supportCount=input.inventory.supportCardIds.length;
  const pairings=supportCount<5?0n:Array.from({length:5},(_,i)=>BigInt(supportCount-i)).reduce((a,b)=>a*b,1n);
  const combinations=dp[5]*pairings*BigInt(input.constraints.leaderId?1:5);
  return {members:input.inventory.memberCardIds.length,characters:groups.size,supports:supportCount,memberSelections:dp[5].toString(),combinations:combinations.toString()};
}
export function formatCombinationCount(value) {
  const n=BigInt(value);if(n>=100000000n)return `约 ${Number(n/1000000n)/100} 亿`;
  if(n>=10000n)return `约 ${Number(n/100n)/100} 万`;
  return n.toLocaleString();
}
export function readOptimizerConstraints(workbench) {
  const constraints=JSON.parse(workbench.querySelector('[data-search-constraints]').value);
  if(!constraints||typeof constraints!=='object'||Array.isArray(constraints))throw new Error('高级约束需要填写 JSON 对象');
  for(const [selector,name] of [['[data-search-band]','bandId'],['[data-search-support-band]','supportBandId'],['[data-search-attribute]','attribute'],['[data-search-support-attribute]','supportAttribute']]) {
    const field=workbench.querySelector(selector),values=selectedControlValues(field).map(Number);
    if(values.length)constraints[name]=field.multiple?values:values[0];
  }
  return constraints;
}
