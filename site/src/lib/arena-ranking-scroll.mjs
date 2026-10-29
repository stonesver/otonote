/** Scroll requests only the public snapshot API; failures require an explicit retry. */
export function createArenaRankingScroll({root,getState,loadMore,isBlocked=()=>false,
 makeObserver=callback=>typeof IntersectionObserver==='function'?new IntersectionObserver(callback,{rootMargin:'160px 0px'}):null}) {
 let observer=null,stopped=false;
 function observe(){
  observer?.disconnect();
  if(stopped)return;
  const target=root.querySelector('[data-ranking-sentinel]');
  if(!target)return;
  observer=makeObserver(entries=>{
   const state=getState();
   if(stopped||!target.isConnected||root.querySelector('[data-ranking-sentinel]')!==target||root.ownerDocument?.visibilityState==='hidden'||isBlocked()||!entries.some(e=>e.target===target&&e.isIntersecting)
    ||!['available','stale'].includes(state.status)||state.loadingMore||state.refreshing||state.paginationError||!state.data?.nextCursor)return;
   void loadMore();
  });
  observer?.observe(target);
 }
 const visibility=()=>observe();root.ownerDocument?.addEventListener('visibilitychange',visibility);
 return {observe,destroy(){stopped=true;observer?.disconnect();root.ownerDocument?.removeEventListener('visibilitychange',visibility);}};
}

/** Append within one immutable observation without detaching existing expanded rows. */
export function patchArenaRankings(section,html,snapshotId){
 const template=section.ownerDocument.createElement('template');template.innerHTML=html;
 const currentList=section.querySelector('.arena-ranking-list'),nextList=template.content.querySelector('.arena-ranking-list');
 const append=Boolean(snapshotId&&section.dataset.snapshotId===snapshotId&&currentList&&nextList&&nextList.children.length>=currentList.children.length&&[...currentList.children].every((row,index)=>row.dataset.playerId===nextList.children[index]?.dataset.playerId&&row.dataset.playerRank===nextList.children[index]?.dataset.playerRank));
 const active=section.ownerDocument.activeElement,action=section.contains(active)?active.dataset.action:null,field=section.contains(active)?active.dataset.field:null;
 if(action)section.dataset.pendingFocus=action;
 let firstAdded=null;
 if(append){
  const count=currentList.children.length;
  const added=[...nextList.children].slice(count);firstAdded=added[0]?.querySelector('summary');currentList.append(...added);
  for(const selector of ['[data-ranking-overview]','[data-ranking-footer]'])section.querySelector(selector)?.replaceWith(template.content.querySelector(selector));
 }else section.replaceChildren(template.content);
 section.dataset.snapshotId=snapshotId??'';
 if(field)section.querySelector(`[data-field="${field}"]`)?.focus({preventScroll:true});
 const pending=section.dataset.pendingFocus;
 if(pending){
  const target=pending==='ranking-more'&&firstAdded?firstAdded:section.querySelector(`[data-action="${pending}"]`);
  if(active.isConnected&&active!==section.ownerDocument.body&&action!==pending)delete section.dataset.pendingFocus;
  else if(target&&!target.disabled){target.focus({preventScroll:true});delete section.dataset.pendingFocus;}
  else if(!target)delete section.dataset.pendingFocus;
 }
}
