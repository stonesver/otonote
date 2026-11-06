import {createChallengeSearchSession} from './challenge-optimizer.mjs';
import {createCalculationScheduler} from './calculation-scheduler.mjs';
let session=null,running=false,paused=false,startedAt=0;
let yieldControl;
async function run(){
 if(running||!session)return;
 running=true;
 try{
  let lastPublished=0,lastBest=null;
  while(true){
   const result=await session.run();
   if(paused||result.status!=='budget_exhausted'){
    self.postMessage({type:'result',result});break;
   }
   const best=result.results[0]?.value;
   if(best!==lastBest||performance.now()-lastPublished>500){
    self.postMessage({type:'snapshot',result,elapsedMs:performance.now()-startedAt});lastBest=best;lastPublished=performance.now();
   }
   await yieldControl();
  }
 }catch(error){self.postMessage({type:'error',message:error.message});}
 finally{running=false;}
}
self.addEventListener('message',async({data})=>{
 if(data.type==='pause'){paused=true;return;}
 if(data.type==='resume'){paused=false;await run();return;}
 if(running)return;
 paused=false;
 try{
  const {analysisDataUrl,...input}=data;
  const response=await fetch(analysisDataUrl,{signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error(`谱面加载失败（${response.status}）`);
  const chart=await response.json();
  yieldControl=createCalculationScheduler();
  startedAt=performance.now();
  let lastProgress=0,lastStage='';
  session=createChallengeSearchSession({...input,chart,yieldControl,shouldPause:()=>paused,onProgress:p=>{
   const stage=p.phase==='event-exact'?'搜索并验证最佳配队':p.stage;
   if(!stage||stage===lastStage&&performance.now()-lastProgress<100)return;
   lastStage=stage;lastProgress=performance.now();
   self.postMessage({type:'progress',stage,phase:p.phase,completed:p.expanded??p.completed,total:p.total,
    expanded:p.expanded,evaluated:p.completed,frontier:p.frontier,elapsedMs:performance.now()-startedAt});
  }});
  await run();
 }catch(error){self.postMessage({type:'error',message:error.message});}
});
