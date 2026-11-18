import {chartKey} from './calculation-scope.mjs';
import {screenTeamSongs} from './song-shortlist.mjs';
import {runPlaylistTeamBatch} from './playlist-team-batch.mjs';
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
    if(payload.playlistCandidates){
      let screening=null,charts;
      if(payload.songShortlist&&payload.playlistCandidates.length>6)({charts,...screening}=await screenTeamSongs({candidates:payload.playlistCandidates,payload,signal:controller.signal,onProgress:send}));
      const candidates=screening?.selected??payload.playlistCandidates;
      const annotate=result=>{
        if(!payload.songShortlist)return result;
        const score=row=>Math.max(...row.result.results.map(team=>team.value));
        const rows=[...result.rows].sort((a,b)=>score(b)-score(a));
        const sorted={...result,rows,results:rows.flatMap(row=>row.result.results)};
        return screening?{...sorted,screening,selectedCoverageComplete:result.coverageComplete,
          coverageComplete:result.coverageComplete&&screening.coverageComplete&&candidates.length===screening.total}:sorted;
      };
      const result=candidates.length?await runPlaylistTeamBatch({candidates,payload,signal:controller.signal,onProgress:send,
        ...(charts?{loadChart:async candidate=>charts.get(chartKey(candidate))}:{}),
        onPartial:result=>self.postMessage({requestId,type:'playlist-partial',result:annotate(result)})})
        :{kind:'playlist-team-batch',status:controller.signal.aborted?'cancelled':'completed',rows:[],failures:[],results:[],done:0,total:0,
          coverageComplete:false,optimality:'per_chart_results_only',calculationScope:payload.calculationScope};
      self.postMessage({requestId,type:'result',result:annotate(result)});return;
    }
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
