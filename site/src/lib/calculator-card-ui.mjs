import { cardSkillRows } from './calculator-card-model.mjs';
import { attributeBadge } from './calculator-attribute-ui.mjs';
export const cardElement = (tag, text, cls) => { const n = document.createElement(tag); if(text != null)n.textContent=text; if(cls)n.className=cls; return n; };
const labels = {leader:'队长',live:'演出',support:'支援',gekisou:'激奏',gekisou_support:'激奏'};
export function skillBlock(workbench, card, { growth, maximum = false, mode, leader = true, compact = false, showNames = true } = {}) {
  const root=cardElement('div',null,'card-skill-list');
  const rows=cardSkillRows(card,workbench.data.formalRules??workbench.data.rules,growth,{maximum});
  for(const row of rows) {
    const gekisou=row.kind.startsWith('gekisou');
    if(compact && row.kind==='leader')continue;
    if(mode==='ordinary'&&gekisou)continue;
    const item=cardElement('div',null,'card-skill'); item.dataset.mission=String(row.mission ?? 0);
    const tag=gekisou?['激奏','COMBO','LUCK','JUST'][row.mission]:labels[row.kind]??'技能';
    item.append(cardElement('span',`${tag} · Lv.${row.level??'?'}${maximum?'（满级预览）':''}${row.kind==='leader'&&!leader?' · 非队长不生效':''}`,'card-skill-label'));
    if(!compact&&showNames)item.append(cardElement('strong',row.name));
    item.append(cardElement('p',row.summary));root.append(item);
  }
  if(!rows.length)root.append(cardElement('p','暂无技能资料'));
  return root;
}
export function cardIdentity(workbench, card) {
  const root=cardElement('div',null,'card-identity');
  if(card.imageUrl){const img=cardElement('img');img.src=card.imageUrl;img.alt='';img.loading='lazy';root.append(img);}
  const text=cardElement('div');text.append(cardElement('small',`${card.kind==='member'?'成员':'留影'} · ${card.rarityLabel??`RARITY ${card.rarity}`} · #${card.masterId}`),cardElement('strong',card.shortLabel),cardElement('span',card.relationLabel));
  root.append(text,attributeBadge(card.attributeCode,workbench.data.attributeVisuals));return root;
}

export function setupAttributeFilter(root, onChange) {
  const values=new Set();
  const sync=()=>root.querySelectorAll('[data-attribute-value]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.attributeValue?values.has(b.dataset.attributeValue):!values.size)));
  root.querySelectorAll('[data-attribute-value]').forEach(b=>b.addEventListener('click',()=>{const v=b.dataset.attributeValue;if(!v)values.clear();else if(values.has(v))values.delete(v);else values.add(v);sync();onChange();}));
  return {get values(){return [...values];},reset(){values.clear();sync();}};
}

const popovers=new WeakMap();
function skillPopover(workbench) {
  if(popovers.has(workbench))return popovers.get(workbench);
  const panel=cardElement('section',null,'card-skill-popover');panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','卡片技能详情');panel.id=`card-skills-${Math.random().toString(36).slice(2)}`;document.body.append(panel);
  let anchor,trigger,pinned=false,timer;
  const hide=()=>{clearTimeout(timer);panel.hidden=true;pinned=false;trigger?.setAttribute('aria-expanded','false');};
  const leave=()=>{clearTimeout(timer);if(!pinned)timer=setTimeout(hide,180);};
  const show=(target,button,card,options,pin=false)=>{
    if(!target.isConnected){hide();return;}
    clearTimeout(timer);if(!pin&&pinned)return;
    const layer=target.closest('dialog[open]')??document.body;if(panel.parentElement!==layer)layer.append(panel);
    trigger?.setAttribute('aria-expanded','false');anchor=target;trigger=button;pinned=pin;panel.replaceChildren();
    const header=cardElement('div',null,'skill-popover-heading'),close=cardElement('button','×','skill-popover-close');close.type='button';close.setAttribute('aria-label','关闭技能详情');close.addEventListener('click',()=>{hide();button.focus({preventScroll:true});});
    header.append(cardElement('strong',card.shortLabel),close);panel.append(header,cardElement('p',options.maximum?'满级技能预览 · 不代表实际养成':'当前养成 · 未记录项按规则默认值','card-growth-note'),skillBlock(workbench,card,{...options,showNames:false}));
    panel.hidden=false;button.setAttribute('aria-expanded','true');panel.style.visibility='hidden';panel.style.maxHeight='';
    const boundary=layer===document.body?{left:0,top:0,right:window.innerWidth,bottom:window.innerHeight}:layer.getBoundingClientRect();
    const bounds={left:Math.max(12,boundary.left+10),right:Math.min(window.innerWidth-12,boundary.right-10),top:Math.max(12,boundary.top+10),bottom:Math.min(window.innerHeight-12,boundary.bottom-10)};
    panel.style.width=`${Math.min(320,bounds.right-bounds.left)}px`;panel.style.maxHeight=`${Math.min(360,bounds.bottom-bounds.top)}px`;
    const r=target.getBoundingClientRect(),w=panel.getBoundingClientRect().width,h=panel.getBoundingClientRect().height;
    let left,top;
    if(r.right+w+8<=bounds.right){left=r.right+8;top=Math.max(bounds.top,Math.min(r.top,bounds.bottom-h));}
    else if(r.left-w-8>=bounds.left){left=r.left-w-8;top=Math.max(bounds.top,Math.min(r.top,bounds.bottom-h));}
    else {
      left=Math.max(bounds.left,Math.min(bounds.right-w,r.left));
      const above=r.top-bounds.top-8,below=bounds.bottom-r.bottom-8,useBelow=below>=above;
      panel.style.maxHeight=`${Math.max(60,Math.min(360,useBelow?below:above))}px`;
      top=useBelow?r.bottom+8:Math.max(bounds.top,r.top-panel.getBoundingClientRect().height-8);
    }
    panel.style.left=`${left}px`;panel.style.top=`${top}px`;panel.style.visibility='';if(pin)close.focus({preventScroll:true});
  };
  panel.addEventListener('pointerenter',()=>clearTimeout(timer));panel.addEventListener('pointerleave',leave);
  const events=new AbortController();
  document.addEventListener('pointerdown',e=>{if(!panel.hidden&&!panel.contains(e.target)&&!anchor?.contains(e.target)&&e.target!==trigger)hide();},{signal:events.signal});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden){const b=trigger;hide();b?.focus({preventScroll:true});}},{signal:events.signal});
  window.addEventListener('resize',hide,{signal:events.signal});
  document.addEventListener('scroll',e=>{if(!panel.hidden&&!pinned&&!panel.contains(e.target))hide();},{capture:true,signal:events.signal});
  const manager={panel,show,hide,leave,hover(target,button,card,options){clearTimeout(timer);timer=setTimeout(()=>show(target,button,card,options),220);},keep:()=>clearTimeout(timer),toggle(target,button,card,options){if(!panel.hidden&&trigger===button&&pinned)hide();else show(target,button,card,options,true);},destroy(){hide();panel.remove();events.abort();popovers.delete(workbench);}};
  popovers.set(workbench,manager);return manager;
}
export function skillPeek(workbench,card,options={},hoverTarget) {
  const button=cardElement('button','技能','card-skill-trigger');button.type='button';button.setAttribute('aria-label',`查看 ${card.shortLabel} 的技能`);button.setAttribute('aria-expanded','false');button.setAttribute('aria-haspopup','dialog');
  const manager=skillPopover(workbench);button.setAttribute('aria-controls',manager.panel.id);
  const target=hoverTarget??button;
  if(options.hover!==false){target.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse')manager.hover(target,button,card,options);});target.addEventListener('pointerleave',manager.leave);}
  button.addEventListener('blur',manager.leave);
  button.addEventListener('click',e=>{e.stopPropagation();e.preventDefault();manager.toggle(target,button,card,options);});return button;
}
export function closeSkillPopover(workbench){popovers.get(workbench)?.hide();}
export function destroySkillPopover(workbench){popovers.get(workbench)?.destroy();}
/** Hover/focus on the artwork itself; no extra skill button inside a card button. */
export function attachCardSkillHover(workbench,card,target,options={}) {
  const manager=skillPopover(workbench),focusTarget=target.closest('button')??target;
  if(focusTarget===target){target.tabIndex=0;target.setAttribute('aria-label',`${card.shortLabel??card.displayName} · 技能说明`);}
  focusTarget.setAttribute('aria-controls',manager.panel.id);
  target.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse')manager.hover(target,focusTarget,card,options);});
  target.addEventListener('pointerleave',manager.leave);
  if(options.focus!==false)focusTarget.addEventListener('focus',()=>manager.hover(target,focusTarget,card,options));focusTarget.addEventListener('blur',manager.leave);
  focusTarget.addEventListener('keydown',e=>{if(e.key==='Escape')manager.hide();});
}
