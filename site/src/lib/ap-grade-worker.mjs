import {estimateAPChart} from './ap-grade.mjs';
import {createCalculationScheduler} from './calculation-scheduler.mjs';
self.addEventListener('message',async({data})=>{
 const {rules,draft,candidates,mode,eventId,eco}=data,rows=[],failures=[];
 const yieldControl=createCalculationScheduler({eco:eco===true});let next=0,done=0;
 try{
  await Promise.all(Array.from({length:Math.min(4,candidates.length)},async()=>{
   while(next<candidates.length){
    const c=candidates[next++];
    try{
     const response=await fetch(c.analysisDataUrl,{signal:AbortSignal.timeout(30000)});
     if(!response.ok)throw Error(`谱面加载失败（${response.status}）`);
     const chart=await response.json();await yieldControl();
     rows.push(estimateAPChart({rules,draft,chart,candidate:c,mode,eventId}));await yieldControl();
    }catch(error){failures.push({title:c.title,difficulty:c.difficulty,message:error.message});}
    self.postMessage({type:'progress',done:++done,total:candidates.length});
   }
  }));
  self.postMessage({type:'result',rows,failures});
 }catch(error){self.postMessage({type:'error',message:error.message});}
});
