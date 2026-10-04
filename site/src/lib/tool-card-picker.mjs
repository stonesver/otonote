import {filterTeamCards,teamCardFilterOptions} from './team-card-filters.mjs';
import {createTeamCardView} from './team-card-view.mjs';
const node=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};

export function filterQuickCards(cards,{query='',attribute='',ownedOnly=false,owned=[]}={}) {
  return filterTeamCards(cards,{query,attribute,ownership:ownedOnly?'owned':'',owned});
}

/** Shared chooser. The caller owns actual growth, team edits, and restriction enforcement. */
export function createToolCardPicker({root,getCards,getDraft,getOwned=()=>[],getCardState,conflict=()=>'',onChoose}) {
  const en=root.ownerDocument?.documentElement.lang==='en',say=(zh,english)=>en?english:zh;
  const dialog=node('dialog');dialog.className='ux-card-picker';dialog.setAttribute('aria-label',say('搜索并选择卡片','Find and choose cards'));
  const header=node('header'),title=node('h2'),close=node('button',say('完成选卡','Done'));close.type='button';header.append(title,close);
  const search=node('input');search.type='search';search.placeholder=say('搜索角色、卡片或乐队名称','Search character, card or band name');search.setAttribute('aria-label',search.placeholder);
  const searchLabel=node('label');searchLabel.className='ux-card-search';searchLabel.append(node('span',say('搜索卡片','Search cards')),search);
  const filters=node('div');filters.className='tool-options';filters.setAttribute('role','group');filters.setAttribute('aria-label',say('卡片属性','Card attribute'));
  const filterRow=node('div');filterRow.className='ux-card-filter-row';filterRow.append(node('span',say('属性','Attribute')),filters);
  const extraFilters=node('div');extraFilters.className='ux-card-extra-filters';
  const selections={};
  for(const [key,zh,english] of [['band','乐队','Band'],['character','角色','Character'],['rarity','稀有度','Rarity'],['sort','排序','Sort']]){
    const label=node('label'),select=node('select');select.dataset.cardFilter=key;selections[key]=select;label.append(node('span',say(zh,english)),select);extraFilters.append(label);
    select.addEventListener('change',()=>{page=0;render();});
  }
  const ownedLabel=node('label'),owned=node('input');owned.type='checkbox';ownedLabel.append(owned,say('只看已拥有','Owned cards only'));
  const continuousLabel=node('label'),continuous=node('input');continuous.type='checkbox';continuous.checked=true;continuousLabel.append(continuous,say('选后继续填下一个空位','Continue to the next empty slot'));
  const options=node('div');options.className='ux-card-selection-options';options.append(ownedLabel,continuousLabel);
  const count=node('p');count.setAttribute('role','status');
  const grid=node('div');grid.className='ux-card-grid';
  const footer=node('footer'),prev=node('button',say('上一页','Previous')),next=node('button',say('下一页','Next')),pageText=node('span');prev.type=next.type='button';footer.append(prev,pageText,next);
  const clear=node('button',say('清空筛选','Clear filters'));clear.type='button';
  const results=node('div');results.className='ux-card-results-bar';results.append(count,clear);
  dialog.append(header,searchLabel,filterRow,extraFilters,options,results,grid,footer);root.append(dialog);
  let target,page=0,attribute='',origin,opener,backdropPressed=false;
  const catalogOptions=teamCardFilterOptions([...getCards('member'),...getCards('support')],root.data);
  const option=(value,label)=>{const el=node('option',label);el.value=value;return el;};
  for(const [key,zh,english] of [['band','全部乐队','All bands'],['character','全部角色','All characters'],['rarity','全部稀有度','All rarities']]){
    selections[key].append(option('',say(zh,english)));for(const item of catalogOptions[key])selections[key].append(option(item.value,item.label));
  }
  for(const [value,zh,english] of [['default','默认顺序','Default order'],['name','名称','Name'],['rarity-desc','稀有度从高到低','Highest rarity'],['level-desc','等级从高到低','Highest level']])selections.sort.append(option(value,say(zh,english)));
  for(const item of [{value:'',label:say('全部属性','All attributes')},...catalogOptions.attribute]){
    const b=node('button');b.type='button';b.dataset.attribute=item.value;b.setAttribute('aria-label',item.label);b.title=item.label;
    if(item.icon){const img=node('img');img.src=item.icon;img.alt='';img.width=26;img.height=26;img.addEventListener('error',()=>{img.remove();b.textContent=item.label;});b.append(img);}else b.textContent=item.label;
    b.addEventListener('click',()=>{attribute=item.value;page=0;render();});filters.append(b);
  }
  function render({focusCard,focusIndex=0}={}){
    if(!target)return;
    const all=getCards(target.kind),states=new Map(all.map(card=>[card.id,getCardState?.(card,target)??{growth:{},source:'unknown'}]));
    const growth=Object.fromEntries([...states].map(([id,state])=>[id,state.growth]));
    const cards=filterTeamCards(all,{query:search.value,attribute,band:selections.band.value,character:selections.character.value,rarity:selections.rarity.value,
      ownership:owned.checked?'owned':'',owned:getOwned(target.kind),sort:selections.sort.value,growth}),draft=getDraft();
    page=Math.max(0,Math.min(page,Math.ceil(cards.length/18)-1));
    title.textContent=`${target.slot===2?say('队长','Leader'):`${say('位置','Slot')} ${target.slot+1}`} · ${target.kind==='member'?say('选择成员','Choose member'):say('选择留影','Choose snap')}`;
    count.textContent=cards.length?say(`${cards.length} 张卡片 · 不可用的卡会标明原因`,`${cards.length} cards · Unavailable cards show a reason`):say('没有匹配卡片，试试清空筛选或取消「只看已拥有」。','No matching cards. Clear filters or turn off Owned cards only.');
    [...filters.children].forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.attribute===attribute)));
    const scrollTop=grid.scrollTop;grid.replaceChildren();
    for(const [index,card] of cards.slice(page*18,page*18+18).entries()){
      const b=node('button');b.type='button';b.dataset.cardId=card.id;const reason=conflict(card,target);b.disabled=Boolean(reason);const explanation=typeof reason==='string'?reason:say('已在其他位置使用','Already used in another slot');b.setAttribute('aria-label',(card.displayName??card.shortLabel??card.id)+(b.disabled?' · '+explanation:''));if(b.disabled)b.title=explanation;
      b.setAttribute('aria-pressed',String(draft?.slots?.[target.slot]?.[`${target.kind}CardId`]===card.id));
      b.append(createTeamCardView(card,{...states.get(card.id),kind:target.kind,locale:en?'en':'zh-CN',data:root.data??{}}));if(b.disabled)b.append(node('small',explanation));
      b.addEventListener('click',()=>{
        onChoose(card,target);
        const slots=getDraft().slots;
        if(continuous.checked){
          const kinds=[target.kind,target.kind==='member'?'support':'member'];let found;
          for(const kind of kinds){const slot=slots.findIndex(s=>!s[`${kind}CardId`]);if(slot>=0){found={kind,slot};break;}}
          if(found){target=found;render({focusCard:card.id,focusIndex:index});return;}
        }
        dialog.close();
      });grid.append(b);
    }
    grid.scrollTop=scrollTop;
    prev.disabled=page===0;next.disabled=(page+1)*18>=cards.length;pageText.textContent=`${page+1} / ${Math.max(1,Math.ceil(cards.length/18))}`;
    if(focusCard){const enabled=[...grid.children].filter(b=>!b.disabled),same=enabled.find(b=>b.dataset.cardId===focusCard);(same??enabled[Math.min(focusIndex,enabled.length-1)]??clear).focus({preventScroll:true});}
  }
  search.addEventListener('input',()=>{page=0;render();});owned.addEventListener('change',()=>{page=0;render();});
  clear.addEventListener('click',()=>{search.value='';attribute='';owned.checked=false;for(const key of ['band','character','rarity'])selections[key].value='';selections.sort.value='default';page=0;render();});
  prev.addEventListener('click',()=>{page--;render();});next.addEventListener('click',()=>{page++;render();});close.addEventListener('click',()=>dialog.close());
  const outside=event=>{const bounds=dialog.getBoundingClientRect();return event.target===dialog&&(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom);};
  dialog.addEventListener('pointerdown',event=>{backdropPressed=outside(event);if(backdropPressed)event.stopPropagation();});
  dialog.addEventListener('click',event=>{if(backdropPressed&&outside(event)){event.preventDefault();event.stopPropagation();dialog.close();}backdropPressed=false;});
  dialog.addEventListener('cancel',event=>event.stopPropagation());
  dialog.addEventListener('close',event=>{event.stopPropagation();(root.querySelector(`[data-choose-slot="${origin?.slot}"][data-choose-kind="${origin?.kind}"]`)??opener)?.focus({preventScroll:true});});
  return {open(kind,slot){target={kind,slot};origin={...target};opener=document.activeElement;render();if(!dialog.open)dialog.showModal();search.focus({preventScroll:true});}};
}
