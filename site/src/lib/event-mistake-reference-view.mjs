const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
const range=values=>values[0]===values[1]?String(values[0]):values.join('–');
export function renderMistakeReference(root,reference){
 root.replaceChildren();
 if(reference.status!=='estimated'){
  root.append(el('p',reference.status==='lowest_grade'?'当前已是最低奖励档位。':'该技能顺序的最低分尚未达档，暂无失误余量。'));return;
 }
 const cards=el('div',null,'event-mistake-cards'),notes=el('details',null,'event-risk-method');notes.append(el('summary','参考说明 · 非保底'));
 for(const result of reference.results){
  const miss=result.judgement===1,card=el('div',null,'event-mistake-card');card.dataset.risk=result.oneCanFail?'high':'reference';
  card.append(el('span',miss?'MISS':'GREAT','event-judgement-tag'));
  card.append(el('strong',result.oneCanFail?'1 次也可能掉档':`${range(result.passingRange)} 个`));
  if(result.oneCanFail)notes.append(el('p',`${miss?'MISS':'GREAT'}：已检查的达档样例为 ${range(result.passingRange)} 个，存在 1 次就失败的落点，不能作为稳定上限。`));
  else if(result.allInputsPassed)notes.append(el('p',`${miss?'MISS':'GREAT'}：已检查的全部落点仍达标。`));
  cards.append(card);
 }
 root.append(cards);
 notes.append(el('p',`固定 AP 最低分技能顺序，分别检查 GREAT 和 MISS 的 ${reference.patternCount} 种分散／集中落点；其余判定为 PERFECT。次数为技能判定辅助处理后的结算数，已计入连击、生命与技能变化。`));
 notes.append(el('p','这是已检查样例的参考范围，不是保底次数或成功概率。长条断开造成的连带漏击、其他技能顺序和输入时机变化未穷举。'));root.append(notes);
}

export function syncEventMistakeReferences(container,enabled=true){
 const views=[...container.querySelectorAll('.event-mistake-reference')];
 const visible=enabled?views.filter(view=>!view.closest('[hidden]')):[];
 for(const view of views)if(!visible.includes(view))view.setActive(false);
 for(const view of visible)view.setActive(true);
}

if(typeof HTMLElement!=='undefined'&&!customElements.get('event-mistake-reference')){
 class EventMistakeReference extends HTMLElement{
  connectedCallback(){
   if(!this.initialized){
    this.initialized=true;this.labels=[];this.setAttribute('aria-label','GREAT 和 MISS 容错参考');
    for(const name of ['GREAT','MISS']){const chip=el('span',null,'event-summary-chip'),value=el('b','待计算');chip.dataset.tone='reference';chip.append(el('span',name),value);this.labels.push(value);this.append(chip);}
    this.retry=el('button','重试');this.retry.type='button';this.retry.hidden=true;this.retry.addEventListener('click',()=>this.load());this.append(this.retry);
   }
   if(this.active)this.show();
  }
  setActive(active){
   if(this.active===active)return;this.active=active;
   if(!active){this.stop();return;}if(this.isConnected)this.show();
  }
  show(){
   this.result??=this.cache?.get(this.cacheKey);
   if(this.result){this.present();return;}if(!this.worker)this.load();
  }
  present(){
   for(const [i,judgement] of [4,1].entries()){
    const result=this.result.results?.find(r=>r.judgement===judgement);
    this.labels[i].textContent=result?(result.oneCanFail?'1 次可能掉档':range(result.passingRange)):'无余量';
    this.labels[i].parentElement.dataset.tone=result?.oneCanFail?'warn':'reference';
   }
   this.retry.hidden=true;this.removeAttribute('aria-busy');renderMistakeReference(this.details,this.result);
  }
  stop(){this.worker?.terminate();this.worker=null;}
  disconnectedCallback(){this.active=false;this.stop();}
  load(){
   this.stop();this.retry.hidden=true;this.setAttribute('aria-busy','true');for(const label of this.labels)label.textContent='计算中…';
   const status=el('p','正在模拟这支队伍的失误位置…');status.setAttribute('role','status');this.details.replaceChildren(status);
   const fail=message=>{this.stop();this.removeAttribute('aria-busy');for(const label of this.labels)label.textContent='未算出';status.textContent=message;this.retry.hidden=false;};
   try{
    const worker=new Worker(new URL('./skill-activation-worker.mjs',import.meta.url),{type:'module'});this.worker=worker;
    worker.onmessage=({data})=>{
     if(this.worker!==worker)return;
     if(data.error){fail(data.error);return;}
     if(data.referenceProgress){status.textContent=`正在模拟失误位置 · ${data.referenceProgress.completed} / ${data.referenceProgress.total}`;return;}
     this.stop();this.result=data.reference;this.cache?.set(this.cacheKey,this.result);this.present();
    };
    worker.onerror=()=>{if(this.worker===worker)fail('失误参考计算失败，请重试。');};worker.postMessage(this.payload);
   }catch(error){fail(error.message);}
  }
 }
 customElements.define('event-mistake-reference',EventMistakeReference);
}

export function eventMistakeReference(row,rules,{details,cache}={}){
 const view=document.createElement('event-mistake-reference');view.className='event-mistake-reference';view.details=details;view.cache=cache;
 view.payload={rules,chart:row.song,draft:structuredClone(row.draft),mode:row.reward.mode,eventId:row.reward.eventId,
  mistakeReference:{order:row.worstOrder,targetRank:row.reward.scoreRank}};
 view.cacheKey=JSON.stringify([row.song.id,row.song.analysisDataUrl,view.payload.draft,row.reward.mode,row.reward.eventId,row.worstOrder,row.reward.scoreRank]);
 return view;
}
