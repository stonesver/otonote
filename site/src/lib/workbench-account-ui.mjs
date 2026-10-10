import {bandItemGroups} from '../../../packages/scoring/scoring-rules/band-item-totals.mjs';
import {maximizeAccount,tgwBonusRanges} from './workbench-account-model.mjs';
import {createWorkbenchDialog,showWorkbenchToast,enhanceNumericInputs} from './workbench-dialog.mjs';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};

export function createAccountEditor(host,apply) {
  const rules=host.data.formalRules??host.data.rules,ranks=host.data.vipRanks??[],panel=createWorkbenchDialog(host,'账号加成',{className:'task-account-dialog'});
  let draft;
  const button=(text,action)=>{const b=el('button',text);b.type='button';b.addEventListener('click',action);return b;};
  function number(parent,label,value,min,max,onChange) {
    const row=el('label',null,'task-account-field'),input=el('input');input.type='number';input.min=min;input.max=max;input.step=1;input.value=value;
    row.append(el('span',label),input);input.addEventListener('change',()=>{if(input.checkValidity()&&input.value!=='')onChange(Number(input.value));});parent.append(row);
  }
  function paint() {
    const expanded=new Set([...panel.body.querySelectorAll('details[open]')].map(n=>n.querySelector('summary')?.textContent));
    panel.dialog.querySelector(':scope > footer')?.remove();panel.body.replaceChildren(el('p','只影响本次计算，不会覆盖实际账号或卡库。回忆值保留原输入，一键满级不假设回忆上限。','task-account-note'));
    const actions=el('div',null,'task-account-actions');actions.append(button('一键满级',()=>{draft=maximizeAccount(draft,rules,ranks);paint();}));panel.body.append(actions);
    const instruments=el('section',null,'task-account-group');instruments.append(el('h3','乐器 / 乐队道具'),button('乐器全满',()=>{draft=maximizeAccount(draft,rules,ranks,'instruments');paint();}));
    for(const group of bandItemGroups(rules)) {
      const details=el('details'),name=host.data.bands?.find(b=>Number(b.masterId??String(b.id).replace('band-',''))===group.bandId)?.name??`乐队 ${group.bandId}`;
      details.append(el('summary',name));details.open=expanded.has(name);
      const aggregate=Object.hasOwn(draft.bandItemTotals??{},group.bandId),mode=el('select');mode.setAttribute('aria-label',`${name} 输入方式`);
      for(const [value,label] of [['detail','逐件等级'],...(group.supported?[['total','总等级']]:[])]){const o=el('option',label);o.value=value;mode.append(o);}mode.value=aggregate?'total':'detail';details.append(mode);
      mode.addEventListener('change',()=>{if(mode.value==='total')(draft.bandItemTotals??={})[group.bandId]=group.items.reduce((s,i)=>s+(draft.bandItems?.[i.id]??0),0);else {delete draft.bandItemTotals?.[group.bandId];}paint();});
      if(aggregate)number(details,'总等级',draft.bandItemTotals[group.bandId],0,group.maxTotal,v=>draft.bandItemTotals[group.bandId]=v);
      else for(const item of group.items){const label=host.data.instruments?.find(i=>i.id===item.id)?.name??`道具 ${item.id}`;number(details,label,draft.bandItems?.[item.id]??0,0,item.maxLevel,v=>(draft.bandItems??={})[item.id]=v);}
      instruments.append(details);
    }
    panel.body.append(instruments);
    const characters=el('section',null,'task-account-group');characters.append(el('h3','角色评级与回忆'),button('评级全满',()=>{draft=maximizeAccount(draft,rules,ranks,'characters');paint();}),el('p','全角色评级参与总评级加成；回忆固定值按每个维度填写。'));
    const rankDetails=el('details'),rankGrid=el('div',null,'task-character-grid'),rankTitle=`编辑全角色 · ${rules.tables.Character.length} 位`;rankDetails.open=expanded.has(rankTitle);rankDetails.append(el('summary',rankTitle),rankGrid);
    const selectedCharacters=new Set(host.draft.slots.map(slot=>host.data.memberCards?.find(card=>card.id===slot.memberCardId)?.characterId).filter(Boolean).map(id=>Number(String(id).replace('character-',''))));
    const maxRank=Math.max(...rules.tables.CharacterRank.map(r=>r._rank));
    for(const c of rules.tables.Character){const row=el('div',null,'task-character-row'),name=host.data.characters?.find(n=>Number(String(n.masterId??n.id).replace('character-',''))===c._id)?.name??`角色 ${c._id}`;
      row.append(el('strong',name));number(row,'评级',draft.characterRanks?.[c._id]??1,1,maxRank,v=>(draft.characterRanks??={})[c._id]=v);number(row,'回忆 / 维',draft.memoryPoints?.[c._id]??0,0,100000,v=>(draft.memoryPoints??={})[c._id]=v);(selectedCharacters.has(c._id)?characters:rankGrid).append(row);
    }rankDetails.querySelector('summary').textContent=selectedCharacters.size?`其他角色 · ${rules.tables.Character.length-selectedCharacters.size} 位`:rankTitle;characters.append(rankDetails);panel.body.append(characters);
    const tgw=el('section',null,'task-account-group');tgw.append(el('h3','T.G.W CARD'),el('p','同一加成区间合并显示。区间选项采用最低等级；也可保留具体等级。'));
    const options=el('div',null,'task-tgw-options');
    for(const range of tgwBonusRanges(ranks)){const bonus=range.bonuses.map(b=>`${b.label??b.type} +${b.rawValue/100}%`).join(' · '),b=button(`Lv.${range.min}${range.max>range.min?`–${range.max}`:''} · ${bonus||'无加成'}`,()=>{draft.tgwCardRank=range.min;paint();});b.setAttribute('aria-pressed',String((draft.tgwCardRank??1)>=range.min&&(draft.tgwCardRank??1)<=range.max));b.title=bonus||'无加成';b.replaceChildren(el('strong',`Lv.${range.min}${range.max>range.min?`–${range.max}`:''}`),el('small',range.bonuses.map(b=>`+${b.rawValue/100}%`).join(' / ')||'无加成'));options.append(b);}tgw.append(options);
    if(ranks.length)number(tgw,'具体等级',draft.tgwCardRank??1,Math.min(...ranks.map(r=>r.rank)),Math.max(...ranks.map(r=>r.rank)),v=>{draft.tgwCardRank=v;});panel.body.append(tgw);
    const footer=el('footer');footer.append(button('取消',()=>panel.close()),button('应用加成',()=>{const invalid=panel.body.querySelector(':invalid');if(invalid){invalid.reportValidity();return;}apply(draft);panel.close();showWorkbenchToast('已应用本次计算加成');}));panel.dialog.append(footer);enhanceNumericInputs(panel.body);
  }
  return {open(){draft=structuredClone(host.draft.modifiers??{});paint();panel.open();}};
}
