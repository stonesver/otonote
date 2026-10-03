import {skillActivation} from './skill-activation-view.mjs';
export const eventElement=(tag,text,className)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(className)node.className=className;return node;};
export function currentEventDraft(tool){
 const draft=structuredClone(tool.draft);draft.modifiers??={};draft.modifiers.growth??={};
 draft.slots=tool.pairs.map(p=>({memberCardId:p.querySelector('[data-member]').value||null,supportCardId:p.querySelector('[data-support]').value||null}));
 for(const [i,p] of tool.pairs.entries())for(const kind of ['member','support']){const id=draft.slots[i][`${kind}CardId`];if(id)draft.modifiers.growth[id]={...draft.modifiers.growth[id],rank:Number(p.querySelector(`[data-${kind}-rank]`).value)};}
 return draft;
}
export function applyEventPlan(tool,row,mode){
 tool.draft=structuredClone(row.draft);delete tool.draft.modifiers.event;
 tool.q('mode').value=mode;tool.q('song').value=row.song.trackId;tool.q('rank').value=String(row.reward.scoreRank);
 tool.pairs.forEach((p,i)=>{for(const kind of ['member','support']){const id=tool.draft.slots[i][`${kind}CardId`];p.querySelector(`[data-${kind}]`).value=id;p.querySelector(`[data-${kind}-rank]`).value=tool.draft.modifiers.growth?.[id]?.rank??1;}});
 tool.q('bonus-source').value='team';tool.q('song-disclosure').open=false;tool.songPicker?.reset();tool.songPicker?.sync();tool.render();
 tool.q('team-status').textContent='已应用收益方案的队伍、歌曲与 AP 估计档位；可按实打情况调整档位。';
}
export function eventTeamDetails(tool,row){
 const el=eventElement,details=el('details',null,'event-details'),list=el('ol',null,'challenge-opt-pairs');
 details.append(el('summary','查看五组卡牌与实际养成'));
 for(const [i,slot] of row.draft.slots.entries()){
   const item=el('li');item.append(el('strong',i===2?'队长':`位置 ${i+1}`));
   for(const kind of ['member','support']){
     const id=slot[`${kind}CardId`],c=tool.data[`${kind}Cards`].find(c=>c.id===id),g=row.draft.modifiers.growth?.[id]??{},cell=el('div',null,'challenge-opt-card');
     if(c?.imageUrl){const img=el('img');img.src=c.imageUrl;img.alt='';img.loading='lazy';img.addEventListener('error',()=>img.remove(),{once:true});cell.append(img);}
     cell.append(el('span',`${c?.displayName??id} · Lv.${g.level??'默认上限'} / 突破 ${g.rank??1}${kind==='member'?` / 技能 ${g.skillLevel??1}`:''}`));item.append(cell);
   }list.append(item);
 }details.append(list,skillActivation(tool,row.draft,{mode:row.reward.mode,eventId:Number(tool.q('event').value)}));return details;
}
