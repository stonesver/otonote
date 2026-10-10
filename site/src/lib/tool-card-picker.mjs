import {filterTeamCards,teamCardFilterOptions} from './team-card-filters.mjs';
import {attachCardSkillHover,closeSkillPopover} from './calculator-card-ui.mjs';
import {setupQuickOptions} from './tool-quick-options.mjs';
import {createTeamCardView} from './team-card-view.mjs';
import {cardSkillRows} from './calculator-card-model.mjs';
const node=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};

export function filterQuickCards(cards,{query='',attribute='',ownedOnly=false,owned=[]}={}) {
  return filterTeamCards(cards,{query,attribute,ownership:ownedOnly?'owned':'',owned});
}

/** Shared chooser. The caller owns actual growth, team edits, and restriction enforcement. */
export function createToolCardPicker({root,getCards,getDraft,getOwned=()=>[],getCardState,conflict=()=>'',onChoose}) {
  const en=root.ownerDocument?.documentElement.lang==='en',say=(zh,english)=>en?english:zh;
  const dialog=node('dialog');dialog.className='ux-card-picker';dialog.setAttribute('aria-label',say('搜索并选择卡片','Find and choose cards'));
  const header=node('header'),title=node('h2'),close=node('button','×');close.type='button';close.setAttribute('aria-label',say('关闭选卡','Close card picker'));header.append(title,close);
  const search=node('input');search.type='search';search.placeholder=say('搜索角色、卡片或乐队名称','Search character, card or band name');search.setAttribute('aria-label',search.placeholder);
  const searchLabel=node('label');searchLabel.className='ux-card-search';searchLabel.append(node('span',say('搜索卡片','Search cards')),search);
  const filters=node('div');filters.className='tool-options';filters.setAttribute('role','group');filters.setAttribute('aria-label',say('卡片属性','Card attribute'));
  const filterRow=node('div');filterRow.className='ux-card-filter-row';filterRow.append(node('span',say('属性','Attribute')),filters);
  const extraFilters=node('div');extraFilters.className='ux-card-extra-filters';
  const selections={};
  for(const [key,zh,english] of [['band','乐队','Band'],['character','角色','Character'],['rarity','稀有度','Rarity'],['mission','激奏','Gekisou'],['normal','技能','Live skill'],['sort','排序','Sort']]){
    const label=node('label'),select=node('select');select.dataset.cardFilter=key;selections[key]=select;label.append(node('span',say(zh,english)),select);extraFilters.append(label);
    select.addEventListener('change',()=>{page=0;render();});
  }
  const ownedLabel=node('label'),owned=node('input');owned.type='checkbox';ownedLabel.append(owned,say('只看已拥有','Owned cards only'));
  const continuousLabel=node('label'),continuous=node('input');continuous.type='checkbox';continuous.checked=true;continuousLabel.append(continuous,say('选后继续填下一个空位','Continue to the next empty slot'));
  const options=node('div');options.className='ux-card-selection-options';options.append(ownedLabel,continuousLabel);
  const count=node('p');count.setAttribute('role','status');
  const grid=node('div');grid.className='ux-card-grid';
  const footer=node('footer'),prev=node('button',say('上一页','Previous')),next=node('button',say('下一页','Next')),pageText=node('span'),done=node('button',say('完成选卡','Done'));prev.type=next.type=done.type='button';done.className='ux-card-done';done.addEventListener('click',()=>dialog.close());footer.append(prev,pageText,next,done);
  const clear=node('button',say('清空筛选','Clear filters'));clear.type='button';
  const results=node('div');results.className='ux-card-results-bar';results.append(count,clear);
  const stage=node('div');stage.className='ux-card-stage';
  const positions=node('aside');positions.className='ux-card-positions';positions.setAttribute('aria-label',say('选择编成位置','Choose lineup slot'));
  const browser=node('section');browser.className='ux-card-browser';const pinned=node('div');pinned.className='ux-card-pinned';
  const kinds=node('div');kinds.className='ux-card-kinds';kinds.setAttribute('role','group');kinds.setAttribute('aria-label',say('卡牌类型','Card type'));
  const kindButtons=new Map();for(const [kind,label] of [['member',say('成员卡','Member')],['support',say('留影','Snap')]]){const b=node('button',label);b.type='button';b.addEventListener('click',()=>{target.kind=kind;page=0;previewId=getDraft().slots[target.slot][`${kind}CardId`];render();});kinds.append(b);kindButtons.set(kind,b);}
  const searchLine=node('div');searchLine.className='ux-card-search-line';searchLine.append(searchLabel,kinds);
  const more=node('details');more.className='ux-card-more-filters';more.append(node('summary',say('技能与更多筛选','Skill and more filters')),extraFilters);
  pinned.append(searchLine,filterRow,more,options,results);browser.append(pinned,grid);
  const preview=node('aside');preview.className='ux-card-preview';preview.setAttribute('aria-label',say('卡片预览','Card preview'));
  stage.append(positions,browser,preview);dialog.append(header,stage,footer);root.append(dialog);
  let target,page=0,attribute='',origin,opener,backdropPressed=false,previewId;
  const catalogOptions=teamCardFilterOptions([...getCards('member'),...getCards('support')],root.data);
  const option=(value,label)=>{const el=node('option',label);el.value=value;return el;};
  for(const [key,zh,english] of [['band','全部乐队','All bands'],['character','全部角色','All characters'],['rarity','全部稀有度','All rarities']]){
    selections[key].append(option('',say(zh,english)));for(const item of catalogOptions[key]){const choice=option(item.value,item.label);if(item.icon){choice.dataset.icon=item.icon;if(key==='band'){choice.dataset.round='true';choice.dataset.iconOnly='true';}}selections[key].append(choice);}
  }
  for(const [key,items] of [['mission',[['','全部类型'],['combo','COMBO'],['luck','LUCK'],['just','JUST']]],['normal',[['','全部技能'],['score','得分提升'],['heal','生命回复'],['judge','判定辅助'],['life','生命条件'],['judgement','判定条件']]]])for(const [value,label] of items)selections[key].append(option(value,label));
  for(const [value,zh,english] of [['default','默认顺序','Default order'],['name','名称','Name'],['rarity-desc','稀有度从高到低','Highest rarity'],['level-desc','等级从高到低','Highest level']])selections.sort.append(option(value,say(zh,english)));
  for(const item of [{value:'',label:say('全部属性','All attributes')},...catalogOptions.attribute]){
    const b=node('button');b.type='button';b.dataset.attribute=item.value;b.setAttribute('aria-label',item.label);b.title=item.label;
    if(item.icon){const img=node('img');img.src=item.icon;img.alt='';img.width=26;img.height=26;img.addEventListener('error',()=>{img.remove();b.textContent=item.label;});b.append(img);}else b.textContent=item.label;
    b.addEventListener('click',()=>{attribute=item.value;page=0;render();});filters.append(b);
  }
  for(const [key,field] of Object.entries(selections)){if(key==='band'||key==='rarity')field.dataset.quick='';else field.dataset.quickNative='true';}
  const bandLabel=selections.band.closest('label');bandLabel.className='ux-card-band-filter';const rarityLabel=selections.rarity.closest('label');rarityLabel.className='ux-card-rarity-filter';pinned.insertBefore(bandLabel,more);pinned.insertBefore(rarityLabel,more);const shortcuts=setupQuickOptions(dialog);
  function renderPreview(states){
    preview.replaceChildren();const card=getCards(target.kind).find(c=>c.id===previewId),draft=getDraft();
    if(!card){preview.append(node('p',say('点击卡片查看预览，再替换此位置。','Preview a card, then replace this slot.')));return;}
    const state=states.get(card.id),view=createTeamCardView(card,{...state,kind:target.kind,locale:en?'en':'zh-CN',data:root.data??{}});preview.append(view);
    const rules=root.data?.formalRules??root.data?.rules;if(rules){const skills=node('div');skills.className='ux-card-preview-skills';for(const row of cardSkillRows(card,rules,state.growth).filter(row=>row.slot!=='leader'||target.slot===2)){const line=node('p');line.append(node('strong',row.name),node('span',row.summary));skills.append(line);}preview.append(skills);}
    const chosen=draft.slots[target.slot][`${target.kind}CardId`]===card.id,reason=conflict(card,target);
    const use=node('button',chosen?say('当前位置已使用','Already in this slot'):say('替换此位置','Replace this slot'));use.type='button';use.className='ux-card-replace';use.disabled=chosen||Boolean(reason);
    use.addEventListener('click',()=>{onChoose(card,{...target});if(continuous.checked){const slots=getDraft().slots;for(const kind of [target.kind,target.kind==='member'?'support':'member']){const slot=slots.findIndex(s=>!s[`${kind}CardId`]);if(slot>=0){target={kind,slot};previewId=slots[slot][`${kind}CardId`];break;}}}render({focusCard:card.id});});preview.append(use,node('p',say('替换只修改编辑草稿，完成后再应用队伍。','Replacement changes the editing draft. Apply the team when finished.')));
  }
  function render({focusCard,focusIndex=0}={}){
    closeSkillPopover(root);
    shortcuts.sync();
    if(!target)return;
    const all=getCards(target.kind),states=new Map(all.map(card=>[card.id,getCardState?.(card,target)??{growth:{},source:'unknown'}]));
    const growth=Object.fromEntries([...states].map(([id,state])=>[id,state.growth]));
    const cards=filterTeamCards(all.filter(c=>(!selections.mission.value||c.skillFacets?.['gekisou-type']?.includes(selections.mission.value))&&(!selections.normal.value||[...(c.skillFacets?.['live-type']??[]),...(c.skillFacets?.['skill-role']??[])].includes(selections.normal.value))),{query:search.value,attribute,band:selections.band.value,character:selections.character.value,rarity:selections.rarity.value,
      ownership:owned.checked?'owned':'',owned:getOwned(target.kind),sort:selections.sort.value,growth}),draft=getDraft();
    page=Math.max(0,Math.min(page,Math.ceil(cards.length/24)-1));
    title.textContent=`${target.slot===2?say('队长','Leader'):`${say('位置','Slot')} ${target.slot+1}`} · ${target.kind==='member'?say('选择成员','Choose member'):say('选择留影','Choose snap')}`;
    count.textContent=cards.length?say(`${cards.length} 张卡片 · 不可用的卡会标明原因`,`${cards.length} cards · Unavailable cards show a reason`):say('没有匹配卡片，试试清空筛选或取消「只看已拥有」。','No matching cards. Clear filters or turn off Owned cards only.');
    [...filters.children].forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.attribute===attribute)));
    for(const [kind,b] of kindButtons)b.setAttribute('aria-pressed',String(target.kind===kind));
    positions.replaceChildren(node('h3',say('五组配对','Five pairs')));for(const [slot,pair] of draft.slots.entries()){const b=node('button');b.type='button';b.setAttribute('aria-label',say(`编辑位置 ${slot+1}`,`Edit slot ${slot+1}`));b.setAttribute('aria-pressed',String(slot===target.slot));const m=getCards('member').find(c=>c.id===pair.memberCardId),s=getCards('support').find(c=>c.id===pair.supportCardId);if(m?.imageUrl){const img=node('img');img.src=m.imageUrl;img.alt='';b.append(img);}const copy=node('span');copy.append(node('strong',m?.relationLabel??m?.shortLabel??say('未选成员','No member')),node('small',s?.shortLabel??say('未选留影','No snap')));b.append(copy,node('b',slot===2?say('队长','Leader'):String(slot+1)));b.addEventListener('click',()=>{target.slot=slot;page=0;previewId=getDraft().slots[slot][`${target.kind}CardId`];render();});positions.append(b);}
    renderPreview(states);
    const scrollTop=grid.scrollTop;grid.replaceChildren();
    for(const [index,card] of cards.slice(page*24,page*24+24).entries()){
      const b=node('button');b.type='button';b.dataset.cardId=card.id;const reason=conflict(card,target);b.disabled=Boolean(reason);const explanation=typeof reason==='string'?reason:say('已在其他位置使用','Already used in another slot');b.setAttribute('aria-label',(card.displayName??card.shortLabel??card.id)+(b.disabled?' · '+explanation:''));if(b.disabled)b.title=explanation;
      b.setAttribute('aria-pressed',String(previewId===card.id));if(draft?.slots?.[target.slot]?.[`${target.kind}CardId`]===card.id){const badge=node('small',say('当前使用','In use'));badge.className='ux-card-in-use';b.append(badge);}
      b.append(createTeamCardView(card,{...states.get(card.id),kind:target.kind,locale:en?'en':'zh-CN',data:root.data??{}}));if(card.id!==previewId&&(root.data?.formalRules??root.data?.rules))attachCardSkillHover(root,card,b.querySelector('.tw-card-art'),{growth:states.get(card.id).growth,leader:target.slot===2,focus:false});if(b.disabled)b.append(node('small',explanation));
      b.addEventListener('click',()=>{
        previewId=card.id;render({focusCard:card.id,focusIndex:index});
      });grid.append(b);
    }
    grid.scrollTop=scrollTop;
    prev.disabled=page===0;next.disabled=(page+1)*24>=cards.length;pageText.textContent=`${page+1} / ${Math.max(1,Math.ceil(cards.length/24))}`;
    if(focusCard){const enabled=[...grid.children].filter(b=>!b.disabled),same=enabled.find(b=>b.dataset.cardId===focusCard);(same??enabled[Math.min(focusIndex,enabled.length-1)]??clear).focus({preventScroll:true});}
  }
  search.addEventListener('input',()=>{page=0;render();});owned.addEventListener('change',()=>{page=0;render();});
  clear.addEventListener('click',()=>{search.value='';attribute='';owned.checked=false;for(const key of ['band','character','rarity','mission','normal'])selections[key].value='';selections.sort.value='default';page=0;render();});
  prev.addEventListener('click',()=>{page--;render();});next.addEventListener('click',()=>{page++;render();});close.addEventListener('click',()=>dialog.close());
  const outside=event=>{const bounds=dialog.getBoundingClientRect();return event.target===dialog&&(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom);};
  dialog.addEventListener('pointerdown',event=>{backdropPressed=outside(event);if(backdropPressed)event.stopPropagation();});
  dialog.addEventListener('click',event=>{if(backdropPressed&&outside(event)){event.preventDefault();event.stopPropagation();dialog.close();}backdropPressed=false;});
  dialog.addEventListener('cancel',event=>event.stopPropagation());
  dialog.addEventListener('close',event=>{event.stopPropagation();(root.querySelector(`[data-choose-slot="${origin?.slot}"][data-choose-kind="${origin?.kind}"]`)??opener)?.focus({preventScroll:true});});
  return {open(kind,slot){target={kind,slot};previewId=getDraft()?.slots?.[slot]?.[`${kind}CardId`];origin={...target};opener=document.activeElement;render();if(!dialog.open)dialog.showModal();search.focus({preventScroll:true});}};
}
