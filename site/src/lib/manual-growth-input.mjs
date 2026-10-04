import {createFormationCalculator,requireInteger} from './scoring-rules/formation-power.mjs';
const fields=kind=>kind==='member'?['level','rank','awake','skillLevel','gekisouSkillLevel']:['level','rank'];
export function incompleteManualGrowth(draft,cardIds) {
  return cardIds.filter(id=>{
    const raw=draft.modifiers?.planningResult?draft.modifiers.planningResult.actualGrowth?.[id]:draft.modifiers?.growth?.[id];
    return fields(id.startsWith('member-')?'member':'support').some(field=>!Number.isInteger(raw?.[field]));
  });
}
/** Called only by the user's explicit confirmation; never changes ownership or the inventory. */
export function confirmManualGrowth(rules,draft,cardIds,{displayedGrowth={}}={}) {
  const calculator=createFormationCalculator(rules),next=structuredClone(draft),selected=new Set(draft.slots.flatMap(slot=>[slot.memberCardId,slot.supportCardId]).filter(Boolean));
  const records={};
  for(const id of [...new Set(cardIds)]){
    if(!selected.has(id))throw new Error('只能确认当前队伍中的卡片');
    const kind=id.startsWith('member-')?'member':'support',raw={...draft.modifiers?.growth?.[id],...displayedGrowth[id]};
    if(!Number.isInteger(raw.level))throw new Error('请先填写当前槽位每张卡的实际等级，再确认其他显示值。');
    const record=Object.fromEntries(fields(kind).map(field=>[field,raw[field]??1]));
    for(const [field,value] of Object.entries(record))requireInteger(value,field,1,field==='level'?999:5);
    calculator.resolveGrowth(calculator.card(id,kind),kind==='member'?'Member':'Support',record);
    records[id]=record;
  }
  next.modifiers??={};next.modifiers.growth={...next.modifiers.growth,...records};
  if(next.modifiers.planningResult)next.modifiers.planningResult.actualGrowth={...next.modifiers.planningResult.actualGrowth,...structuredClone(records)};
  return next;
}
