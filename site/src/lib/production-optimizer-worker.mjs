import {optimizePractical} from './practical-optimizer.mjs';
import {optimizeInventory} from './inventory-optimizer.mjs';
import {createFormationWorkerPool} from './formation-worker-pool.mjs';
import {optimizeTeamPlanning} from './team-planning-optimizer.mjs';
let active;
self.addEventListener('message',async ({data})=>{
  if(data.type==='cancel'){active?.abort();return;}
  if(data.type!=='optimize')return;
  active?.abort();const controller=new AbortController();active=controller;
  const {requestId,payload}=data;let pool;
  const send=progress=>self.postMessage({requestId,type:'progress',progress});
  try {
    if(payload.planningScenario || payload.performanceScenario){const result=await optimizeTeamPlanning({...payload,signal:controller.signal,onProgress:send});self.postMessage({requestId,type:'result',result});return;}
    if(payload.searchMethod==='practical'){const result=await optimizePractical({...payload,signal:controller.signal,onProgress:send});self.postMessage({requestId,type:'result',result});return;}
    let size=Math.max(1,Math.min(4,Math.floor(payload.concurrency??1)));
    if(size>1 && payload.objective!=='formation_power'){
      try {pool=await createFormationWorkerPool({rules:payload.rules,chart:payload.chart,mode:payload.mode,
        objective:payload.objective,gekisouScenario:payload.gekisouScenario},size,{signal:controller.signal});}
      catch {size=1;send({phase:'fallback',message:'浏览器未能启动并行计算，已自动使用单个后台任务。'});}
    }else size=1;
    const result=await optimizeInventory({...payload,batchSize:size,evaluateBatch:pool?.evaluateBatch,signal:controller.signal,onProgress:send});
    self.postMessage({requestId,type:'result',result});
  }catch(error){self.postMessage({requestId,type:'error',error:String(error.message??error)});}
  finally {pool?.close();if(active===controller)active=null;}
});
