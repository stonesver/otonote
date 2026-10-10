import {createInventory, canonicalCardId} from './scoring-rules/formation-input.mjs';
import {createFormationCalculator} from './scoring-rules/formation-power.mjs';

export const growthFields = ['level','rank','awake','skillLevel','gekisouSkillLevel'];
export const growthLabels = {level:'等级',rank:'阶数（成员觉醒／留影突破）',awake:'突破（特训）阶数',skillLevel:'演出技能',gekisouSkillLevel:'激奏技能'};
const baseGrowth = kind => ({level:1,rank:1,...(kind==='member'?{awake:1,skillLevel:1,gekisouSkillLevel:1}:{})});
const fieldsFor = kind => kind==='member'?growthFields:growthFields.slice(0,2);
const kindOf = value => ({member:'member','成员':'member','成员卡':'member',support:'support','留影':'support'})[String(value).trim().toLowerCase()];

// CSV and spreadsheet clipboard data share the same quoting rules.
export function parseDelimited(text) {
  text=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  const delimiter=text.split('\n')[0].includes('\t')?'\t':',';
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='"') {
      if(quoted&&text[i+1]==='"'){cell+='"';i++;}
      else if(quoted||cell==='')quoted=!quoted;
      else cell+=c;
    } else if(!quoted&&(c===delimiter||c==='\n')) {
      row.push(cell.trim());cell='';
      if(c==='\n'){if(row.some(Boolean))rows.push(row);row=[];}
    } else cell+=c;
  }
  if(quoted)throw new Error('表格引号没有闭合');
  row.push(cell.trim());if(row.some(Boolean))rows.push(row);
  return rows;
}

export function createInventoryManager(rules, cards=[]) {
  const calculator=createFormationCalculator(rules), byId=new Map(cards.map(c=>[c.id,c]));
  function validate(input) {
    const normalized=createInventory(rules,input),growth={};
    if(!input.growth||typeof input.growth!=='object'||Array.isArray(input.growth))throw new Error('卡库缺少养成数据');
    for(const kind of ['member','support'])for(const id of normalized[`${kind}CardIds`]) {
      const g=input.growth[id];
      for(const field of fieldsFor(kind))if(!Number.isInteger(g?.[field])||g[field]<1||(field!=='level'&&g[field]>5))throw new Error(`${id}：${growthLabels[field]}无效`);
      try{calculator.resolveGrowth(calculator.card(id,kind),kind==='member'?'Member':'Support',g);}
      catch(error){throw new Error(`${byId.get(id)?.shortLabel??id} (${id})：${error.message}`);}
      growth[id]=Object.fromEntries(fieldsFor(kind).map(f=>[f,g[f]]));
    }
    return {...normalized,growth};
  }
  function preset(id, kind, mode='minimum', previous=baseGrowth(kind)) {
    if(!['minimum','maximum','level','skills'].includes(mode))throw new Error('未知养成操作');
    if(mode==='skills'&&kind!=='member')throw new Error('留影没有可修改的技能等级');
    const row=calculator.card(id,kind),type=kind==='member'?'Member':'Support';
    const g=mode==='minimum'?baseGrowth(kind):{...previous};
    if(mode==='maximum') {
      g.rank=Math.max(...rules.tables[`${type}CardRank`].filter(r=>r._group===row[`_${kind}CardRankGroup`]).map(r=>r._rank));
      if(kind==='member') {
        g.awake=Math.max(...rules.tables.MemberCardAwake.filter(r=>r._group===row._memberCardAwakeGroup).map(r=>r._awakeCount));
        g.skillLevel=5;g.gekisouSkillLevel=5;
      }
    }
    if(mode==='maximum'||mode==='level')g.level=calculator.resolveGrowth(row,type,{...g,level:undefined}).level;
    if(mode==='skills'){g.skillLevel=5;g.gekisouSkillLevel=5;}
    return g;
  }
  function choices(id,kind,field,previous=baseGrowth(kind)) {
    if(!fieldsFor(kind).includes(field))return [];
    const row=calculator.card(id,kind),type=kind==='member'?'Member':'Support';
    if(field==='rank')return rules.tables[`${type}CardRank`].filter(r=>r._group===row[`_${kind}CardRankGroup`]).map(r=>r._rank).sort((a,b)=>a-b);
    if(field==='awake')return rules.tables.MemberCardAwake.filter(r=>r._group===row._memberCardAwakeGroup).map(r=>r._awakeCount).sort((a,b)=>a-b);
    const maximum=field==='level'?preset(id,kind,'level',previous).level:5;
    return Array.from({length:maximum},(_,i)=>i+1);
  }
  function applyPatch(id,kind,current,patch) {
    const next={...current},maximum=preset(id,kind,'maximum');
    for(const field of fieldsFor(kind).filter(f=>f!=='level'))if(patch[field]!==undefined)next[field]=patch[field]==='maximum'?maximum[field]:patch[field];
    if(patch.level!==undefined)next.level=patch.level==='maximum'?preset(id,kind,'level',next).level:patch.level;
    return next;
  }
  function resolve(value, kind) {
    const raw=String(value).trim(),prefix=raw.match(/^(member|support)-(?:card-)?\d+$/);
    if(prefix)kind=prefix[1];
    if(/^\d+$/.test(raw)||prefix) {
      const id=canonicalCardId(raw,kind);calculator.card(id,kind);return {id,kind};
    }
    const matches=cards.filter(c=>c.kind===kind&&[c.shortLabel,c.displayName,c.subtitle,c.description].some(n=>n&&String(n).trim()===raw));
    if(matches.length!==1)throw new Error(matches.length?`名称“${raw}”对应多张卡，请使用卡片 ID`:`没有找到“${raw}”，请使用完整卡名或 ID`);
    return {id:matches[0].id,kind};
  }
  function preview(text,{kind='member'}={}) {
    if(text.length>2_000_000)throw new Error('导入内容过大（最多 2 MB）');
    if(!kindOf(kind))throw new Error('请选择成员卡或留影');
    const trimmed=text.trim().replace(/^\uFEFF/,'');let records;
    if(trimmed.startsWith('{')) {
      const parsed=validate(JSON.parse(trimmed));
      records=['member','support'].flatMap(k=>parsed[`${k}CardIds`].map(id=>({id,kind:k,...parsed.growth[id]})));
    } else {
      const rows=parseDelimited(trimmed);
      const aliases={kind:'kind','类型':'kind',id:'id','卡片id':'id',name:'name','名称':'name','卡名':'name',level:'level','等级':'level',rank:'rank','突破':'rank','突破阶数':'rank',awake:'awake','觉醒':'awake','觉醒阶数':'awake','阶数（成员觉醒／留影突破）':'rank','突破（特训）阶数':'awake',skilllevel:'skillLevel','演出技能':'skillLevel',gekisouskilllevel:'gekisouSkillLevel','激奏技能':'gekisouSkillLevel'};
      const headers=rows[0]?.map(h=>aliases[h.toLowerCase()]);
      if(headers?.some(h=>h==='id'||h==='name')) {
        if(headers.some(h=>!h)||new Set(headers).size!==headers.length)throw new Error('表头有未知或重复列；请使用模板中的列名');
        records=rows.slice(1).map(row=>row.length>headers.length?{error:'列数超过表头，请检查分隔符或引号'}:Object.fromEntries(headers.map((h,i)=>[h,row[i]??''])));
      } else records=rows.map(row=>row.length===1?{id:row[0]}:{error:'无表头的清单需要每行一张卡；多列数据请添加模板表头'});
    }
    if(!records.length)throw new Error('请先粘贴卡片清单或选择文件');
    const seen=new Set();
    return records.map((record,i)=>{
      try {
        if(record.error)throw new Error(record.error);
        const k=record.kind?kindOf(record.kind):kind;
        if(!k)throw new Error(`未知类型：${record.kind}`);
        const resolved=resolve(record.id||record.name,k),{id}=resolved;
        if(record.kind&&resolved.kind!==k)throw new Error('卡片 ID 与类型不一致');
        if(seen.has(id))throw new Error(`清单内重复卡片：${id}`);seen.add(id);
        const patch={};
        for(const field of growthFields)if(record[field]!==undefined&&record[field]!=='') {
          if(!fieldsFor(resolved.kind).includes(field))throw new Error(`留影没有“${growthLabels[field]}”字段`);
          const value=Number(record[field]);if(!Number.isInteger(value)||value<1)throw new Error(`${growthLabels[field]}应为正整数`);patch[field]=value;
        }
        return {line:i+1,...resolved,name:byId.get(id)?.shortLabel??id,patch};
      }catch(error){return {line:i+1,error:error.message};}
    });
  }
  function merge(inventory,rows,{updateExisting=false,presetMode='minimum'}={}) {
    const next=structuredClone(validate(inventory)),changes=[];
    for(const row of rows) {
      if(row.error)throw new Error(`第 ${row.line} 行：${row.error}`);
      const {id,kind}=row,ids=next[`${kind}CardIds`],exists=ids.includes(id);
      if(exists&&!updateExisting){changes.push({...row,action:'保留',growth:next.growth[id]});continue;}
      const initial=exists?next.growth[id]:preset(id,kind,presetMode);
      next.growth[id]={...initial,...row.patch};if(!exists)ids.push(id);
      changes.push({...row,action:exists?'更新':'新增',growth:next.growth[id]});
    }
    return {inventory:validate(next),changes};
  }
  function batch(inventory,ids,{mode='custom',patch={}}={}) {
    if(!['custom','minimum','maximum','level','skills'].includes(mode))throw new Error('未知养成操作');
    const next=structuredClone(validate(inventory));
    for(const id of ids) {
      const kind=id.startsWith('member-')?'member':'support';
      if(!next[`${kind}CardIds`].includes(id))next[`${kind}CardIds`].push(id);
      const current=next.growth[id]??baseGrowth(kind);
      next.growth[id]=mode==='custom'?applyPatch(id,kind,current,patch):preset(id,kind,mode,current);
    }
    return validate(next);
  }
  return {validate,preset,choices,applyPatch,preview,merge,batch,empty:()=>({...createInventory(rules),growth:{}})};
}
