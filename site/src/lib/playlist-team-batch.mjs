import {optimizeTeamPlanning} from './team-planning-optimizer.mjs';
import {optimizePractical} from './practical-optimizer.mjs';
import {chartKey} from './calculation-scope.mjs';

/** Sequential chart jobs share the user's inputs, never their chosen teams.
 * There is no joint-team objective or additional top-K song prefilter. */
export async function runPlaylistTeamBatch({candidates,payload,signal,onProgress=()=>{},onPartial=()=>{},
  loadChart=async c=>{const r=await fetch(c.analysisDataUrl,{signal});if(!r.ok)throw Error('谱面加载失败');return r.json();},
  optimize=options=>options.planningScenario||options.performanceScenario?optimizeTeamPlanning(options):optimizePractical(options)}) {
  if(!Array.isArray(candidates)||!candidates.length)throw Error('计算范围为空');
  const keys=candidates.map(chartKey);if(new Set(keys).size!==keys.length)throw Error('计算范围包含重复谱面');
  const rows=[],failures=[];let stopped=false;
  const snapshot=()=>({kind:'playlist-team-batch',status:stopped||signal?.aborted?'cancelled':rows.length+failures.length===candidates.length?'completed':'running',
    rows:[...rows],failures:[...failures],total:candidates.length,done:rows.length+failures.length,results:rows.flatMap(r=>r.result.results),
    coverageComplete:!stopped&&!signal?.aborted&&!failures.length&&rows.length===candidates.length&&rows.every(r=>r.result.scoringCoverage?.complete!==false),
    optimality:'per_chart_results_only',calculationScope:payload.calculationScope});
  for(const candidate of candidates){
    if(signal?.aborted){stopped=true;break;}
    try{
      const chart=payload.objective==='formation_power'?undefined:{...candidate,...await loadChart(candidate),sourceReleaseId:payload.rules.sourceReleaseId};
      if(signal?.aborted){stopped=true;break;}
      const draft={...structuredClone(payload.draft),selectedSongId:candidate.trackId,selectedDifficulty:candidate.difficulty};
      const result=await optimize({...payload,draft,chart,concurrency:1,signal,onProgress:p=>onProgress({...p,chartTitle:candidate.title,chartDone:rows.length+failures.length,chartTotal:candidates.length})});
      if(signal?.aborted||result.status==='cancelled'){stopped=true;break;}
      rows.push({candidate,result});onPartial(snapshot());
    }catch(error){if(signal?.aborted){stopped=true;break;}failures.push({id:candidate.id,trackId:candidate.trackId,difficulty:candidate.difficulty,title:candidate.title,message:String(error.message??error)});onPartial(snapshot());}
  }
  return snapshot();
}
