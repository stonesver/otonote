/** A percentage describes the reported stage, never an estimated time remaining. */
export function progressSnapshot({label='正在计算',completed,total,detail='',state='running'}={}) {
 const known=Number.isFinite(completed)&&Number.isFinite(total)&&total>0;
 const done=known?Math.max(0,Math.min(total,completed)):null;
 return {label,detail,state,completed:done,total:known?total:null,
  fraction:known?done/total:null,counter:known?`${done.toLocaleString()} / ${total.toLocaleString()}`:''};
}

export function createCalculationProgress(anchor,kind,{now=()=>performance.now(),schedule=setInterval,unschedule=clearInterval}={}) {
 const root=document.createElement('section');root.className='calculation-progress';root.dataset.calculationProgress=kind;root.hidden=true;
 const heading=document.createElement('div'),label=document.createElement('strong'),counter=document.createElement('span'),bar=document.createElement('progress'),detail=document.createElement('small');
 heading.append(label,counter);bar.max=1;root.append(heading,bar,detail);anchor.before(root);
 const badge=document.createElement('b');badge.className='calculation-state';heading.append(badge);
 label.setAttribute('role','status');detail.setAttribute('role','status');counter.setAttribute('aria-live','off');
 let previous,started,ended,timer;
 const stopClock=()=>{if(timer!==undefined)unschedule(timer);timer=undefined;};
 function tick(){
  const seconds=started===undefined?null:Math.max(0,Math.floor(((ended??now())-started)/1000));
  const elapsed=seconds===null?'':seconds===0?'不足 1 秒':seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;
  const text=[previous?.state==='running'?previous.counter:'',elapsed?`${previous?.state==='running'?'已用时':'用时'} ${elapsed}`:''].filter(Boolean).join(' · ');
  if(counter.textContent!==text)counter.textContent=text;
 }
 function update(input){
  const p=progressSnapshot(input);root.hidden=false;root.dataset.state=p.state;
  if(p.state!==previous?.state){
   badge.textContent={running:'计算中',complete:'已完成',stopped:'已停止',error:'未完成'}[p.state]??p.state;
   if(p.state==='running'){started=now();ended=undefined;stopClock();timer=schedule(tick,1000);timer?.unref?.();}else {ended=now();stopClock();}
  }
  if(p.label!==previous?.label)label.textContent=p.label;
  const detailText=p.state==='error'?(p.detail||p.label):p.detail;
  const previousDetail=previous?.state==='error'?(previous.detail||previous.label):previous?.detail;
  if(detailText!==previousDetail)detail.textContent=detailText;detail.hidden=!detailText||p.state!=='error';
  if(p.label!==previous?.label||p.counter!==previous?.counter)bar.setAttribute('aria-label',`${p.label}${p.counter?' · 当前阶段 '+p.counter:''}`);
  if(!previous||p.fraction!==previous.fraction){if(p.fraction===null)bar.removeAttribute('value');else bar.value=p.fraction;}
  bar.hidden=p.state==='error'||p.state==='stopped';previous=p;tick();
 }
 const reset=()=>{stopClock();root.hidden=true;previous=undefined;started=undefined;ended=undefined;};
 return {update,reset,destroy:reset,finish:(label,detail='',state='complete')=>update({label,detail,state,completed:state==='complete'?1:undefined,total:state==='complete'?1:undefined})};
}
