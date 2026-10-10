const fmt=n=>Number(n).toLocaleString('zh-CN',{maximumFractionDigits:2});
const numeric=id=>Number(id.split('-').at(-1));
const bonusKey=kind=>kind==='member'?'eventPointBP':'rewardBP';
const bonusLabel=kind=>kind==='member'?'活动 pt':'道具';
function node(tag,text,className){const el=document.createElement(tag);if(text!=null)el.textContent=text;if(className)el.className=className;return el;}
function portrait(card){if(!card.imageUrl)return node('span','＋','event-card-placeholder');const img=document.createElement('img');img.src=card.imageUrl;img.alt='';img.loading='lazy';img.width=48;img.height=60;img.addEventListener('error',()=>img.replaceWith(node('span','♪','event-card-placeholder')),{once:true});return img;}
export function setupEventCardPicker(tool){
 const q=tool.q,dialog=q('card-dialog');let target,trigger,page=0;
 const cards=kind=>tool.data[kind==='member'?'memberCards':'supportCards'];
 const inventory=()=>{try{return tool.personalGrowthStore.read()?.inventory;}catch{return null;}};
 function rankFor(kind,card,owned){return q('card-scope').value==='owned'?(owned?.growth?.[card.id]?.rank??1):Number(tool.pairs[target.slot].querySelector(`[data-${kind}-rank]`).value);}
 function choices(){
  if(!target)return;const {kind,slot}=target,model=tool.model(),owned=inventory(),query=q('card-query').value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),attribute=q('card-attribute').value;
  const native=tool.data.rules.tables[kind==='member'?'MemberCard':'SupportCard'];const characterFor=cardId=>native.find(c=>c._id===numeric(cardId))?._characterID;
  const current=tool.pairs[slot].querySelector(`[data-${kind}]`).value;
  const used=tool.pairs.filter((_,i)=>i!==slot).map(p=>p.querySelector(`[data-${kind}]`).value).filter(Boolean);
  let rows=cards(kind).filter(c=>(!attribute||String(c.attributeCode)===attribute)&&query.every(w=>`${c.displayName} ${c.relationLabel}`.toLocaleLowerCase().includes(w))&&(q('card-scope').value!=='owned'||owned?.[`${kind}CardIds`]?.includes(c.id)))
   .map(card=>({card,rank:rankFor(kind,card,owned),bonus:model.cardBonus(kind,numeric(card.id),rankFor(kind,card,owned))[bonusKey(kind)],duplicate:kind==='member'?used.some(id=>characterFor(id)===characterFor(card.id)):used.includes(card.id)}));
  rows.sort(q('card-sort').value==='name'?(a,b)=>a.card.displayName.localeCompare(b.card.displayName,'zh-CN'):(a,b)=>b.bonus-a.bonus||a.card.displayName.localeCompare(b.card.displayName,'zh-CN'));
  const pages=Math.max(1,Math.ceil(rows.length/18));page=Math.min(page,pages-1);q('card-results').replaceChildren();q('card-count').textContent=`${rows.length} 张${kind==='member'?'成员卡':'留影'} · 先看加成，再考虑能否达到评分`;
  q('picker-note').textContent=q('card-scope').value==='owned'?'按已保存养成计算；选择后会带入这张卡的养成。':`按此位置${kind==='member'?'觉醒':'突破'} ${tool.pairs[slot].querySelector(`[data-${kind}-rank]`).value} 计算加成；可在队伍中调整。`;
  q('card-empty').hidden=rows.length>0;q('card-page').textContent=`${page+1} / ${pages}`;q('card-prev').disabled=page===0;q('card-next').disabled=page===pages-1;
  for(const {card,rank,bonus,duplicate} of rows.slice(page*18,(page+1)*18)){
   const button=node('button',null,'event-picker-card');button.type='button';button.disabled=duplicate;button.setAttribute('aria-pressed',String(card.id===current));button.setAttribute('aria-label',`${card.displayName}，${card.relationLabel}，${card.attributeLabel}，${bonusLabel(kind)}加成 ${fmt(bonus/100)}%${duplicate?'，已在其他位置使用':''}`);
   const info=node('span'),meta=node('small',null,'event-picker-card-meta');
   if(card.attributeIcon){const icon=node('img');icon.src=card.attributeIcon;icon.alt='';icon.title=card.attributeLabel;icon.width=20;icon.height=20;icon.loading='lazy';meta.append(icon);}
   meta.append(node('span',card.relationLabel+(card.attributeIcon?'':` · ${card.attributeLabel}`)));
   info.append(node('strong',card.displayName),meta,node('b',`${bonusLabel(kind)} +${fmt(bonus/100)}%`));if(duplicate)info.append(node('small',kind==='member'?'该角色已在队伍中':'已在其他位置使用'));
   button.append(portrait(card),info);button.addEventListener('click',()=>{const pair=tool.pairs[slot];pair.querySelector(`[data-${kind}]`).value=card.id;pair.querySelector(`[data-${kind}-rank]`).value=rank;if(q('card-scope').value==='owned'){tool.draft.modifiers.growth??={};tool.draft.modifiers.growth[card.id]={...inventory()?.growth?.[card.id]};}q('bonus-source').value='team';q('team-status').textContent='卡片已更新，请确认养成与稳定评分。';tool.render();dialog.close();});q('card-results').append(button);
  }
 }
 tool.querySelectorAll('[data-open-card]').forEach(button=>button.addEventListener('click',()=>{target={kind:button.dataset.openCard,slot:Number(button.dataset.slot)};trigger=button;page=0;q('card-query').value='';q('card-attribute').value='';q('card-scope').value=q('pool').value==='owned'&&inventory()?'owned':'all';q('picker-title').textContent=target.kind==='member'?'选择成员卡':'选择留影';q('picker-slot').textContent=`位置 ${target.slot+1}${target.slot===2?' · 队长':''}`;choices();tool.shortcuts?.sync();dialog.showModal();q('card-query').focus();}));
 q('close-picker').addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>trigger?.focus());
 for(const field of ['card-query','card-attribute','card-scope','card-sort'])q(field).addEventListener(field==='card-query'?'input':'change',()=>{page=0;choices();});
 q('card-prev').addEventListener('click',()=>{page--;choices();q('card-results').scrollIntoView({block:'start'});});q('card-next').addEventListener('click',()=>{page++;choices();q('card-results').scrollIntoView({block:'start'});});
 function sync(){
  let model;try{model=tool.model();}catch{return;}
  tool.pairs.forEach((pair,i)=>{for(const kind of ['member','support']){const card=cards(kind).find(c=>c.id===pair.querySelector(`[data-${kind}]`).value),button=pair.querySelector(`[data-open-card="${kind}"]`),bonus=pair.querySelector(`[data-card-bonus="${kind}"]`);button.replaceChildren();button.setAttribute('aria-label',`位置 ${i+1} ${kind==='member'?'成员':'留影'}：${card?.displayName??'未选择'}，点击更换`);if(card){const info=node('span');info.append(node('strong',card.displayName),node('small',card.relationLabel));button.append(portrait(card),info);bonus.textContent=`${bonusLabel(kind)} +${fmt(model.cardBonus(kind,numeric(card.id),Number(pair.querySelector(`[data-${kind}-rank]`).value))[bonusKey(kind)]/100)}%`;}else{button.append(node('span','＋','event-card-placeholder'),node('span',`选择${kind==='member'?'成员':'留影'}`));bonus.textContent='待选择';}}});
 }
 return {sync};
}
