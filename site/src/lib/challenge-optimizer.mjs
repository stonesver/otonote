import {optimizePractical,PRACTICAL_SEARCH_WARNINGS} from './practical-optimizer.mjs';
import {withEventRewardCandidates} from './event-reward-candidates.mjs';
import {createEventEfficiency} from './scoring-rules/event-efficiency.mjs';
import {searchEventFormations} from './event-formation-search.mjs';

/** Challenge scoring and its certified bound share the event power/song context. */
export async function optimizeChallenge({rules,eventId,draft,chart,scope='owned',inventory,constraints={},
 objective='maximum_song_score',signal,onProgress,yieldControl,searchMethod='certified',maxEvaluations=24,rewardCards=[],rewardGrowth='level',rewardGrowthOverride=false,
 shouldPause,onContinuation}) {
 if(!['practical','certified'].includes(searchMethod))throw Error('Invalid challenge search method');
  if(!['owned','selected','reference'].includes(scope))throw Error('请选择全卡库参考、已保存卡库或当前十张卡');
  if(!['maximum_song_score','expected_song_score'].includes(objective))throw Error('无效的挑战出分目标');
  ({draft,scope,inventory}=withEventRewardCandidates({rules,draft,scope,inventory,rewardCards,rewardGrowth,rewardGrowthOverride}));
  const model=createEventEfficiency({tables:rules.tables,sourceReleaseId:rules.sourceReleaseId,eventId});
  if(!rules.tables.ChallengeMusic.some(r=>r._eventId===eventId&&`music-${r._liveMusicId}`===draft.selectedSongId))throw Error('请先选择本期挑战歌曲');
  const next=structuredClone(draft);
  next.modifiers??={};
  next.modifiers.event={id:eventId,sourceReleaseId:rules.sourceReleaseId};
  if(scope==='owned') {
    if(!inventory)throw Error('请先导入并保存实际卡库与养成');
    const growth=structuredClone(inventory.growth??{});
    for(const [id,value] of Object.entries(next.modifiers.growth??{}))growth[id]={...growth[id],...value};
    next.modifiers.growth=growth;
  }
  const eventAdapters=[model.challengeAdapter(rules)],modelCache={},scoreCache=new Map();
  const finalize=result=>scope==='reference'
    ? {...result,mode:'challenge',eventId,baseline:null,baselineResult:null,
      results:result.results.map(row=>({...row,delta:null,comparison:null}))}
    : {...result,mode:'challenge',eventId};
  const result=await optimizePractical({rules,draft:next,chart,scope,inventory,constraints,objective,performanceScenario:next.modifiers.performanceScenario,
    eventAdapters,modelCache,scoreCache,signal,onProgress,yieldControl});
 if(searchMethod==='practical'||signal?.aborted||result.scoringCoverage?.complete===false)return finalize(result);
 let resumeExact;
 const exact=await searchEventFormations({rules,draft:next,chart,scope,inventory,constraints,objective,
   eventAdapters,modelCache,seeds:result.results,maxEvaluations,signal,onProgress,yieldControl,baselineResult:result.baselineResult,
   scoreCache,scoreCounters:result.practical,proofCount:1,scoreBoundOptions:{jointPowerBound:true},partitionCards:true,shouldPause,
   onContinuation:resume=>{resumeExact=resume;}});
 const combine=exact=>{
  const {results:exactResults,...certificate}=exact;
  return finalize({...result,results:exactResults,evaluated:result.evaluated+exact.evaluated,optimality:exact.optimality,
    warnings:exact.searchStatus==='player_scenario_bound_unavailable'?result.warnings:
      [...result.warnings.filter(w=>!PRACTICAL_SEARCH_WARNINGS.includes(w)),
        '先生成实用候选，再以完整配对分区和上界搜索；只有精确阶段完成后才证明当前模型内的最优，预算耗尽仍可能改进。'],
    searchMethod:exact.searchStatus==='player_scenario_bound_unavailable'?'practical':'certified',
    certifiedSearch:{...certificate,scope:'team_for_chart'},status:exact.searchStatus==='player_scenario_bound_unavailable'?result.status:exact.searchStatus,
    mode:'challenge',eventId});
 };
 if(resumeExact)onContinuation?.(async()=>combine(await resumeExact()));
 return combine(exact);
}

/** A job owns its immutable inputs and live frontier. Only run() is exposed;
 * a caller cannot accidentally resume old bounds with new account settings. */
export function createChallengeSearchSession(input){
 const options=structuredClone(Object.fromEntries(Object.entries(input).filter(([,v])=>typeof v!=='function' && !(v instanceof AbortSignal))));
 for(const [key,value] of Object.entries(input))if(typeof value==='function'||value instanceof AbortSignal)options[key]=value;
 let resume=null,busy=false;
 return {async run(){
   if(busy)throw Error('Challenge search already running');
   busy=true;
   try{return structuredClone(await (resume?resume():optimizeChallenge({...options,onContinuation:next=>{resume=next;}})));}
   finally{busy=false;}
 }};
}
