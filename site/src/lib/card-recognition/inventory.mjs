import {gameServer} from '../game-servers.mjs';
import {mergeObservations} from './observations.mjs';

export const labels={level:'等级',awake:'特训',rank:'觉醒星数',skillLevel:'演出技能',gekisouSkillLevel:'激奏技能'};
export const fieldsFor=kind=>kind==='member'?['level','awake','rank','skillLevel','gekisouSkillLevel']:['level','rank'];
export function assertRecognitionContext(manifest,context,sourceReleaseId){
  if(!gameServer(context.serverId)||gameServer(context.serverId).region!==context.region)throw Error('请先选择账号所属区服');
  if(manifest?.schemaVersion!==1||manifest.region!==context.region||manifest.sourceReleaseId!==sourceReleaseId)throw Error('识别索引与当前卡库版本不一致，请刷新页面后重试');
}
export function recognitionDraft(rows,manifest){
  const merged=mergeObservations(rows,manifest);
  return merged.cards.map(card=>{
    const patch={};
    for(const [from,to] of Object.entries({level:'level',training:'awake',awakeningStars:'rank',supportPetals:'rank'}))if(card.observations[from]!==undefined)patch[to]=card.observations[from];
    const conflicts=merged.conflicts.filter(c=>c.id===card.id).map(c=>({field:{training:'awake',awakeningStars:'rank',supportPetals:'rank',level:'level'}[c.field],values:c.values}));
    for(const conflict of conflicts)delete patch[conflict.field];
    return {id:card.id,kind:card.kind,patch,selected:true,conflicts,sources:card.sources};
  });
}
export function previewRecognitionImport({manager,inventory,rows,manifest,context,sourceReleaseId}){
  assertRecognitionContext(manifest,context,sourceReleaseId);
  const known=new Map(manifest.cards.map(c=>[c.id,c])),seen=new Set(),selected=rows.filter(r=>r.selected),errors=[],changes=[];
  if(!selected.length)return {errors:['请选择要导入的卡牌'],changes,inventory:null};
  for(const row of selected){
    try{
      const card=known.get(row.id);
      if(!card||card.kind!==row.kind||seen.has(row.id))throw Error('卡牌身份无效或重复');seen.add(row.id);
      const existing=inventory[`${row.kind}CardIds`].includes(row.id),current=existing?inventory.growth[row.id]:{},patch={};
      for(const field of fieldsFor(row.kind)){
        const value=row.patch[field];
        if(value!==null&&value!==undefined&&value!==''){
          if(!Number.isInteger(value)||value<1||value>(field==='level'?100:5))throw Error(`${labels[field]}数值无效`);
          patch[field]=value;
        }
      }
      if(row.conflicts?.some(c=>patch[c.field]===undefined))throw Error('请明确选择冲突字段的数值');
      const next={...(!existing&&row.kind==='member'?{skillLevel:1,gekisouSkillLevel:1}:{}),...current,...patch};
      const missing=fieldsFor(row.kind).filter(f=>next[f]===undefined);
      if(missing.length)throw Error(`新卡需补齐${missing.map(f=>row.kind==='support'&&f==='rank'?'突破花瓣':labels[f]).join('、')}`);
      manager.validate({schemaVersion:1,sourceReleaseId,memberCardIds:row.kind==='member'?[row.id]:[],supportCardIds:row.kind==='support'?[row.id]:[],growth:{[row.id]:next}});
      changes.push({id:row.id,kind:row.kind,name:card.name,patch,previous:{...current},growth:next,action:existing?'更新':'新增'});
    }catch(error){errors.push(`${known.get(row.id)?.name??row.id}：${error.message}`);}
  }
  if(errors.length)return {errors,changes,inventory:null};
  const result=manager.merge(inventory,changes,{updateExisting:true});
  return {errors,changes,inventory:result.inventory};
}
