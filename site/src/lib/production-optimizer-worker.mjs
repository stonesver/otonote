import {runPlaylistTeamBatch} from './playlist-team-batch.mjs';
import {optimizePractical} from './practical-optimizer.mjs';
import {optimizeInventory} from './inventory-optimizer.mjs';
import {createFormationWorkerPool} from './formation-worker-pool.mjs';
import {optimizeTeamPlanning} from './team-planning-optimizer.mjs';
import {createEventSearchStore,searchDigest} from './event-search-cache.mjs';
import {SCORE_MODEL_VERSION} from './scoring-rules/model-version.mjs';
import {createCalculationScheduler} from './calculation-scheduler.mjs';
const resultStore=createEventSearchStore();
let active;
self.addEventListener('message',async ({data})=>{
  if(data.type==='cancel'){active?.abort();return;}
  if(data.type!=='optimize')return;
  active?.abort();const controller=new AbortController();active=controller;
  const {requestId,payload}=data;let pool,lastStage,nextProgress=0;
  const yieldControl=createCalculationScheduler();
  const send=progress=>{
    const stage=progress.phase+':'+progress.stage,now=performance.now();
    if(!progress.bestCandidate&&stage===lastStage&&now<nextProgress&&progress.completed!==progress.total)return;
    lastStage=stage;nextProgress=now+120;self.postMessage({requestId,type:'progress',progress});
  };
  try {
    if(payload.playlistCandidates){const result=await runPlaylistTeamBatch({candidates:payload.playlistCandidates,payload,signal:controller.signal,onProgress:send,onPartial:result=>self.postMessage({requestId,type:'playlist-partial',result})});self.postMessage({requestId,type:'result',result});return;}
    if(payload.planningScenario || payload.performanceScenario){
      // Exact-request cache, including rules, chart, growth, constraints and
      // sampling settings. Bump the namespace when planning semantics change.
      const key='planning-result-v1:'+await searchDigest({model:SCORE_MODEL_VERSION,payload});
      const cached=await resultStore.get(key);
      if(controller.signal.aborted)return;
      const result=cached??await optimizeTeamPlanning({...payload,signal:controller.signal,onProgress:send,yieldControl});
      if(!cached&&result.status==='completed')await resultStore.put(key,result);
      if(!controller.signal.aborted)self.postMessage({requestId,type:'result',result});return;
    }
    if(payload.searchMethod==='practical'){const result=await optimizePractical({...payload,signal:controller.signal,onProgress:send,yieldControl});self.postMessage({requestId,type:'result',result});return;}
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
