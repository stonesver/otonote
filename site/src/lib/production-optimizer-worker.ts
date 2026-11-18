import {chartKey} from './calculation-scope.mjs';
import {screenTeamSongs} from './song-shortlist.mjs';
import type {OptimizerCommand, OptimizerMessage, OptimizerProgress, OptimizerReport, PlaylistReport} from './calculation/optimizer-types.ts';
import {runPlaylistTeamBatch} from './playlist-team-batch.ts';
import {optimizePractical} from './practical-optimizer.mjs';
import {optimizeInventory} from './inventory-optimizer.mjs';
import {createFormationWorkerPool} from './formation-worker-pool.mjs';
import {optimizeTeamPlanning} from './team-planning-optimizer.ts';
import {createEventSearchStore,searchDigest} from './event-search-cache.mjs';
import {SCORE_MODEL_VERSION} from './scoring-rules/model-version.mjs';
import {createCalculationScheduler} from './calculation-scheduler.mjs';
const resultStore=createEventSearchStore();
let active: AbortController | null;
const post = (message: OptimizerMessage) => self.postMessage(message);
self.addEventListener('message',async ({data}: MessageEvent<OptimizerCommand>)=>{
  if(data.type==='cancel'){active?.abort();return;}
  if(data.type!=='optimize')return;
  active?.abort();const controller=new AbortController();active=controller;
  const {requestId,payload}=data;let pool: Awaited<ReturnType<typeof createFormationWorkerPool>> | undefined, lastStage: string | undefined, nextProgress=0;
  const yieldControl=createCalculationScheduler();
  const send=(progress: OptimizerProgress)=>{
    const stage=progress.phase+':'+progress.stage,now=performance.now();
    if(!progress.bestCandidate&&stage===lastStage&&now<nextProgress&&progress.completed!==progress.total)return;
    lastStage=stage;nextProgress=now+120;post({requestId,type:'progress',progress});
  };
  try {
    if(payload.playlistCandidates){
      let screening: PlaylistReport['screening'] = undefined,charts: Map<string, import('./calculation/optimizer-types.ts').ChartData> | undefined;
      if(payload.songShortlist&&payload.playlistCandidates.length>6)({charts,...screening}=await screenTeamSongs({candidates:payload.playlistCandidates,payload,signal:controller.signal,onProgress:send}));
      const candidates=screening?.selected??payload.playlistCandidates;
      const annotate=(result: PlaylistReport): PlaylistReport=>{
        if(!payload.songShortlist)return result;
        const score=(row: PlaylistReport['rows'][number])=>Math.max(...row.result.results.map(team=>team.value));
        const rows=[...result.rows].sort((a,b)=>score(b)-score(a));
        const sorted={...result,rows,results:rows.flatMap(row=>row.result.results)};
        return screening?{...sorted,screening,selectedCoverageComplete:result.coverageComplete,
          coverageComplete:result.coverageComplete&&screening.coverageComplete&&candidates.length===screening.total}:sorted;
      };
      const result: PlaylistReport=candidates.length?await runPlaylistTeamBatch({candidates,payload,signal:controller.signal,onProgress:send,
        ...(charts?{loadChart:async candidate=>charts!.get(chartKey(candidate))!}:{}),
        onPartial:result=>post({requestId,type:'playlist-partial',result:annotate(result)})})
        :{kind:'playlist-team-batch',status:controller.signal.aborted?'cancelled':'completed',rows:[],failures:[],results:[],done:0,total:0,
          coverageComplete:false,optimality:'per_chart_results_only',calculationScope:payload.calculationScope};
      post({requestId,type:'result',result:annotate(result)});return;
    }
    if(payload.planningScenario || payload.performanceScenario){
      // Exact-request cache, including rules, chart, growth, constraints and
      // sampling settings. Bump the namespace when planning semantics change.
      const key='planning-result-v2:'+await searchDigest({model:SCORE_MODEL_VERSION,payload});
      // This namespace only stores completed planning reports from this worker.
      const cached=await resultStore.get(key) as OptimizerReport | null;
      if(active!==controller)return;
      const result=cached??await optimizeTeamPlanning({...payload,signal:controller.signal,onProgress:send,yieldControl});
      if(!cached&&!controller.signal.aborted&&result.status==='completed')await resultStore.put(key,result);
      // Cancellation settles the current UI with fully scored candidates. A
      // replacement request owns the UI; late work from its predecessor is ignored.
      if(active===controller)post({requestId,type:'result',result:controller.signal.aborted
        ? {...result,status:'cancelled',optimality:'incomplete'} : result});return;
    }
    if(payload.searchMethod==='practical'){const result=await optimizePractical({...payload,signal:controller.signal,onProgress:send,yieldControl});post({requestId,type:'result',result});return;}
    let size=Math.max(1,Math.min(4,Math.floor(payload.concurrency??1)));
    if(size>1 && payload.objective!=='formation_power'){
      try {pool=await createFormationWorkerPool({rules:payload.rules,chart:payload.chart,mode:payload.mode,
        objective:payload.objective,gekisouScenario:payload.gekisouScenario},size,{signal:controller.signal});}
      catch {size=1;send({phase:'fallback',message:'浏览器未能启动并行计算，已自动使用单个后台任务。'});}
    }else size=1;
    const result=await optimizeInventory({...payload,batchSize:size,evaluateBatch:pool?.evaluateBatch,signal:controller.signal,onProgress:send});
    post({requestId,type:'result',result});
  }catch(error){post({requestId,type:'error',error:String(error instanceof Error ? error.message : error)});}
  finally {pool?.close();if(active===controller)active=null;}
});
