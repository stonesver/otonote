const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
const range=values=>values[0]===values[1]?String(values[0]):values.join('–');
export function renderMistakeReference(root,reference){
 root.replaceChildren();
 if(reference.status!=='estimated'){
  root.append(el('p',reference.status==='lowest_grade'?'当前已是最低奖励档位。':'该技能顺序的最低分尚未达档，暂无失误余量。'));return;
 }
 const cards=el('div',null,'event-mistake-cards');
 for(const result of reference.results){
  const miss=result.judgement===1,card=el('div',null,'event-mistake-card');card.dataset.risk=result.oneCanFail?'high':'reference';
  card.append(el('span',miss?'MISS':'GREAT','event-judgement-tag'));
  card.append(el('strong',result.oneCanFail?'1 次也可能掉档':`${range(result.passingRange)} 个`));
  card.append(el('small',result.oneCanFail?(miss?'断连与技能变化可能用尽余量':'判定变化可能用尽余量'):result.allInputsPassed?'已检查的全部落点仍达标':'不同落点下的达档参考'));
  if(result.oneCanFail)card.append(el('small',`已检查的达档样例：${range(result.passingRange)} 个；不能作为稳定上限。`));
  cards.append(card);
 }
 root.append(cards);
 const notes=el('details',null,'event-risk-method');notes.append(el('summary','参考怎么算'));
 notes.append(el('p',`固定 AP 最低分技能顺序，分别检查 GREAT 和 MISS 的 ${reference.patternCount} 种分散／集中落点；其余判定为 PERFECT。次数为技能判定辅助处理后的结算数，已计入连击、生命与技能变化。`));
 notes.append(el('p','这是已检查样例的参考范围，不是保底次数或成功概率。长条断开造成的连带漏击、其他技能顺序和输入时机变化未穷举。'));root.append(notes);
}

if(typeof HTMLElement!=='undefined'&&!customElements.get('event-mistake-reference')){
 class EventMistakeReference extends HTMLElement{
  connectedCallback(){
   if(this.initialized)return;this.initialized=true;
   const details=el('details',null,'event-mistake-reference'),summary=el('summary'),body=el('div',null,'event-mistake-body');
   summary.append(el('span','GREAT / MISS 容错参考'),el('span','点击估算','event-risk-chip'));details.append(summary,body);this.append(details);
   details.addEventListener('toggle',()=>{
    if(!details.open){this.stop();return;}
    if(this.result){renderMistakeReference(body,this.result);return;}this.load(body);
   });
  }
  stop(){this.worker?.terminate();this.worker=null;}
  disconnectedCallback(){this.stop();}
  load(body){
   this.stop();const status=el('p','正在模拟这支队伍的失误位置…');status.setAttribute('role','status');body.replaceChildren(status);
   const fail=message=>{this.stop();status.textContent=message;const retry=el('button','重试');retry.type='button';retry.addEventListener('click',()=>this.load(body));body.append(retry);};
   try{
    const worker=new Worker(new URL('./skill-activation-worker.mjs',import.meta.url),{type:'module'});this.worker=worker;
    worker.onmessage=({data})=>{
     if(this.worker!==worker)return;
     if(data.error){fail(data.error);return;}
     if(data.referenceProgress){status.textContent=`正在模拟失误位置 · ${data.referenceProgress.completed} / ${data.referenceProgress.total}`;return;}
     this.stop();this.result=data.reference;renderMistakeReference(body,this.result);
    };
    worker.onerror=()=>{if(this.worker===worker)fail('失误参考计算失败，请重试。');};worker.postMessage(this.payload);
   }catch(error){fail(error.message);}
  }
 }
 customElements.define('event-mistake-reference',EventMistakeReference);
}

export function eventMistakeReference(row,rules){
 const view=document.createElement('event-mistake-reference');
 view.payload={rules,chart:row.song,draft:structuredClone(row.draft),mode:row.reward.mode,eventId:row.reward.eventId,
  mistakeReference:{order:row.worstOrder,targetRank:row.reward.scoreRank}};
 return view;
}
