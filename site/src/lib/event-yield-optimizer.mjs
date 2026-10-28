import {bindEventScoreCache,searchDigest} from './event-search-cache.mjs';
import {optimizePractical,PRACTICAL_SEARCH_WARNINGS} from './practical-optimizer.mjs';
import {createEventEfficiency,createChallengeSpendingPlanner} from './scoring-rules/event-efficiency.mjs';
import {searchEventFormations} from './event-formation-search.mjs';
import {resolveSearchInput} from './scoring-rules/formation-input.mjs';
import {maximumPairing,partitionPairing} from './scoring-rules/maximum-pairing.mjs';
import {compilePairingModels,draftFromPairing} from './inventory-optimizer.mjs';
import {createCandidateEvaluator} from './formation-candidate-evaluator.mjs';
import {skillMechanismIssue} from '../../../packages/scoring/scoring-rules/skill-mechanism-error.mjs';
import {createFormalSongCalculator} from './scoring-rules/formal-song-score.mjs';
import {createFormalSkillResolver} from './scoring-rules/formal-skills.mjs';
import {createOrdinaryScoreBound} from '../../../packages/scoring/scoring-rules/ordinary-score-bound.mjs';
import {withEventRewardCandidates} from './event-reward-candidates.mjs';

import {eventGradeEstimate} from './event-song-ranking.mjs';
import {createEventPipeline} from './scoring-rules/event-rules.mjs';
import {compareEventPlans} from './event-yield-goals.mjs';
export {compareEventPlans} from './event-yield-goals.mjs';

// This cache belongs to one calculation job. Music identity/difficulty affects
// scoring, but candidate preparation only reads effective type and favorite tags.
// Keep all other inputs in the key so growth, inventory or event changes miss.
export function eventCandidateKey(rules,draft,inventory,scope,eventAdapters,includeMusic=true,constraints={}){
 const music=createEventPipeline(rules,draft.modifiers.event,eventAdapters).apply('song_context',
   rules.tables.LiveMusic.find(m=>`music-${m._id}`===draft.selectedSongId),{draft});
 if(!music)throw Error('缺少歌曲资料');
 return JSON.stringify({source:rules.sourceReleaseId,version:rules.ruleSetVersion,native:rules.nativeSha256,
   scope,inventory,constraints,slots:draft.slots,modifiers:draft.modifiers,...(includeMusic?{type:music._musicType,tags:music._bestMusicTagIDs}:{})});
}

/** Choose the best evaluated challenge team/song for each consumption tier,
 * then spend only whole plays. The same chosen objective applies to both stages. */
export function challengeContinuation(model,rows,availableCP,metric='badges'){
 return createChallengeContinuationPlanner(model,rows,metric)(availableCP);
}
export function createChallengeContinuationPlanner(model,rows,metric='badges'){
 if(!rows.length)throw Error('缺少可计算的后续挑战方案');
 const secondary=metric==='badges'?'eventPoints':'badges';
 const picks=modelChallengeCosts(model,rows).map(cost=>{
   const options=rows.map(row=>({row,reward:model.rewards({mode:'challenge',scoreRank:row.reward.scoreRank,...row.bonuses,challengeCost:cost})}));
   options.sort((a,b)=>b.reward[metric]-a.reward[metric]||b.reward[secondary]-a.reward[secondary]||(a.row.song.seconds??Infinity)-(b.row.song.seconds??Infinity));
   return options[0];
 });
 const query=createChallengeSpendingPlanner(picks.map(p=>p.reward),metric);
 return availableCP=>{const plan=query(availableCP);return {...plan,stages:plan.consumption.map(c=>({...c,...picks.find(p=>p.reward.challengeCost===c.cost)}))};};
}
// Costs are supplied by the caller's rules, not invented from reward ratios.
function modelChallengeCosts(model,rows){return model.challengeCosts??[...new Set(rows.map(r=>r.reward.challengeCost))];}

export function createEventYieldRewardTransform({model,candidate,basis,mode,liveBoost,challengeCost,budget,startingCP,includeChallenge,metric,continuationFor}){
 const plans=new Map();
 return (score,team)=>{
   const bonuses=model.teamBonus(team.slots.map(s=>({memberId:Number(s.memberCardId.split('-').at(-1)),supportId:Number(s.supportCardId.split('-').at(-1)),
     memberRank:team.modifiers.growth?.[s.memberCardId]?.rank??1,supportRank:team.modifiers.growth?.[s.supportCardId]?.rank??1})));
   const grades=eventGradeEstimate(model,Number(candidate.trackId.split('-').at(-1)),score,basis);
   const reward=model.rewards({mode,...bonuses,scoreRank:grades.scoreRank,liveBoost:mode==='ordinary'?liveBoost:0,challengeCost});
   let continuation=null,plays=mode==='ordinary'?Math.floor(budget/liveBoost):1;
   if(mode==='ordinary'&&includeChallenge){
     const cp=startingCP+plays*reward.challengePoints;
     if(!plans.has(cp))plans.set(cp,continuationFor(cp,metric));
     continuation=plans.get(cp);
   }
   const total={badges:plays*reward.badges+(continuation?.badges??0),eventPoints:plays*reward.eventPoints+(continuation?.eventPoints??0)};
   return {...score,...grades,reward,bonuses:{rewardBP:bonuses.rewardBP,eventPointBP:bonuses.eventPointBP},normalPlays:plays,
     spentFire:mode==='ordinary'?plays*liveBoost:0,remainingFire:mode==='ordinary'?budget-plays*liveBoost:0,
     earnedCP:mode==='ordinary'?plays*reward.challengePoints:0,startingCP,continuation,total,value:total[metric],song:candidate};
 };
}

export async function optimizeEventYield({rules,eventId,draft,chart,candidate,scope='owned',inventory,constraints={},mode='ordinary',
 liveBoost=1,challengeCost=200,budget=100,startingCP=0,goal='badges',basis='expectedScore',challengeRows=[],includeChallenge=true,
 onProgress,yieldControl=async()=>{},signal,candidateCache,scoreCache,challengePlanCache,
 searchMethod='certified',maxEvaluations=24,refineScoreTies=false,witnessOnly=false,rewardCards=[],rewardGrowth='level',rewardGrowthOverride=false}){
 if(!['practical','certified'].includes(searchMethod))throw Error('Invalid event search method');
 if(!Number.isInteger(maxEvaluations)||maxEvaluations<0)throw Error('Invalid event search budget');
 if(typeof refineScoreTies!=='boolean')throw Error('Invalid score tie refinement option');
 if(typeof witnessOnly!=='boolean'||witnessOnly&&(searchMethod!=='certified'||refineScoreTies||draft.modifiers?.performanceScenario))throw Error('Invalid reward witness option');
 if(!['ordinary','challenge'].includes(mode))throw Error('收益配队仅支持普通与挑战；激奏需要团队结算档位');
 if(!['owned','selected','reference'].includes(scope)||!['badges','eventPoints','grade'].includes(goal))throw Error('Invalid event search options');
 if(!Number.isInteger(budget)||budget<1||budget>10000||!Number.isInteger(startingCP)||startingCP<0||startingCP>1000000)throw Error('Invalid farming budget');
 if(candidateCache){
   const {LiveMusicScore,...preparationTables}=rules.tables;
   const context=await searchDigest({...rules,tables:preparationTables});
   if(candidateCache.get('$preparation-rules')!==context){candidateCache.clear();candidateCache.set('$preparation-rules',context);scoreCache?.clear();}
 }
 ({draft,scope,inventory}=withEventRewardCandidates({rules,draft,scope,inventory,rewardCards,rewardGrowth,rewardGrowthOverride}));
 if(mode==='ordinary'&&(!Number.isInteger(liveBoost)||liveBoost<1||liveBoost>10||budget<liveBoost))throw Error('普通收益配队需消耗至少 1 火，预算不少于单次耗火');
 const model=createEventEfficiency({tables:rules.tables,sourceReleaseId:rules.sourceReleaseId,eventId});
 model.challengeCosts=rules.tables.ChallengeMusicBoostBonus.map(r=>r._consumedChallengePointCount);
 let next=structuredClone(draft);next.selectedSongId=candidate.trackId;next.selectedDifficulty=candidate.difficulty;next.modifiers??={};delete next.modifiers.event;
 if(mode==='challenge')next.modifiers.event={id:eventId,sourceReleaseId:rules.sourceReleaseId};
 if(scope==='owned'){
   if(!inventory)throw Error('请先导入已保存卡库与实际养成');
   // Owned searches use the current collection. A saved result's growth is a
   // snapshot, not an explicit override of actual card levels or ranks.
   next.modifiers.growth=structuredClone(inventory.growth??{});
 }
 // Resolve the filtered domain before scoring bonuses, including maximum reference growth.
 const resolved=resolveSearchInput(rules,next,{scope,inventory,constraints});
 next=resolved.draft;
 const metric=goal==='eventPoints'?'eventPoints':'badges',bonusCache=new Map();
 const cardBonus=(kind,id)=>{
   if(!bonusCache.has(id))bonusCache.set(id,model.cardBonus(kind,Number(id.split('-').at(-1)),next.modifiers.growth?.[id]?.rank??1));
   return bonusCache.get(id);
 };
 const feature=(kind,pair)=>['member','support'].reduce((n,k)=>{const b=cardBonus(k,pair[`${k}CardId`]);return n+(kind==='both'?b.rewardBP+b.eventPointBP:kind==='items'?b.rewardBP:b.eventPointBP);},0)/10000;
 const extraProfiles=['items','points','both'].map(kind=>({id:'bonus-'+kind,label:'奖励加成 '+kind,powerWeight:.01,featureWeight:1,feature:(_,pair)=>feature(kind,pair)}));
 extraProfiles.push(...['items','points'].map(kind=>({id:'mixed-'+kind,label:'能力与奖励 '+kind,feature:(_,pair)=>feature(kind,pair)})));
 const planners=new Map(),continuations=new Map(),modelCache={};
 const continuationKey=challengePlanCache?JSON.stringify({costs:model.challengeCosts,rows:challengeRows,
   rewards:[rules.tables.Event,rules.tables.ChallengeLiveEventPoint,rules.tables.ChallengeLiveEventReward,rules.tables.ChallengeMusicBoostBonus]}):null;
 const continuationFor=(cp,objective)=>{
   const resultKey=objective+':'+cp;
   if(continuations.has(resultKey))return continuations.get(resultKey);
   if(!planners.has(objective)){
     const key=`${rules.sourceReleaseId}:${eventId}:${objective}`,cached=challengePlanCache?.get(key);
     const planner=cached?.input===continuationKey?cached.planner:createChallengeContinuationPlanner(model,challengeRows,objective);
     planners.set(objective,planner);challengePlanCache?.set(key,{input:continuationKey,planner});
   }
   const result=planners.get(objective)(cp);continuations.set(resultKey,result);return result;
 };
 const transformScore=createEventYieldRewardTransform({model,candidate,basis,mode,liveBoost,challengeCost,budget,startingCP,includeChallenge,metric,continuationFor});
 const eventAdapters=mode==='challenge'?[model.challengeAdapter(rules)]:[];
 // Also deduplicate witnesses and fallback scoring when the caller does not
 // need to retain a cache after this calculation.
 scoreCache??=new Map();
 await bindEventScoreCache(scoreCache,{rules,chart,draft:next});
 const rewardBounds=new Map();
 const upperCandidate=({scoreUpper,tieScoreUpper,rewardBP,eventPointBP})=>{
   const rank=model.scoreRank(Number(candidate.trackId.split('-').at(-1)),scoreUpper===Infinity?Number.MAX_VALUE:scoreUpper);
   const key=`${rank}:${rewardBP}:${eventPointBP}`;
   if(rewardBounds.has(key))return {...rewardBounds.get(key),expectedScore:tieScoreUpper};
   const total={badges:0,eventPoints:0};
   const plays=mode==='ordinary'?Math.floor(budget/liveBoost):1;
   // Separate currency maxima also cover non-monotone reward tables and the
   // secondary tie-break of a primary-optimal continuation at a smaller budget.
   for(let scoreRank=2;scoreRank<=rank;scoreRank++){
     const reward=model.rewards({mode,scoreRank,rewardBP,eventPointBP,liveBoost:mode==='ordinary'?liveBoost:0,challengeCost});
     const cp=startingCP+plays*reward.challengePoints;
     for(const currency of ['badges','eventPoints'])total[currency]=Math.max(total[currency],plays*reward[currency]
       +(mode==='ordinary'&&includeChallenge?continuationFor(cp,currency)[currency]:0));
   }
   const bound={value:total[metric],total,reward:{scoreRank:rank},song:candidate};
   // A job can visit many partition-specific sums. Bound memory independently
   // of the search frontier; eviction changes work only, never the objective.
   if(rewardBounds.size>=8192)rewardBounds.delete(rewardBounds.keys().next().value);
   rewardBounds.set(key,bound);return {...bound,expectedScore:tieScoreUpper};
 };
 const pairBonus=edge=>{
     const a=cardBonus('member',edge.member),b=cardBonus('support',edge.support);
     return {rewardBP:a.rewardBP+b.rewardBP,eventPointBP:a.eventPointBP+b.eventPointBP};
 };
 // Expected score remains the display tie-break. It is an optional additional
 // optimization objective, independent of proving the selected farming yield.
 const compare=(a,b)=>refineScoreTies?compareEventPlans(a,b,goal):
   compareEventPlans({...a,expectedScore:0},{...b,expectedScore:0},goal);
 let result,exact,bonusCeiling,witnessReport;
 if(searchMethod==='certified'&&!refineScoreTies&&!next.modifiers.performanceScenario){
   const input=resolved;
   const witnessKey=candidateCache?eventCandidateKey(rules,next,inventory,scope,eventAdapters,true,constraints)+':ceiling-witness-event='+eventId:null;
   let prepared=witnessKey?candidateCache.get(witnessKey):null;
   witnessReport={attempted:true,candidateCacheHit:Boolean(prepared),fullScoreCalculations:0,scoreCacheHits:0,success:false};
   if(prepared){
     // A cached team is only a proposal. Recompute the proof ceiling from the
     // current rules even when release metadata is unchanged (e.g. a caller
     // supplies a corrected EventEffect table in a new rules object).
     const characters=new Map(rules.tables.MemberCard.map(row=>[`member-card-${row._id}`,row._characterID]));
     const edges=input.inventory.memberCardIds.flatMap(member=>input.inventory.supportCardIds.map(support=>
       ({key:`${member}|${support}`,member,support,character:characters.get(member),...pairBonus({member,support})})));
     const maximum=kind=>maximumPairing({edges:edges.map(edge=>({...edge,weight:edge[kind]}))});
     const rewards=maximum('rewardBP'),points=maximum('eventPointBP');
     prepared={...prepared,bonusCeiling:rewards&&points?{rewardBP:rewards.weight,eventPointBP:points.weight}:null};
   }
   if(!prepared){
     const characters=new Map(rules.tables.MemberCard.map(row=>[`member-card-${row._id}`,row._characterID]));
     const edges=input.inventory.memberCardIds.flatMap(member=>input.inventory.supportCardIds.map(support=>
       ({key:`${member}|${support}`,member,support,character:characters.get(member),...pairBonus({member,support})})));
     const maximum=kind=>maximumPairing({edges:edges.map(edge=>({...edge,weight:edge[kind]}))});
     const rewards=maximum('rewardBP'),points=maximum('eventPointBP');
     if(rewards&&points){
       const ceiling={rewardBP:rewards.weight,eventPointBP:points.weight};
       let models;
       try { models=await compilePairingModels(rules,input,{eventAdapters,signal,yieldControl,modelCache,pairCache:candidateCache,
         pairCacheKey:candidateCache?'power:'+eventCandidateKey(rules,next,inventory,scope,eventAdapters,false,constraints):null}); }
       catch (error) { witnessReport.unsupported=skillMechanismIssue(error); models=[]; }
       // A failed witness proves nothing. The practical fallback reports the
       // precise unsupported leaders and retains fully supported teams.
       let best;
       // Bonus is integer. Ten times the largest absolute edge power exceeds
       // every possible five-edge power difference; the matching therefore
       // keeps sum-bonus exact and uses actual power only among its ties.
       const maxPower=Math.max(0,...(models??[]).map(m=>Math.max(...m.edges.map(e=>Math.abs(e.weight))))),scale=10*maxPower+1;
       for(const model of models??[]){
         const weight=e=>{const b=pairBonus(e);return (b.rewardBP+b.eventPointBP)*scale+e.weight;};
         const largest=Math.max(...model.edges.map(e=>Math.abs(weight(e))));
         // maximumPairing's own mandatory-vertex reward must also stay exact.
         if(!Number.isSafeInteger((10*largest+1)*11))continue;
           const matching=maximumPairing({edges:model.edges,required:input.constraints.lockedPairs.map(p=>`${p.memberCardId}|${p.supportCardId}`),
             requiredMembers:[model.leader,...input.constraints.requiredMemberIds],requiredSupports:input.constraints.requiredSupportIds,weight});
         if(matching&&(!best||matching.weight>best.matching.weight))best={model,matching};
         onProgress?.({phase:'event-witness',stage:'尝试全局收益上界见证',completed:(models??[]).indexOf(model)+1,total:models.length});
         await yieldControl();if(signal?.aborted)break;
       }
       prepared={bonusCeiling:ceiling,slots:best?draftFromPairing(input,best.model.leader,best.matching.edges).slots:null};
       if(witnessKey&&!signal?.aborted)candidateCache.set(witnessKey,prepared);
     }
   }
   bonusCeiling=prepared?.bonusCeiling;
   if(prepared?.slots&&bonusCeiling&&!signal?.aborted){
     const team={...structuredClone(input.draft),slots:structuredClone(prepared.slots)},id=team.slots.map(s=>`${s.memberCardId}|${s.supportCardId}`).join(';');
     const key='full:'+id;let raw=scoreCache?.get(key);
     try{
       if(raw)witnessReport.scoreCacheHits++;
       else {witnessReport.fullScoreCalculations++;raw=createCandidateEvaluator({rules,chart,objective:'expected_song_score',eventAdapters}).score(team);scoreCache?.set(key,raw);}
       const row={...transformScore(raw,team),draft:team,id,origins:['global-ceiling-witness'],delta:null,comparison:null};
       const ceiling=upperCandidate({scoreUpper:Number.MAX_VALUE,tieScoreUpper:Number.MAX_VALUE,...bonusCeiling});
       witnessReport.success=compare(ceiling,row)>=0;
       if(witnessOnly||witnessReport.success){
         result={results:[row],evaluated:1,baseline:null,baselineResult:null,warnings:input.assumptions,
           sourceReleaseId:rules.sourceReleaseId,ruleSetVersion:rules.ruleSetVersion,searchScope:scope,
           scoringCoverage:{complete:true,proof:'objective_ceiling_witness',unsupportedPairs:[],unsupportedCandidates:[]},
           practical:{plan:{finalOrders:120,finalists:1},directions:[{id:'global-ceiling-witness',label:'全局收益上界见证',status:'generated'}],stages:[],
             neighbourChecks:0,neighbourGenerated:0,screened:0,finalists:1,scoreCacheHits:witnessReport.scoreCacheHits,
             scoreCalculations:witnessReport.fullScoreCalculations,fullScoreCalculations:witnessReport.fullScoreCalculations,screenScoreCalculations:0,
             candidateCacheHit:witnessReport.candidateCacheHit,unsupportedPairs:[],unsupportedCandidates:[],ceilingWitness:witnessReport}};
         onProgress?.({phase:'practical-result',bestCandidate:row});
       }
     }catch(error){witnessReport.unsupported=skillMechanismIssue(error);}
   }
 }
 const globalCeiling=bonusCeiling?upperCandidate({scoreUpper:Number.MAX_VALUE,tieScoreUpper:Number.MAX_VALUE,...bonusCeiling}):null;
 const globalUpperCandidate=globalCeiling?{value:globalCeiling.value,total:globalCeiling.total,scoreRank:globalCeiling.reward.scoreRank}:null;
 if(witnessOnly&&!witnessReport?.success)return {...(result??{results:[],evaluated:0,warnings:[],practical:{scoreCalculations:witnessReport?.fullScoreCalculations??0,
   fullScoreCalculations:witnessReport?.fullScoreCalculations??0,screenScoreCalculations:0,scoreCacheHits:witnessReport?.scoreCacheHits??0}}),
   status:signal?.aborted?'cancelled':'witness_only',optimality:'incomplete',searchMethod:'certified',objective:'event_yield',mode,goal,basis,
   certifiedSearch:{searchStatus:signal?.aborted?'cancelled':'witness_only',bestProven:false,topNComplete:false,fullScoreCalculations:0,
     boundScoreCalculations:0,expanded:0,globalUpperCandidate,objective:'reward_tuple',scoreTieOptimality:'not_proven'}};
 result??=await optimizePractical({rules,draft:next,chart,scope,inventory,constraints,objective:'expected_song_score',performanceScenario:next.modifiers.performanceScenario,
   eventAdapters,extraProfiles,transformScore,candidateCache,scoreCache,modelCache,pairCache:candidateCache,
   pairCacheKey:candidateCache?'power:'+eventCandidateKey(rules,next,inventory,scope,eventAdapters,false,constraints):null,
   candidateCacheKey:candidateCache?eventCandidateKey(rules,next,inventory,scope,eventAdapters,true,constraints)+':reward-event='+eventId:null,
   compareCandidates:(a,b)=>compareEventPlans(a,b,goal),finalistLimit:12,retainedOrigins:['bonus-items','bonus-points','bonus-both','mixed-items','mixed-points'],onProgress,yieldControl,signal});
 if(witnessReport&&!witnessReport.success){
   result.practical.ceilingWitness=witnessReport;
   result.practical.fullScoreCalculations+=witnessReport.fullScoreCalculations;
   result.practical.scoreCalculations+=witnessReport.fullScoreCalculations;
   result.practical.scoreCacheHits+=witnessReport.scoreCacheHits;
 }
 if(searchMethod==='practical'||signal?.aborted||result.scoringCoverage?.complete===false)return {...result,objective:'event_yield',mode,goal,basis};
 if(bonusCeiling&&result.results.length){
     const ceiling=upperCandidate({scoreUpper:Number.MAX_VALUE,tieScoreUpper:Number.MAX_VALUE,
       ...bonusCeiling});
     if(compare(ceiling,result.results[0])>=0)exact={results:result.results,evaluated:0,expanded:0,
       candidateBoundPruned:0,fullScoreCalculations:0,scoreCacheHits:0,boundScoreCalculations:0,
       optimality:'proven_within_model',searchStatus:'completed',upperBound:ceiling.value,optimalityGap:0,
       upperCandidate:{value:ceiling.value,total:ceiling.total,scoreRank:ceiling.reward.scoreRank},
       bestProven:true,proofTarget:'best',certifiedCount:1,topNComplete:false,frontier:0,proof:'global_grade_and_bonus_ceiling'};
 }
 let rootBoundCalculations=0;
 if(!exact&&maxEvaluations===0&&bonusCeiling&&!refineScoreTies&&!next.modifiers.performanceScenario&&result.results.length){
   const proof=await certifyRewardRoots({rules,draft:next,chart,scope,inventory,constraints,eventAdapters,basis,model,mode,goal,metric,budget,liveBoost,challengeCost,startingCP,
     includeChallenge,continuationFor,pairBonus,cardBonus,bonusCeiling,result,transformScore,compare,scoreCache,modelCache,candidateCache,
     pairCacheKey:candidateCache?'power:'+eventCandidateKey(rules,next,inventory,scope,eventAdapters,false,constraints):null,upperCandidate,partitionSearch:maxEvaluations===0,yieldControl,onProgress,signal});
   rootBoundCalculations=proof.boundScoreCalculations;
   result.practical.rewardRootCertificate=proof;
   if(proof.proven){const first=result.results[0];exact={results:result.results,evaluated:0,expanded:proof.expanded,candidateBoundPruned:proof.candidateBoundPruned,
     fullScoreCalculations:0,scoreCacheHits:0,boundScoreCalculations:0,optimality:'proven_within_model',searchStatus:'completed',
     upperBound:first.value,optimalityGap:0,upperCandidate:{value:first.value,total:first.total,scoreRank:first.reward.scoreRank},
     bestProven:true,proofTarget:'best',certifiedCount:1,topNComplete:false,frontier:0,proof:'grade_and_bonus_constrained_score_ceiling'};}
 }
 exact??=await searchEventFormations({rules,draft:next,chart,scope,inventory,constraints,eventAdapters,boundMetric:basis,
   seeds:result.results,bonusFor:{metric:metric==='badges'?'rewardBP':'eventPointBP',pair:pairBonus,card:cardBonus},
   upperCandidate,transformScore,compareCandidates:compare,rankCandidates:(a,b)=>compareEventPlans(a,b,goal),bonusCeiling,
   maxEvaluations,proofCount:1,includeTieScoreBound:refineScoreTies,signal,yieldControl,onProgress,scoreCache,scoreCounters:result.practical,baselineResult:result.baselineResult,
   modelCache,pairCache:candidateCache,pairCacheKey:candidateCache?'power:'+eventCandidateKey(rules,next,inventory,scope,eventAdapters,false,constraints):null});
 exact.boundScoreCalculations=(exact.boundScoreCalculations??0)+rootBoundCalculations;
 const {results:exactResults,...certificate}=exact;
 exactResults.sort((a,b)=>compareEventPlans(a,b,goal));
 return {...result,results:exactResults,evaluated:result.evaluated+exact.evaluated,optimality:exact.optimality,
   warnings:exact.searchStatus==='player_scenario_bound_unavailable'?result.warnings:
     [...result.warnings.filter(w=>!PRACTICAL_SEARCH_WARNINGS.includes(w)),
       refineScoreTies?'精确阶段同时优化收益和同收益期望分；收益差距为 0 也可能尚未证明期望分排序最优。':
         '精确阶段优化所选收益及次级收益，只有搜索完成时才证明最优；同收益队伍按已算出的期望分排序，不保证其期望分全局最优。',
       '后续挑战以提供的候选方案为范围。'],
   searchMethod:exact.searchStatus==='player_scenario_bound_unavailable'?'practical':'certified',
   certifiedSearch:{...certificate,globalUpperCandidate,scope:includeChallenge&&mode==='ordinary'?'team_for_chart_given_challenge_rows':'team_for_chart',
     objective:refineScoreTies?'reward_tuple_and_expected_score':'reward_tuple',
     alternativesOptimality:'not_proven',
     scoreTieOptimality:refineScoreTies?exact.optimality:'not_proven'},
   status:exact.searchStatus==='player_scenario_bound_unavailable'?result.status:exact.searchStatus,
   objective:'event_yield',mode,goal,basis};
}

/** Exclude every strictly better reward tuple at every grade in every leader
 * root. Minimum bonus requirements are necessary conditions, not a narrowed
 * library. Failure to certify always leaves the exhaustive search available. */
async function certifyRewardRoots({rules,draft,chart,scope,inventory,constraints,eventAdapters,basis,model,mode,goal,metric,budget,liveBoost,challengeCost,startingCP,
 includeChallenge,continuationFor,pairBonus,cardBonus,bonusCeiling,result,transformScore,compare,scoreCache,modelCache,candidateCache,pairCacheKey,upperCandidate,partitionSearch,yieldControl,onProgress,signal}){
 const report={proven:false,leaders:0,expanded:0,cardPartitions:0,prunedPartitions:0,candidateBoundPruned:0,matchingCalls:0,boundScoreCalculations:0,witnessFullScoreCalculations:0,partitionFullScoreCalculations:0,witnessScoreCacheHits:0};
 const input=resolveSearchInput(rules,draft,{scope,inventory,constraints});
 const models=await compilePairingModels(rules,input,{eventAdapters,modelCache,pairCache:candidateCache,pairCacheKey,signal,yieldControl});
 if(!models||signal?.aborted)return report;
 const pairSkills=new Map(),resolver=createFormalSkillResolver(rules);
 for(const memberCardId of input.inventory.memberCardIds)for(const supportCardId of input.inventory.supportCardIds)
   pairSkills.set(`${memberCardId}|${supportCardId}`,resolver({slots:[{memberCardId,supportCardId}],modifiers:input.draft.modifiers})[0]);
 const song=createFormalSongCalculator(rules,chart,{eventAdapters});
 const bound=createOrdinaryScoreBound({song,pairSkills,legacyFactor:Infinity,input,metric:basis,bonusConstraintBound:true});
 const evaluator=createCandidateEvaluator({rules,chart,objective:'expected_song_score',eventAdapters},{song});
 const music=rules.tables.LiveMusic.find(r=>`music-${r._id}`===draft.selectedSongId);
 const grades=rules.tables.LiveScoreRank.filter(r=>r._group===music._liveScoreRankGroup).sort((a,b)=>b._liveScoreRank-a._liveScoreRank);
 const primary=metric==='badges'?'rewardBP':'eventPointBP',secondary=primary==='rewardBP'?'eventPointBP':'rewardBP';
 const other=metric==='badges'?'eventPoints':'badges',plays=mode==='ordinary'?Math.floor(budget/liveBoost):1;
 const totalAt=(rank,kind,bp)=>{
   const reward=model.rewards({mode,scoreRank:rank,rewardBP:kind==='rewardBP'?bp:0,eventPointBP:kind==='eventPointBP'?bp:0,
     liveBoost:mode==='ordinary'?liveBoost:0,challengeCost});
   const currency=kind==='rewardBP'?'badges':'eventPoints';
   const continuation=mode==='ordinary'&&includeChallenge?continuationFor(startingCP+plays*reward.challengePoints,metric):null;
   return plays*reward[currency]+(continuation?.[currency]??0);
 };
 const minimumBonus=(rank,kind,target,attainable)=>{
   if(totalAt(rank,kind,bonusCeiling[kind])<target)return null;
   let lo=0,hi=bonusCeiling[kind];
   while(lo<hi){const mid=lo+Math.floor((hi-lo)/2);if(totalAt(rank,kind,mid)>=target)hi=mid;else lo=mid+1;}
   if(!attainable)return lo;
   // Reward floors can make several BP values equivalent. Round only AFTER
   // the exact reward inversion, to the next attainable integer card sum.
   // Missing intermediate sums are a proved property of the full card pool.
   let left=0,right=attainable.length;
   while(left<right){const mid=(left+right)>>>1;if(attainable[mid]<lo)left=mid+1;else right=mid;}
   return attainable[left]??null;
 };
 const updateWitness=async(leader,matching,requirements,requiredScore=false)=>{
   if(!requiredScore&&report.witnessFullScoreCalculations>=12)return;
   const actual=matching.edges.reduce((sum,e)=>{const b=pairBonus(e);return {rewardBP:sum.rewardBP+b.rewardBP,eventPointBP:sum.eventPointBP+b.eventPointBP};},{rewardBP:0,eventPointBP:0});
   if(actual[primary]<requirements[0]||actual[secondary]<requirements[1])return;
   const team=draftFromPairing(input,leader,matching.edges),id=team.slots.map(s=>`${s.memberCardId}|${s.supportCardId}`).join(';'),key='full:'+id;
   let raw=scoreCache.get(key);
   if(raw){report.witnessScoreCacheHits++;result.practical.scoreCacheHits++;}
   else {report[requiredScore?'partitionFullScoreCalculations':'witnessFullScoreCalculations']++;result.practical.fullScoreCalculations++;result.practical.scoreCalculations++;
     raw=evaluator.score(team);scoreCache.set(key,raw);}
   const row={...transformScore(raw,team),draft:team,id,origins:['grade-bonus-bound-witness'],delta:null,comparison:null};
   if(compare(row,result.results[0])<0){
     result.results=[row,...result.results.filter(r=>r.id!==id)].sort((a,b)=>compareEventPlans(a,b,goal)).slice(0,3);result.evaluated++;
     onProgress?.({phase:'practical-result',bestCandidate:row});
   }
   await yieldControl();
 };
 const done=()=>{report.matchingCalls=bound.bonusConstraintStats.matchingCalls;report.boundScoreCalculations=bound.stats.fullScoreCalculations;return report;};
 const characterFor=new Map(rules.tables.MemberCard.map(r=>[`member-card-${r._id}`,r._characterID]));
 for(const modelRow of models){
   if(signal?.aborted)return done();
   const leader=modelRow.leader,c=input.constraints,states=[{leader,required:c.lockedPairs.map(p=>`${p.memberCardId}|${p.supportCardId}`),forbidden:[],
     memberRequired:[...new Set([leader,...c.requiredMemberIds,...c.lockedPairs.map(p=>p.memberCardId)])],
     supportRequired:[...new Set([...c.requiredSupportIds,...c.lockedPairs.map(p=>p.supportCardId)])],memberExcluded:[],supportExcluded:[]}];
   while(states.length){
   if(signal?.aborted)return done();
   const state=states.pop();
   const requiredCharacters=new Map(state.memberRequired.map(id=>[characterFor.get(id),id]));
   const nodeModel={...modelRow,edges:modelRow.edges.filter(e=>!state.memberExcluded.includes(e.member)&&!state.supportExcluded.includes(e.support)
     &&(!requiredCharacters.has(e.character)||requiredCharacters.get(e.character)===e.member)
     &&(state.memberRequired.length<5||state.memberRequired.includes(e.member))
     &&(state.supportRequired.length<5||state.supportRequired.includes(e.support)))};
   const power=maximumPairing({edges:nodeModel.edges,required:state.required,forbidden:state.forbidden,
     requiredMembers:state.memberRequired,requiredSupports:state.supportRequired});if(!power)continue;
   const attainable=Object.fromEntries([primary,secondary].map(kind=>[kind,attainableBonusSums(nodeModel.edges,state,kind,cardBonus)]));
   let unresolved=false;
   for(let gradeIndex=0;gradeIndex<grades.length;gradeIndex++){
     const grade=grades[gradeIndex];
     const rank=grade._liveScoreRank,first=result.results[0];
     if(goal==='grade'&&rank<first.reward.scoreRank)continue;
     const requirements=[];
     if(goal==='grade'&&rank>first.reward.scoreRank)requirements.push([0,0]);
     else {
       const higher=minimumBonus(rank,primary,first.total[metric]+1,attainable[primary]);if(higher!=null)requirements.push([higher,0]);
       const same=minimumBonus(rank,primary,first.total[metric],attainable[primary]),moreSecondary=minimumBonus(rank,secondary,first.total[other]+1,attainable[secondary]);
       if(same!=null&&moreSecondary!=null)requirements.push([same,moreSecondary]);
     }
     let retryGrade=false;
     for(const required of requirements){
       let excluded=false;
       for(const [a,b] of [[1,0],[0,1],[1,1],[bonusCeiling[secondary]+1,1],[1,bonusCeiling[primary]+1],[8,1],[1,8],[64,1],[1,64]]){
         if(!a&&!required[1]||!b&&!required[0])continue;
         const min=a*required[0]+b*required[1];if(!Number.isSafeInteger(min))continue;
         const forCard=(kind,id)=>{const bonus=cardBonus(kind,id);return a*bonus[primary]+b*bonus[secondary];};
         const constrained={...nodeModel,edges:constrainBonusCards(nodeModel.edges,state,forCard,min)};
         const constrainedPower=maximumPairing({edges:constrained.edges,required:state.required,forbidden:state.forbidden,
           requiredMembers:state.memberRequired,requiredSupports:state.supportRequired});
         if(!constrainedPower){excluded=true;break;}
         const upper=bound.withMinimumBonus(state,constrained,constrainedPower,()=>draftFromPairing(input,leader,constrainedPower.edges),edge=>{
           const bonus=pairBonus(edge);return a*bonus[primary]+b*bonus[secondary];
         },min,grade._requiredScore);
         const witnesses=bound.bonusConstraintWitnesses.filter(w=>w.bonus>=min).sort((x,y)=>y.weight-x.weight);
         if(witnesses[0])await updateWitness(leader,witnesses[0],required);
         if(upper<grade._requiredScore){excluded=true;break;}
         if(signal?.aborted)return done();
       }
       if(!excluded){
         // A newly scored legal witness may have raised the incumbent. The
         // old winning subspace need no longer be a strict improvement; redo
         // this grade against the stronger tuple. Earlier exclusions persist.
         if(compare(result.results[0],first)<0){retryGrade=true;break;}
         unresolved=true;break;
       }
     }
     if(unresolved)break;
     if(retryGrade)gradeIndex--;
   }
   if(unresolved){
     if(!partitionSearch)return done();
     // Rewards depend on the chosen cards, not their pairing. Split complete
     // card sets first, covering both inclusion and exclusion. Only after all
     // ten cards are fixed do we partition individual pairings. Bounds may
     // relax intermediate mandatory cards; that widens their domain safely.
     const kind=state.memberRequired.length<5?'member':state.supportRequired.length<5?'support':null;
     if(kind){
       const choices=[...new Set(nodeModel.edges.map(e=>e[kind]))].filter(id=>!state[kind+'Required'].includes(id));
       choices.sort((a,b)=>{
         const x=cardBonus(kind,a),y=cardBonus(kind,b);
         return y[secondary]-x[secondary]||y[primary]-x[primary]||a.localeCompare(b);
       });
       const id=choices[0];
       if(id){states.push({...state,[kind+'Excluded']:[...state[kind+'Excluded'],id]},
         {...state,[kind+'Required']:[...state[kind+'Required'],id]});report.cardPartitions++;report.expanded++;}
       onProgress?.({phase:'event-reward-exact',stage:'验证成员与留影集合',completed:report.expanded,frontier:states.length,bestCandidate:result.results[0]});
       await yieldControl();continue;
     }
     const fixed={...state,required:power.edges.map(e=>e.key)};
     const scoreUpper=bound(fixed,{...nodeModel,edges:power.edges},power,()=>draftFromPairing(input,leader,power.edges));
     const actual=power.edges.reduce((sum,e)=>{const b=pairBonus(e);return {rewardBP:sum.rewardBP+b.rewardBP,eventPointBP:sum.eventPointBP+b.eventPointBP};},{rewardBP:0,eventPointBP:0});
     const candidateUpper=upperCandidate({...actual,scoreUpper,tieScoreUpper:scoreUpper});
     // The representative is removed by Lawler partitioning, so either score
     // it completely or prove THIS team cannot improve before visiting every
     // disjoint child. A limit applies only to optional heuristic witnesses.
     if(compare(candidateUpper,result.results[0])<0)await updateWitness(leader,power,[0,0],true);
     else report.candidateBoundPruned++;
     states.push(...partitionPairing(state,power));report.expanded++;
   }else report.prunedPartitions++;
   onProgress?.({phase:'event-reward-exact',stage:'验证档位与奖励加成分区',completed:report.expanded,frontier:states.length,bestCandidate:result.results[0]});
   await yieldControl();
   }
   report.leaders++;
   onProgress?.({phase:'event-root-proof',stage:'验证档位与奖励加成联合上界',completed:report.leaders,total:models.length,bestCandidate:result.results[0]});
   await yieldControl();
 }
 report.proven=true;return done();
}

/** Exact possible additive bonuses with five distinct characters and five
 * distinct supports. Pair/forbidden-edge restrictions are relaxed, so this
 * set may contain extra sums but never loses a legal sum. A state-size cap
 * disables this tightening rather than narrowing the candidate library. */
export function attainableBonusSums(edges,state,kind,cardBonus){
 const members=new Map(),supports=new Map();
 for(const e of edges){
   if(!members.has(e.character))members.set(e.character,new Map());
   members.get(e.character).set(e.member,cardBonus('member',e.member)[kind]);
   supports.set(e.support,cardBonus('support',e.support)[kind]);
 }
 const groups=[...members.values()].map(rows=>({required:[...rows.keys()].some(id=>state.memberRequired.includes(id)),values:[...new Set(rows.values())]}));
 const supportGroups=[...supports].map(([id,value])=>({required:state.supportRequired.includes(id),values:[value]}));
 const sums=rows=>{
   let dp=Array.from({length:6},()=>new Set());dp[0].add(0);
   for(const group of rows){
     const next=group.required?Array.from({length:6},()=>new Set()):dp.map(values=>new Set(values));
     for(let n=0;n<5;n++)for(const old of dp[n])for(const value of group.values){
       next[n+1].add(old+value);if(next[n+1].size>20000)return null;
     }
     dp=next;
   }
   return dp[5];
 };
 const a=sums(groups),b=sums(supportGroups);if(!a||!b)return null;
 const combined=new Set();
 for(const x of a)for(const y of b){combined.add(x+y);if(combined.size>20000)return null;}
 return [...combined].sort((x,y)=>x-y);
}

/** Remove an edge from a conditional B>=T bound only when a team containing
 * that member or support cannot reach T even with independently best other
 * cards. This is a relaxation of that winning subspace, not a card prefilter
 * on the actual search. Mandatory cards and character capacities are kept. */
export function constrainBonusCards(edges,state,valueFor,min){
 const memberRows=new Map(),supportRows=new Map(),memberGroups=new Map();
 for(const edge of edges){
   if(!memberRows.has(edge.member)){
     const row={id:edge.member,group:edge.character,value:valueFor('member',edge.member)};memberRows.set(edge.member,row);
     memberGroups.set(row.group,Math.max(memberGroups.get(row.group)??-Infinity,row.value));
   }
   if(!supportRows.has(edge.support))supportRows.set(edge.support,{id:edge.support,group:edge.support,value:valueFor('support',edge.support)});
 }
 const supportGroups=new Map([...supportRows].map(([id,row])=>[id,row.value]));
 const prepare=(rows,groups,required)=>{
   const chosen=new Map();let total=0;
   const impossible={maximum:-Infinity,withCard:()=>-Infinity};
   for(const id of required){
     const row=rows.get(id);if(!row)return impossible;
     if(chosen.has(row.group)){if(chosen.get(row.group)!==id)return impossible;continue;}
     chosen.set(row.group,id);total+=row.value;
   }
   if(chosen.size>5)return impossible;
   const remaining=5-chosen.size,optional=[...groups].filter(([group])=>!chosen.has(group)).sort((a,b)=>b[1]-a[1]);
   if(optional.length<remaining)return impossible;
   const positions=new Map(optional.map(([group],index)=>[group,index])),prefix=[0];
   for(const [,value] of optional)prefix.push(prefix.at(-1)+value);
   const maximum=total+prefix[remaining];
   // Forcing one optional card only removes its group from the top-k sum.
   // Rank once for the domain instead of sorting again for every card.
   return {maximum,withCard:id=>{
     const row=rows.get(id);if(!row)return -Infinity;
     if(chosen.has(row.group))return chosen.get(row.group)===id?maximum:-Infinity;
     if(!remaining)return -Infinity;
     const count=remaining-1,index=positions.get(row.group);
     return total+row.value+(index<count?prefix[count+1]-optional[index][1]:prefix[count]);
   }};
 };
 const members=prepare(memberRows,memberGroups,state.memberRequired),supports=prepare(supportRows,supportGroups,state.supportRequired);
 const allowedMembers=new Set([...memberRows.keys()].filter(id=>members.withCard(id)+supports.maximum>=min));
 const allowedSupports=new Set([...supportRows.keys()].filter(id=>supports.withCard(id)+members.maximum>=min));
 return edges.filter(edge=>allowedMembers.has(edge.member)&&allowedSupports.has(edge.support));
}
