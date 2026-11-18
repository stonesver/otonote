import {chartKey} from './calculation-scope.mjs';
import {resolveGrowthScenario,createGrowthSearchVariants} from './scoring-rules/growth-scenarios.mjs';
import {normalizePerformanceScenario} from '../../../packages/scoring/scoring-rules/performance-scenarios.mjs';
import {preparePracticalSongSeeds} from './practical-optimizer.mjs';
import {createCandidateEvaluator} from './formation-candidate-evaluator.mjs';
import {createCalculationScheduler} from './calculation-scheduler.mjs';
import {skillMechanismIssue} from '../../../packages/scoring/scoring-rules/skill-mechanism-error.mjs';

const descending=(a,b)=>b.value-a.value||a.index-b.index;
/** Keep leaders from both the wide first pass and the more sampled recheck.
 * These are suggestions, not upper-bound pruning or a global-best guarantee. */
export function selectSongShortlist(rows,limit=6) {
  const first=[...rows].sort(descending),verified=[...rows].filter(r=>Number.isFinite(r.verifiedValue))
    .sort((a,b)=>b.verifiedValue-a.verifiedValue||descending(a,b));
  const selected=new Map(),take=row=>{if(row&&selected.size<limit)selected.set(row.index,row);};
  const reserve=Math.ceil(limit/2);
  first.slice(0,reserve).forEach(take);verified.slice(0,limit-reserve).forEach(take);
  verified.forEach(take);first.forEach(take);
  return [...selected.values()].sort(descending);
}

/** Current-growth song suggestions. Full team optimization follows separately;
 * failures and incomplete skill coverage stay visible in the screening report.
 * @param {{candidates: import('./calculation/optimizer-types.ts').ChartCandidate[], payload: import('./calculation/optimizer-types.ts').OptimizerRequest, limit?: number, signal?: AbortSignal, onProgress?: (progress: import('./calculation/optimizer-types.ts').OptimizerProgress) => void, yieldControl?: () => Promise<void>, loadChart?: (candidate: import('./calculation/optimizer-types.ts').ChartCandidate) => Promise<import('./calculation/optimizer-types.ts').ChartData>}} options
 */
export async function screenTeamSongs({candidates,payload,limit=6,signal,onProgress=()=>{},yieldControl=createCalculationScheduler(),
  loadChart=async candidate=>{const response=await fetch(candidate.analysisDataUrl,{signal});if(!response.ok)throw Error('谱面加载失败');return response.json();}}) {
  const {rules,mode,objective}=payload;
  if(mode!=='gekisou'||objective!=='expected_song_score')throw Error('卡池选歌目前用于激奏平均分比较。');
  const resolved=resolveGrowthScenario(rules,payload.draft,{...(payload.planningScenario??{scope:payload.scope==='theoretical'?'reference':payload.scope??'selected'}),inventory:payload.inventory});
  if(resolved.plan.enabled)throw Error('卡池选歌按当前养成筛选，请先关闭培养计划；培养比较可使用歌单逐曲。');
  const player=normalizePerformanceScenario(payload.performanceScenario??{profile:'steady'});
  if(player.profile==='explicit')throw Error('明确操作只适用于对应谱面，卡池选歌请使用发挥预设。');
  const variant=[...createGrowthSearchVariants(resolved,{limit:1})][0],pairCache=new Map();
  const rows=[],failures=[];let done=0;
  const cancelled=()=>Boolean(signal?.aborted);
  /** @returns {NonNullable<import('./calculation/optimizer-types.ts').PlaylistReport['screening']> & {charts: Map<string, import('./calculation/optimizer-types.ts').ChartData>, rows: typeof rows, method: string, limit: number, screenOrders: number, screenPlayerSamples: number, verificationPlayerSamples: number}} */
  const snapshot=()=>({charts:cancelled()?new Map():new Map(selectSongShortlist(rows,limit).map(row=>[chartKey(row.candidate),recheck.get(row.index).chart])),
    status:cancelled()?'cancelled':'completed',total:candidates.length,done,rows,
    selected:cancelled()?[]:selectSongShortlist(rows,limit).map(r=>r.candidate),failures,
    coverageComplete:!cancelled()&&!failures.length&&done===candidates.length&&rows.every(r=>r.complete),
    method:'card_pool_seed_screen',limit,screenOrders:10,screenPlayerSamples:1,
    verificationPlayerSamples:Math.max(2,Math.min(3,player.samples)),globalBestGuaranteed:false});
  async function scoreSeeds(chart,draft,seeds,performanceScenario,gekisouScenario){
    const evaluator=createCandidateEvaluator({rules,chart,mode,objective,performanceScenario,gekisouScenario,scorePrecision:'screen'}),scores=[];
    for(const seed of seeds){
      if(cancelled())break;
      try{scores.push({...seed,value:evaluator.score({...draft,slots:seed.slots}).value});}
      catch(error){skillMechanismIssue(error);return null;}
      await yieldControl();
    }
    return scores.sort(descending);
  }
  // Only the leading recheck candidates retain charts and seed drafts.
  const recheck=new Map(),poolLimit=limit*2;
  for(const [index,candidate] of candidates.entries()){
    if(cancelled())break;
    onProgress({phase:'song-screen',chartDone:done,chartTotal:candidates.length,chartTitle:candidate.title,message:'按卡池快速比较歌曲'});
    if(cancelled())break;
    try{
      const chart={...candidate,...await loadChart(candidate),sourceReleaseId:rules.sourceReleaseId};
      if(cancelled())break;
      const draft={...variant.draft,selectedSongId:candidate.trackId,selectedDifficulty:candidate.difficulty};
      // The cache is owned by this call: growth, inventory, rules and constraints
      // are fixed; compilePairingModels reapplies each song's type/tag bonus.
      const prepared=await preparePracticalSongSeeds({...payload,draft,inventory:variant.inventory,performanceScenario:player,pairCache,pairCacheKey:'song-screen',signal,yieldControl});
      if(cancelled())break;
      const scores=await scoreSeeds(chart,prepared.draft,prepared.rows,{...player,samples:1},{...payload.gekisouScenario,batches:1});
      if(cancelled())break;
      if(!scores?.length)throw Error('当前卡池没有可用于筛歌的完整计分队伍。');
      const row={index,candidate,value:scores[0].value,complete:prepared.complete};rows.push(row);
      recheck.set(index,{row,chart,draft:prepared.draft,seeds:scores.slice(0,2)});
      // Maintain a bounded leading set instead of re-sorting the growing catalog.
      for(const [key] of [...recheck].sort(([,a],[,b])=>descending(a.row,b.row)).slice(poolLimit))recheck.delete(key);
    }catch(error){if(!cancelled())failures.push({candidate,message:String(error.message??error)});}
    if(cancelled())break;
    done++;await yieldControl();
  }
  if(cancelled())return snapshot();
  const leaders=[...rows].sort(descending).slice(0,poolLimit);
  for(const [index,row] of leaders.entries()){
    if(cancelled())break;
    onProgress({phase:'song-recheck',chartDone:index,chartTotal:leaders.length,chartTitle:row.candidate.title,message:'复核领先歌曲的发挥与 LUCK 抽样'});
    if(cancelled())break;
    const {chart,draft,seeds}=recheck.get(row.index);
    const scores=await scoreSeeds(chart,draft,seeds,{...player,samples:Math.max(2,Math.min(3,player.samples)),seed:(player.seed+1)>>>0},
      {...payload.gekisouScenario,batches:1,seed:((payload.gekisouScenario?.seed??20260927)+1)>>>0});
    if(scores?.length)row.verifiedValue=scores[0].value;else row.complete=false;
  }
  return snapshot();
}
