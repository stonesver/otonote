const node=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};

export function filterQuickCards(cards,{query='',attribute='',ownedOnly=false,owned=[]}={}) {
  const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),ids=new Set(owned);
  return cards.filter(c=>(!attribute||String(c.attributeCode)===attribute)&&(!ownedOnly||ids.has(c.id))&&words.every(w=>c.displayName.toLocaleLowerCase().includes(w)));
}

/** Shared small card chooser. Caller owns team data, growth and validation. */
export function createToolCardPicker({root,getCards,getDraft,getOwned,conflict,onChoose}) {
  const en=root.ownerDocument?.documentElement.lang==='en',say=(zh,english)=>en?english:zh;
  const dialog=node('dialog');dialog.className='ux-card-picker';dialog.setAttribute('aria-label',say('搜索并选择卡片','Find and choose cards'));
  const header=node('header'),title=node('h2'),close=node('button',say('完成选卡','Done'));close.type='button';header.append(title,close);
  const search=node('input');search.type='search';search.placeholder=say('搜索角色或卡片名称','Search character or card name');search.setAttribute('aria-label',search.placeholder);
  const searchLabel=node('label');searchLabel.className='ux-card-search';searchLabel.append(node('span',say('搜索卡片','Search cards')),search);
  const filters=node('div');filters.className='tool-options';filters.setAttribute('role','group');filters.setAttribute('aria-label',say('卡片属性','Card attribute'));
  const attrs=[['',say('全部属性','All attributes')],['1',say('红赤','Akabeni')],['2',say('绀碧','Konpeki')],['3',say('翡翠','Hisui')],['4',say('山吹','Yamabuki')],['5',say('紫苑','Shion')]];
  const filterRow=node('div');filterRow.className='ux-card-filter-row';filterRow.append(node('span',say('属性','Attribute')),filters);
  const ownedLabel=node('label'),owned=node('input');owned.type='checkbox';ownedLabel.append(owned,say('只看已拥有','Owned cards only'));
  const continuousLabel=node('label'),continuous=node('input');continuous.type='checkbox';continuous.checked=true;continuousLabel.append(continuous,say('选后继续填下一个空位','Continue to the next empty slot'));
  const options=node('div');options.className='ux-card-selection-options';options.append(ownedLabel,continuousLabel);
  const count=node('p');count.setAttribute('role','status');
  const grid=node('div');grid.className='ux-card-grid';
  const footer=node('footer'),prev=node('button',say('上一页','Previous')),next=node('button',say('下一页','Next')),pageText=node('span');prev.type=next.type='button';footer.append(prev,pageText,next);
  const clear=node('button',say('清空筛选','Clear filters'));clear.type='button';
  const results=node('div');results.className='ux-card-results-bar';results.append(count,clear);
  dialog.append(header,searchLabel,filterRow,options,results,grid,footer);root.append(dialog);
  let target,page=0,attribute='',origin;
  for(const [value,label] of attrs){const b=node('button');b.type='button';b.dataset.attribute=value;b.setAttribute('aria-label',label);b.title=label;
    const visual=root.data?.filterVisualOptions?.attribute?.find(item=>item.value===value);
    if(visual?.icon){const img=node('img');img.src=visual.icon;img.alt='';img.width=26;img.height=26;img.addEventListener('error',()=>{img.remove();b.textContent=label;});b.append(img);}else b.textContent=label;
    b.addEventListener('click',()=>{attribute=value;page=0;render();});filters.append(b);}
  function render(){
    const cards=filterQuickCards(getCards(target.kind),{query:search.value,attribute,ownedOnly:owned.checked,owned:getOwned(target.kind)}),draft=getDraft();
    page=Math.max(0,Math.min(page,Math.ceil(cards.length/18)-1));
    title.textContent=`${target.slot===2?say('队长','Leader'):`${say('位置','Slot')} ${target.slot+1}`} · ${target.kind==='member'?say('选择成员','Choose member'):say('选择留影','Choose snap')}`;
    count.textContent=cards.length?say(`${cards.length} 张卡片 · 已使用的角色或留影不可重复选择`,`${cards.length} cards · Used characters and snaps cannot be selected twice`):say('没有匹配卡片，试试清空筛选或取消「只看已拥有」。','No matching cards. Clear filters or turn off Owned cards only.');
    [...filters.children].forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.attribute===attribute)));
    grid.replaceChildren();
    for(const card of cards.slice(page*18,page*18+18)){
      const b=node('button');b.type='button';const reason=conflict(card,target);b.disabled=Boolean(reason);const explanation=typeof reason==='string'?reason:say('已在其他位置使用','Already used in another slot');b.setAttribute('aria-label',card.displayName+(b.disabled?' · '+explanation:''));if(b.disabled)b.title=explanation;
      b.setAttribute('aria-pressed',String(draft.slots[target.slot][`${target.kind}CardId`]===card.id));
      if(card.imageUrl){const img=node('img');img.src=card.imageUrl;img.alt='';img.loading='lazy';b.append(img);}
      b.append(node('span',card.displayName));if(b.disabled)b.append(node('small',explanation));
      b.addEventListener('click',()=>{
        onChoose(card,target);
        const slots=getDraft().slots;
        if(continuous.checked){
          const kinds=[target.kind,target.kind==='member'?'support':'member'];let found;
          for(const kind of kinds){const slot=slots.findIndex(s=>!s[`${kind}CardId`]);if(slot>=0){found={kind,slot};break;}}
          if(found){target=found;search.value='';page=0;render();search.focus();return;}
        }
        dialog.close();
      });grid.append(b);
    }
    prev.disabled=page===0;next.disabled=(page+1)*18>=cards.length;pageText.textContent=`${page+1} / ${Math.max(1,Math.ceil(cards.length/18))}`;
  }
  search.addEventListener('input',()=>{page=0;render();});owned.addEventListener('change',()=>{page=0;render();});
  clear.addEventListener('click',()=>{search.value='';attribute='';owned.checked=false;page=0;render();});
  prev.addEventListener('click',()=>{page--;render();});next.addEventListener('click',()=>{page++;render();});close.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{root.querySelector(`[data-choose-slot="${origin.slot}"][data-choose-kind="${origin.kind}"]`)?.focus();});
  return {open(kind,slot){target={kind,slot};origin={...target};page=0;search.value='';attribute='';owned.checked=getOwned(kind).length>0;render();dialog.showModal();search.focus();}};
}
