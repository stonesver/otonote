import {createInventoryManager} from './inventory-manager.mjs';

const groups=['memberCards','supportCards','bandItems','characterRanks','tgw'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);

// The complete inventory stays in browser storage; a shared draft carries only its team.
export function growthModifiersForDraft(converted,draft) {
  const {growth,...account}=converted.modifiers;
  const selected=new Set(draft.slots.flatMap(s=>[s.memberCardId,s.supportCardId]).filter(Boolean));
  const teamGrowth={};
  for(const id of selected) {
    const value=growth[id]??draft.modifiers?.growth?.[id];
    if(value)teamGrowth[id]=structuredClone(value);
  }
  return {...draft.modifiers,...structuredClone(account),growth:teamGrowth};
}
const integer=(v,name,min=0,max=2147483647)=>{
  if(!Number.isSafeInteger(v)||v<min||v>max)throw new Error(`${name}数值无效`);
  return v;
};
function threshold(rows,value,valueKey,rankKey) {
  const sorted=[...rows].sort((a,b)=>a[valueKey]-b[valueKey]);
  if(!sorted.length||sorted[0][valueKey]!==0)throw new Error('网站等级资料不完整');
  let result;
  for(const row of sorted) {
    if(row[valueKey]>value)break;
    result=row[rankKey];
  }
  return integer(result,'换算等级',1,1000);
}

export function convertGrowthSnapshot(snapshot,rules,vipRanks=[]) {
  if(!object(snapshot)||snapshot.format!=='ournotes-growth-snapshot'||snapshot.schemaVersion!==1)
    throw new Error('请选择 Our Notes 养成导出 JSON（版本 1）');
  if(snapshot.source?.serverId && snapshot.source.serverId!=='global-hmt')throw new Error('养成文件区服身份不一致');
  if(snapshot.source?.edition && snapshot.source.edition!=='global')throw new Error('养成文件版本身份不一致');
  if(snapshot.source?.region!=='TW/HK/MO')throw new Error('当前只支持台港澳服养成');
  if(!object(snapshot.growth)||!object(snapshot.coverage))throw new Error('养成文件缺少覆盖信息');
  const normalized={},summary={},modifiers={},inventory={schemaVersion:1,sourceReleaseId:rules.sourceReleaseId,
    memberCardIds:[],supportCardIds:[],growth:{}};
  for(const group of groups) {
    if(snapshot.coverage[group]!=='observed'||snapshot.growth[group]===null) {
      if(group==='memberCards'||group==='supportCards')throw new Error('成员卡或留影未完整读取，暂不能替换卡库');
      normalized[group]=null;summary[group]=null;continue;
    }
    if(group==='tgw') {
      if(!object(snapshot.growth.tgw))throw new Error('TGW 数据无效');
      const point=integer(snapshot.growth.tgw.point,'TGW 积分');
      modifiers.tgwCardRank=threshold(vipRanks,point,'requiredPoints','rank');
      normalized.tgw={point};summary.tgw=modifiers.tgwCardRank;continue;
    }
    const rows=snapshot.growth[group];
    if(!Array.isArray(rows)||rows.length>10000)throw new Error('养成记录数量无效');
    const seen=new Set();normalized[group]=[];summary[group]=rows.length;
    for(const row of rows) {
      if(!object(row))throw new Error('养成记录格式无效');
      const key=group==='characterRanks'?'characterId':'masterId',id=integer(row[key],'资料 ID',1,Number.MAX_SAFE_INTEGER);
      if(seen.has(id))throw new Error('养成文件存在重复 ID');seen.add(id);
      if(group==='memberCards'||group==='supportCards') {
        const kind=group==='memberCards'?'member':'support',type=kind==='member'?'Member':'Support';
        const master=rules.tables[`${type}Card`].find(r=>r._id===id);
        if(!master)throw new Error(`网站资料中没有${kind==='member'?'成员卡':'留影'} ${id}，请更新资料后导入`);
        const exp=integer(row.exp,'卡片经验'),rank=integer(row.cardRank,kind==='member'?'觉醒阶数':'突破阶数',1,5);
        const cardId=`${kind}-card-${id}`,level=threshold(rules.tables[`${type}CardLevel`]
          .filter(r=>r._group===master[`_${kind}CardLevelGroup`]),exp,'_exp','_level');
        const g={level,rank},safe={masterId:id,exp,cardRank:rank};
        if(kind==='member') {
          g.awake=integer(row.awakeCount,'突破（特训）阶数',1,5);
          g.skillLevel=integer(row.liveSkillLevel,'演出技能',1,5);
          g.gekisouSkillLevel=integer(row.gekisouSkillLevel,'激奏技能',1,5);
          Object.assign(safe,{awakeCount:g.awake,liveSkillLevel:g.skillLevel,gekisouSkillLevel:g.gekisouSkillLevel});
        } else safe.duplicateCount=integer(row.duplicateCount,'重复数量');
        inventory[`${kind}CardIds`].push(cardId);inventory.growth[cardId]=g;normalized[group].push(safe);
      } else if(group==='bandItems') {
        if(!rules.tables.BandItem.some(r=>r._id===id))throw new Error(`网站资料中没有乐器 ${id}`);
        const level=integer(row.level,'乐器等级',0,30);
        if(level>0&&!rules.tables.BandItemSkillEffect.some(r=>r._bandItemId===id&&r._level===level))
          throw new Error(`网站资料中没有乐器 ${id} 的等级 ${level}`);
        (modifiers.bandItems??={})[id]=level;normalized[group].push({masterId:id,level});
      } else {
        if(!rules.tables.Character.some(r=>r._id===id))throw new Error(`网站资料中没有角色 ${id}`);
        const exp=integer(row.exp,'角色评级经验');
        (modifiers.characterRanks??={})[id]=threshold(rules.tables.CharacterRank,exp,'_exp','_rank');
        normalized[group].push({characterId:id,exp});
      }
    }
    if(group==='bandItems')modifiers.bandItems??={};
    if(group==='characterRanks')modifiers.characterRanks??={};
  }
  const validated=createInventoryManager(rules).validate(inventory);
  modifiers.growth=structuredClone(validated.growth);
  const safeSnapshot={format:'ournotes-growth-snapshot',schemaVersion:1,source:{region:'TW/HK/MO',edition:'global',serverId:'global-hmt'},
    coverage:Object.fromEntries(groups.map(g=>[g,normalized[g]===null?'not_observed':'observed'])),growth:normalized};
  return {inventory:validated,modifiers,summary,safeSnapshot};
}
