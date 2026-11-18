import type {ChartCandidate, ChartData, OptimizerOptions, OptimizerProgress, OptimizerReport, OptimizerRequest, PlaylistReport} from './calculation/optimizer-types.ts';
import {optimizeTeamPlanning} from './team-planning-optimizer.ts';
import {optimizePractical} from './practical-optimizer.mjs';
import {chartKey} from './calculation-scope.mjs';
import {createCalculationWorkerPool} from './calculation-worker-pool.mjs';

const optimizeChart=(options: OptimizerOptions): Promise<OptimizerReport>=>options.planningScenario||options.performanceScenario?optimizeTeamPlanning(options):optimizePractical(options);
const browserWorker=typeof Worker==='function'?()=>new Worker(new URL('./playlist-team-task-worker.mjs',import.meta.url),{type:'module'}):null;

interface PlaylistOptions {
  candidates: ChartCandidate[]; payload: OptimizerRequest; signal?: AbortSignal;
  onProgress?: (progress: OptimizerProgress) => void; onPartial?: (result: PlaylistReport) => void;
  loadChart?: (candidate: ChartCandidate) => Promise<ChartData>;
  optimize?: (options: OptimizerOptions) => Promise<OptimizerReport>;
  createWorker?: (() => Worker) | null; concurrency?: number;
}
/** Each chart retains its own search and scoring context. At most two chart
 * workers run; inner optimization stays single-threaded. No joint objective. */
export async function runPlaylistTeamBatch({candidates,payload,signal,onProgress=()=>{},onPartial=()=>{},
  loadChart=async c=>{const r=await fetch(c.analysisDataUrl,{signal});if(!r.ok)throw Error('谱面加载失败');return r.json();},
  optimize=optimizeChart,createWorker=browserWorker,concurrency=payload.concurrency??1}: PlaylistOptions): Promise<PlaylistReport> {
  if(!Array.isArray(candidates)||!candidates.length)throw Error('计算范围为空');
  const keys=candidates.map(chartKey);if(new Set(keys).size!==keys.length)throw Error('计算范围包含重复谱面');
  const rows: PlaylistReport['rows']=[],failures: PlaylistReport['failures']=[],retry: {index: number; options?: OptimizerOptions}[]=[];let stopped=false,next=0,workerFailed=false;
  const size=createWorker?Math.max(1,Math.min(2,Math.floor(concurrency)||1,candidates.length)):1;
  // Long Gekisou replays slow down when successive charts share a worker.
  // Release each completed chart's runtime while retaining the two-job cap.
  const pool=size>1?createCalculationWorkerPool({size,createWorker,reuseWorkers:payload.mode!=='gekisou'}):null;
  const snapshot=(): PlaylistReport=>{
    const completed=rows.filter(Boolean),failed=failures.filter(Boolean);
    return {kind:'playlist-team-batch',status:stopped||signal?.aborted?'cancelled':completed.length+failed.length===candidates.length?'completed':'running',
      rows:completed,failures:failed,total:candidates.length,done:completed.length+failed.length,results:completed.flatMap(r=>r.result.results),
      coverageComplete:!stopped&&!signal?.aborted&&!failed.length&&completed.length===candidates.length&&completed.every(r=>r.result.scoringCoverage?.complete!==false),
      optimality:'per_chart_results_only',calculationScope:payload.calculationScope};
  };
  const progress=(index: number)=>(p: OptimizerProgress)=>{
    if(stopped||signal?.aborted)return;
    onProgress({...p,chartTitle:candidates[index].title,chartDone:rows.filter(Boolean).length+failures.filter(Boolean).length,chartTotal:candidates.length});
  };
  const cancelled=()=>stopped||signal?.aborted;
  const abort=()=>{stopped=true;pool?.close();};
  signal?.addEventListener('abort',abort,{once:true});
  const fail=(index: number,error: unknown)=>{
    const c=candidates[index];
    failures[index]={id:c.id,trackId:c.trackId,difficulty:c.difficulty,title:c.title,message:String(error instanceof Error ? error.message : error)};
    onPartial(snapshot());
  };
  const finish=(index: number,result: OptimizerReport)=>{
    if(cancelled())return;
    if(result.status==='cancelled'){abort();return;}
    rows[index]={candidate:candidates[index],result};onPartial(snapshot());
  };
  // Do not copy the entire playlist into every worker task. Load at most one
  // chart per occupied slot; the pool queues neither charts nor extra searches.
  const {playlistCandidates:_playlist,chart:_chart,calculationScope:_scope,...jobPayload}=payload;
  async function prepare(index: number): Promise<OptimizerOptions>{
    const candidate=candidates[index];
    const chart=payload.objective==='formation_power'?undefined:{...candidate,...await loadChart(candidate),sourceReleaseId:payload.rules.sourceReleaseId};
    const draft={...structuredClone(payload.draft),selectedSongId:candidate.trackId,selectedDifficulty:candidate.difficulty};
    return {...jobPayload,draft,chart,concurrency:1};
  }
  async function serial(index: number,options?: OptimizerOptions){
    try{options??=await prepare(index);if(cancelled())return;
      finish(index,await optimize({...options,signal,onProgress:progress(index)}));
    }catch(error){if(!cancelled())fail(index,error);}
  }
  try{
    if(pool){
      await Promise.all(Array.from({length:size},async()=>{
        while(next<candidates.length&&!cancelled()&&!workerFailed){
          const index=next++;let options;
          try{options=await prepare(index);}catch(error){if(!cancelled())fail(index,error);continue;}
          if(cancelled())return;
          if(workerFailed){retry.push({index,options});return;}
          try{finish(index,await pool.run(options,progress(index)) as OptimizerReport);}
          catch(error){if(cancelled())return;workerFailed=true;retry.push({index,options});pool.close(error instanceof Error ? error : new Error(String(error)));}
        }
      }));
      if(workerFailed&&!cancelled()){
        onProgress({phase:'fallback',message:'浏览器未能启动并行计算，已自动使用单个后台任务。'});
        for(const {index,options} of retry.sort((a,b)=>a.index-b.index)){if(cancelled())break;await serial(index,options);}
      }
    }
    while(next<candidates.length&&!cancelled())await serial(next++);
    return snapshot();
  }finally{signal?.removeEventListener('abort',abort);pool?.close();}
}
